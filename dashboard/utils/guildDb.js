/**
 * Per-guild database helper — write-through cache backed by MongoDB.
 *
 * Every guild gets its own folder for JSON fallback:
 *   dashboard/database/<guildId>/
 *
 * On startup call loadFromMongoDB() to warm the in-memory cache.
 * Every write() persists to: in-memory cache → JSON file → MongoDB (async).
 * Every read()  returns from: in-memory cache → JSON file → defaultValue.
 *
 * Usage:
 *   const guildDb = require('./utils/guildDb');
 *   await guildDb.loadFromMongoDB();          // once at startup
 *   const data = guildDb.read('id', 'settings');
 *   guildDb.write('id', 'settings', { ... });
 */

'use strict';

const fs   = require('fs');
const logger = require('../../utils/logger');
const path = require('path');

// Keyv-powered async cache (TTL, stats, rate limiting, getOrFetch)
const cache      = require('./cache');
const validators = require('../../utils/validators');

const DB_ROOT = path.join(__dirname, '../database');

// ── L0 In-memory Map  Map<guildId, Map<filename, { data, exp }>> ─────────────
// Synchronous hot-path (zero I/O). Entries carry an expiry timestamp so that
// stale data is detected and re-fetched from the Keyv L1 / MongoDB on next
// readAsync() call. The synchronous read() always returns the cached value even
// if expired — callers that need freshness should use readAsync().
const _cache = new Map();

function _ttlMs(filename) {
    return cache.TTL_MS[filename] ?? cache.TTL_MS._default;
}

function _cacheGet(guildId, filename) {
    return _cache.get(guildId)?.get(filename)?.data;
}

function _cacheHas(guildId, filename) {
    const entry = _cache.get(guildId)?.get(filename);
    if (!entry) return false;
    // Expired — evict from L0 so next readAsync() re-fetches from L1/MongoDB
    if (Date.now() > entry.exp) {
        _cache.get(guildId).delete(filename);
        return false;
    }
    return true;
}

function _cacheSet(guildId, filename, data) {
    if (!_cache.has(guildId)) _cache.set(guildId, new Map());
    _cache.get(guildId).set(filename, { data, exp: Date.now() + _ttlMs(filename) });
}

// ── FS helpers ───────────────────────────────────────────────────────────────
function ensureDir(guildId) {
    const dir = path.join(DB_ROOT, guildId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// ── MongoDB write router ─────────────────────────────────────────────────────
// filename keys that map 1:1 to a Guild document field (dot-notation OK)
const GUILD_FIELD_MAP = {
    settings:           'settings',
    protection:         'protection',
    system:             'system',
    auto_responder:     'autoResponder',
    auto_role:          'autoRoles',
    auto_roles:         'autoRoles',
    ticket_stats:       'stats.ticketStats',
    staff_points:       'staffPointsConfig',
    interaction_points: 'interactionPointsConfig',
    suggestions_config: 'suggestionsConfig',
};

const _TRANSIENT_ERR = /ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|MongoNetworkError|MongoNotConnectedError/i;

async function _writeToMongo(guildId, filename, data) {
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
        const mongoose = require('mongoose');
        if (mongoose.connection.readyState < 1) return;
        const schemas = require('../../systems/schemas');

        // ── Guild document fields ─────────────────────────────────────────
        if (GUILD_FIELD_MAP[filename]) {
            await schemas.Guild.findOneAndUpdate(
                { guildId },
                { $set: { guildId, [GUILD_FIELD_MAP[filename]]: data } },
                { upsert: true }
            );
            return;
        }

        // tickets.json → ticketGeneral + ticketPanels
        if (filename === 'tickets') {
            const { panels, ...general } = data || {};
            await schemas.Guild.findOneAndUpdate(
                { guildId },
                { $set: { guildId, ticketGeneral: general, ticketPanels: panels || [] } },
                { upsert: true }
            );
            return;
        }

        // commands.json → settings.commandsConfig (avoid overwriting whole settings)
        if (filename === 'commands') {
            await schemas.Guild.findOneAndUpdate(
                { guildId },
                { $set: { guildId, 'settings.commandsConfig': data } },
                { upsert: true }
            );
            return;
        }

        // ── Separate collections ──────────────────────────────────────────
        if (filename === 'staff_scores') {
            const ops = Object.entries(data || {}).map(([staffId, d]) => ({
                updateOne: {
                    filter: { guildId, staffId },
                    update: { $set: { guildId, staffId, points: d.points ?? 0, history: d.history ?? [], lastActions: d.lastActions ?? {} } },
                    upsert: true,
                },
            }));
            if (ops.length) await schemas.StaffScore.bulkWrite(ops, { ordered: false });
            return;
        }

        if (filename === 'interaction_scores') {
            const ops = Object.entries(data || {}).map(([userId, d]) => ({
                updateOne: {
                    filter: { guildId, userId },
                    update: { $set: { guildId, userId, points: d.points ?? 0, history: d.history ?? [], lastActions: d.lastActions ?? {} } },
                    upsert: true,
                },
            }));
            if (ops.length) await schemas.InteractionScore.bulkWrite(ops, { ordered: false });
            return;
        }

        if (filename === 'levels') {
            const ops = Object.entries(data || {}).map(([userId, d]) => ({
                updateOne: {
                    filter: { guildId, userId },
                    update: {
                        $set: {
                            guildId, userId,
                            textXP:        d.textXP        ?? 0,
                            textMessages:  d.textMessages  ?? 0,
                            textLevel:     d.textLevel     ?? 0,
                            voiceXP:       d.voiceXP       ?? 0,
                            voiceMinutes:  d.voiceMinutes  ?? 0,
                            voiceLevel:    d.voiceLevel    ?? 0,
                            lastTextTime:  d.lastTextTime  ?? 0,
                            voiceJoinedAt: d.voiceJoinedAt ? new Date(d.voiceJoinedAt) : null,
                        },
                    },
                    upsert: true,
                },
            }));
            if (ops.length) await schemas.MemberLevel.bulkWrite(ops, { ordered: false });
            return;
        }

        if (filename === 'open_tickets') {
            const tickets = data?.tickets ?? (Array.isArray(data) ? data : []);
            const ops = tickets.map(t => ({
                updateOne: {
                    filter: { ticketId: t.id || t.ticketId },
                    update: {
                        $set: {
                            ticketId:    t.id || t.ticketId,
                            guildId:     t.guildId || guildId,
                            userId:      t.userId,
                            channelId:   t.channelId   || null,
                            panelId:     t.panelId     || null,
                            status:      t.status      || 'open',
                            claimedBy:   t.claimedBy   || null,
                            claimedAt:   t.claimedAt   ? new Date(t.claimedAt) : null,
                            closedAt:    t.closedAt    ? new Date(t.closedAt)  : null,
                            closedBy:    t.closedBy    || null,
                            formAnswers: t.formAnswers || {},
                            rating:      t.rating      || null,
                            number:      t.number      ?? null,
                            closeReason: t.closeReason || null,
                        },
                        // Preserve the original openedAt on first insert; never overwrite on updates
                        $setOnInsert: {
                            createdAt: t.openedAt ? new Date(t.openedAt) : new Date(),
                        },
                    },
                    upsert: true,
                },
            }));
            if (ops.length) await schemas.Ticket.bulkWrite(ops, { ordered: false });
            return;
        }

        if (filename === 'ticket_feedback') {
            const entries = data?.entries ?? (Array.isArray(data) ? data : []);
            const ops = entries.filter(e => e?.ticketId && e?.userId).map(e => ({
                updateOne: {
                    filter: { ticketId: e.ticketId, userId: e.userId },
                    update: { $set: { ticketId: e.ticketId, userId: e.userId, guildId, rating: e.rating, comment: e.comment || '' } },
                    upsert: true,
                },
            }));
            if (ops.length) await schemas.TicketFeedback.bulkWrite(ops, { ordered: false });
            return;
        }

        // ── ticket_cooldowns ─────────────────────────────────────────
        if (filename === 'ticket_cooldowns') {
            await schemas.Guild.findOneAndUpdate(
                { guildId },
                { $set: { guildId, ticketCooldowns: data } },
                { upsert: true }
            );
            return;
        }

        // ── suggestions_data ─────────────────────────────────────────────
        if (filename === 'suggestions_data') {
            await schemas.Guild.findOneAndUpdate(
                { guildId },
                { $set: { guildId, suggestionsData: data } },
                { upsert: true }
            );
            return;
        }

        // ── activity (hourly counters per guild) ──────────────────────────
        if (filename === 'activity') {
            await schemas.Guild.findOneAndUpdate(
                { guildId },
                { $set: { guildId, activityStats: data } },
                { upsert: true }
            );
            return;
        }

        // ── welcome_join ─────────────────────────────────────────────────
        if (filename === 'welcome_join') {
            const { _id, __v, createdAt, updatedAt, guildId: _gid, ...fields } = data || {};
            await schemas.WelcomeJoin.findOneAndUpdate(
                { guildId },
                { $set: { guildId, ...fields } },
                { upsert: true }
            );
            return;
        }

        return; // no MongoDB mapping for this filename
    } catch (e) {
        if (attempt < MAX_RETRIES && _TRANSIENT_ERR.test(e.message)) {
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            continue;
        }
        logger.error(`[guildDb] MongoDB write error (${guildId}/${filename}):`, e.message);
        return;
    }
    } // end retry loop
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Synchronous read — hot-path (zero I/O).
 *
 * Priority: L0 Map (TTL-checked) → JSON fallback → defaultValue.
 * Use readAsync() when you need guaranteed-fresh data from MongoDB.
 */
function read(guildId, filename = 'settings', defaultValue = {}) {
    if (_cacheHas(guildId, filename)) return _cacheGet(guildId, filename);

    const dir  = ensureDir(guildId);
    const file = path.join(dir, `${filename}.json`);
    if (!fs.existsSync(file)) return defaultValue;
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        _cacheSet(guildId, filename, data);
        return data;
    } catch {
        return defaultValue;
    }
}

/**
 * Async cache-first read — the professional cache pattern.
 *
 * Priority: L0 Map → L1 Keyv (TTL-aware) → MongoDB → JSON → defaultValue.
 * Results from MongoDB are automatically stored in both L0 and L1 for future
 * reads, so only the very first access after expiry ever hits the database.
 *
 * @param {string} guildId
 * @param {string} filename
 * @param {*}      defaultValue
 * @returns {Promise<*>}
 *
 * @example
 * const settings = await guildDb.readAsync(guildId, 'settings', {});
 */
async function readAsync(guildId, filename = 'settings', defaultValue = {}) {
    // ── L0: in-memory Map (fastest, sync) ────────────────────────────────
    if (_cacheHas(guildId, filename)) return _cacheGet(guildId, filename);

    // ── L1: Keyv (TTL-tracked async cache) ───────────────────────────────
    const keyvData = await cache.get(guildId, filename);
    if (keyvData !== null) {
        _cacheSet(guildId, filename, keyvData); // repopulate L0
        return keyvData;
    }

    // ── L2: MongoDB ───────────────────────────────────────────────────────
    const mongoData = await _fetchFromMongo(guildId, filename);
    if (mongoData !== null && mongoData !== undefined) {
        _cacheSet(guildId, filename, mongoData);              // L0
        cache.set(guildId, filename, mongoData).catch(() => {}); // L1 async
        return mongoData;
    }

    // ── L3: JSON fallback ─────────────────────────────────────────────────
    const dir  = ensureDir(guildId);
    const file = path.join(dir, `${filename}.json`);
    if (fs.existsSync(file)) {
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            _cacheSet(guildId, filename, data);
            cache.set(guildId, filename, data).catch(() => {});
            // Auto-migrate: push JSON data into MongoDB now that we found it
            _writeToMongo(guildId, filename, data).catch(() => {});
            return data;
        } catch { /* fall through */ }
    }

    return defaultValue;
}

/**
 * Fetch one filename from MongoDB without touching the cache.
 * Internal helper for readAsync().
 * Returns null when there is no mapping or the record does not exist.
 */
async function _fetchFromMongo(guildId, filename) {
    try {
        const mongoose = require('mongoose');
        if (mongoose.connection.readyState < 1) return null;
        const schemas = require('../../systems/schemas');

        const GUILD_FIELD_MAP = {
            settings:           'settings',
            protection:         'protection',
            system:             'system',
            auto_responder:     'autoResponder',
            auto_role:          'autoRoles',
            auto_roles:         'autoRoles',
            ticket_stats:       'stats.ticketStats',
            staff_points:       'staffPointsConfig',
            interaction_points: 'interactionPointsConfig',
            suggestions_config: 'suggestionsConfig',
            ticket_cooldowns:   'ticketCooldowns',
            suggestions_data:   'suggestionsData',
            activity:           'activityStats',
        };

        if (GUILD_FIELD_MAP[filename]) {
            const field = GUILD_FIELD_MAP[filename];
            const doc = await schemas.Guild.findOne({ guildId }).select(field).lean();
            if (!doc) return null;
            // Navigate dot-notation path
            return field.split('.').reduce((o, k) => o?.[k], doc) ?? null;
        }

        if (filename === 'tickets') {
            const doc = await schemas.Guild.findOne({ guildId })
                .select('ticketGeneral ticketPanels').lean();
            if (!doc) return null;
            return { ...(doc.ticketGeneral || {}), panels: doc.ticketPanels || [] };
        }

        if (filename === 'levels') {
            const docs = await schemas.MemberLevel.find({ guildId }).lean();
            if (!docs.length) return null;
            const map = {};
            for (const l of docs) map[l.userId] = {
                textXP:       l.textXP,       textMessages: l.textMessages,
                textLevel:    l.textLevel,    voiceXP:      l.voiceXP,
                voiceMinutes: l.voiceMinutes, voiceLevel:   l.voiceLevel,
                lastTextTime: l.lastTextTime, voiceJoinedAt: l.voiceJoinedAt,
            };
            return map;
        }

        if (filename === 'staff_scores') {
            const docs = await schemas.StaffScore.find({ guildId }).lean();
            if (!docs.length) return null;
            const map = {};
            for (const s of docs)
                map[s.staffId] = { points: s.points, history: s.history, lastActions: s.lastActions };
            return map;
        }

        if (filename === 'interaction_scores') {
            const docs = await schemas.InteractionScore.find({ guildId }).lean();
            if (!docs.length) return null;
            const map = {};
            for (const s of docs)
                map[s.userId] = { points: s.points, history: s.history, lastActions: s.lastActions };
            return map;
        }

        if (filename === 'open_tickets') {
            const docs = await schemas.Ticket.find({ guildId }).lean();
            if (!docs.length) return null;
            const tickets = docs.map(t => ({
                id: t.ticketId, guildId: t.guildId, userId: t.userId,
                channelId: t.channelId, panelId: t.panelId, status: t.status,
                claimedBy: t.claimedBy, claimedAt: t.claimedAt instanceof Date ? t.claimedAt.toISOString() : (t.claimedAt ?? null),
                openedAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : (t.createdAt ?? null),
                closedAt: t.closedAt instanceof Date ? t.closedAt.toISOString() : (t.closedAt ?? null), closedBy: t.closedBy,
                closeReason: t.closeReason,
                formAnswers: t.formAnswers, rating: t.rating, number: t.number,
            }));
            const nextNumber = tickets.reduce((m, t) => Math.max(m, t.number || 0), 0) + 1;
            return { tickets, nextNumber };
        }

        if (filename === 'ticket_feedback') {
            const docs = await schemas.TicketFeedback.find({ guildId }).lean();
            if (!docs.length) return null;
            return { entries: docs.map(f => ({
                ticketId: f.ticketId, userId: f.userId,
                rating: f.rating, comment: f.comment, submittedAt: f.createdAt,
            })) };
        }

        if (filename === 'welcome_join') {
            const doc = await schemas.WelcomeJoin.findOne({ guildId }).lean();
            if (!doc) return null;
            const { _id, __v, createdAt, updatedAt, guildId: _gid, ...rest } = doc;
            return rest;
        }

        if (filename === 'commands') {
            const doc = await schemas.Guild.findOne({ guildId }).select('settings').lean();
            return doc?.settings?.commandsConfig ?? null;
        }

        return null; // no MongoDB mapping for this filename
    } catch (e) {
        logger.error(`[guildDb] _fetchFromMongo error (${guildId}/${filename}):`, e.message);
        return null;
    }
}

/**
 * Write data for a guild.
 *
 * Sync:  updates L0 Map (with fresh TTL) + JSON file.
 * Async: updates L1 Keyv cache + persists to MongoDB (both fire-and-forget).
 */
function write(guildId, filename = 'settings', data = {}) {
    // Zod schema guard — warn on violation, never block the write
    const schema = validators.GUILD_WRITE_SCHEMAS[filename];
    if (schema) {
        const vw = schema.safeParse(data);
        if (!vw.success)
            logger.warn(`[guildDb] write validation (${guildId}/${filename}): ${validators.formatError(vw.error)}`);
    }

    // L0 — immediate sync update with fresh TTL
    _cacheSet(guildId, filename, data);

    // L1 Keyv + MongoDB — async, never blocks the event loop
    cache.set(guildId, filename, data).catch(e =>
        logger.error(`[guildDb] Keyv write failed (${guildId}/${filename}):`, e.message)
    );
    _writeToMongo(guildId, filename, data).catch(e =>
        logger.error(`[guildDb] Async MongoDB write failed (${guildId}/${filename}):`, e.message)
    );
}

/**
 * Warm the in-memory cache from MongoDB.
 * Call once at bot startup, after dbSchemas.connect().
 */
async function loadFromMongoDB() {
    try {
        const mongoose = require('mongoose');
        if (mongoose.connection.readyState < 1) return;
        const schemas = require('../../systems/schemas');

        // ── Guild documents ───────────────────────────────────────────────
        const guilds = await schemas.Guild.find({}).lean();
        for (const g of guilds) {
            const gid = g.guildId;
            if (!gid) continue;
            if (g.settings)                _cacheSet(gid, 'settings',           g.settings);
            if (g.protection)              _cacheSet(gid, 'protection',         g.protection);
            if (g.system)                  _cacheSet(gid, 'system',             g.system);
            if (g.autoResponder)           _cacheSet(gid, 'auto_responder',     g.autoResponder);
            if (g.autoRoles)               _cacheSet(gid, 'auto_role',          g.autoRoles);
            if (g.staffPointsConfig)       _cacheSet(gid, 'staff_points',       g.staffPointsConfig);
            if (g.interactionPointsConfig) _cacheSet(gid, 'interaction_points', g.interactionPointsConfig);
            if (g.suggestionsConfig)       _cacheSet(gid, 'suggestions_config', g.suggestionsConfig);
            if (g.stats?.ticketStats)      _cacheSet(gid, 'ticket_stats',       g.stats.ticketStats);
            if (g.ticketCooldowns)         _cacheSet(gid, 'ticket_cooldowns',    g.ticketCooldowns);
            if (g.suggestionsData)         _cacheSet(gid, 'suggestions_data',    g.suggestionsData);
            if (g.activityStats)           _cacheSet(gid, 'activity',            g.activityStats);
            if (g.settings?.commandsConfig) _cacheSet(gid, 'commands',           g.settings.commandsConfig);
            if (g.ticketGeneral || g.ticketPanels) {
                _cacheSet(gid, 'tickets', { ...(g.ticketGeneral || {}), panels: g.ticketPanels || [] });
            }
        }

        // ── StaffScore ────────────────────────────────────────────────────
        const staffScores = await schemas.StaffScore.find({}).lean();
        const ssMap = {};
        for (const s of staffScores) {
            if (!ssMap[s.guildId]) ssMap[s.guildId] = {};
            ssMap[s.guildId][s.staffId] = { points: s.points, history: s.history, lastActions: s.lastActions };
        }
        for (const [gid, data] of Object.entries(ssMap)) _cacheSet(gid, 'staff_scores', data);

        // ── InteractionScore ──────────────────────────────────────────────
        const iScores = await schemas.InteractionScore.find({}).lean();
        const isMap = {};
        for (const s of iScores) {
            if (!isMap[s.guildId]) isMap[s.guildId] = {};
            isMap[s.guildId][s.userId] = { points: s.points, history: s.history, lastActions: s.lastActions };
        }
        for (const [gid, data] of Object.entries(isMap)) _cacheSet(gid, 'interaction_scores', data);

        // ── MemberLevel ───────────────────────────────────────────────────
        const levels = await schemas.MemberLevel.find({}).lean();
        const lvlMap = {};
        for (const l of levels) {
            if (!lvlMap[l.guildId]) lvlMap[l.guildId] = {};
            lvlMap[l.guildId][l.userId] = {
                textXP:        l.textXP,
                textMessages:  l.textMessages,
                textLevel:     l.textLevel,
                voiceXP:       l.voiceXP,
                voiceMinutes:  l.voiceMinutes,
                voiceLevel:    l.voiceLevel,
                lastTextTime:  l.lastTextTime,
                voiceJoinedAt: l.voiceJoinedAt,
            };
        }
        for (const [gid, data] of Object.entries(lvlMap)) _cacheSet(gid, 'levels', data);

        // ── Tickets ───────────────────────────────────────────────────────
        const tickets = await schemas.Ticket.find({}).lean();
        const tMap = {};
        for (const t of tickets) {
            if (!tMap[t.guildId]) tMap[t.guildId] = { tickets: [], nextNumber: 1 };
            tMap[t.guildId].tickets.push({
                id:          t.ticketId,
                guildId:     t.guildId,
                userId:      t.userId,
                channelId:   t.channelId,
                panelId:     t.panelId,
                status:      t.status,
                claimedBy:   t.claimedBy,
                claimedAt:   t.claimedAt instanceof Date ? t.claimedAt.toISOString() : (t.claimedAt ?? null),
                openedAt:    t.createdAt instanceof Date ? t.createdAt.toISOString() : (t.createdAt ?? null),
                closedAt:    t.closedAt instanceof Date ? t.closedAt.toISOString() : (t.closedAt ?? null),
                closedBy:    t.closedBy,
                formAnswers: t.formAnswers,
                rating:      t.rating,
                number:      t.number,
            });
        }
        for (const [gid, data] of Object.entries(tMap)) {
            const maxNum = data.tickets.reduce((m, t) => Math.max(m, t.number || 0), 0);
            data.nextNumber = maxNum + 1;
            _cacheSet(gid, 'open_tickets', data);
        }

        // ── WelcomeJoin ───────────────────────────────────────────────────
        const wjDocs = await schemas.WelcomeJoin.find({}).lean();
        for (const wj of wjDocs) {
            const gid = wj.guildId;
            if (!gid) continue;
            const { _id, __v, createdAt, updatedAt, guildId: _gid, ...rest } = wj;
            _cacheSet(gid, 'welcome_join', rest);
        }

        // ── TicketFeedback ────────────────────────────────────────────────
        const fbItems = await schemas.TicketFeedback.find({}).lean();
        const fbMap = {};
        for (const f of fbItems) {
            if (!fbMap[f.guildId]) fbMap[f.guildId] = { entries: [] };
            fbMap[f.guildId].entries.push({
                ticketId:    f.ticketId,
                userId:      f.userId,
                rating:      f.rating,
                comment:     f.comment,
                submittedAt: f.createdAt,
            });
        }
        for (const [gid, data] of Object.entries(fbMap)) _cacheSet(gid, 'ticket_feedback', data);

        // ── Warm L1 Keyv cache from loaded L0 entries ─────────────────────
        // Fire-and-forget: populate Keyv so TTL expiry is tracked from startup.
        const warmPromises = [];
        for (const [gid, fileMap] of _cache) {
            for (const [fname, entry] of fileMap) {
                const remaining = entry.exp - Date.now();
                if (remaining > 0) {
                    warmPromises.push(cache.set(gid, fname, entry.data, remaining));
                }
            }
        }
        await Promise.allSettled(warmPromises);

        logger.info(`[guildDb] Cache warmed from MongoDB: ${guilds.length} guild(s) (L0+L1)`);
    } catch (e) {
        logger.error('[guildDb] loadFromMongoDB error:', e.message);
    }
}

/**
 * Check if a guild has any data (cache or folder).
 */
function exists(guildId) {
    if (_cacheHas(guildId, 'settings')) return true;
    return fs.existsSync(path.join(DB_ROOT, guildId));
}

/**
 * List all guild IDs that have data (cache + folders).
 */
function list() {
    const fromCache = [..._cache.keys()];
    let fromFs = [];
    if (fs.existsSync(DB_ROOT)) {
        fromFs = fs.readdirSync(DB_ROOT).filter(n =>
            fs.statSync(path.join(DB_ROOT, n)).isDirectory()
        );
    }
    return [...new Set([...fromCache, ...fromFs])];
}

module.exports = { read, readAsync, write, exists, ensureDir, list, loadFromMongoDB, cache };
