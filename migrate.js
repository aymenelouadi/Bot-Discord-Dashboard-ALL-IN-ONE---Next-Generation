/*
 * ════════════════════════════════════════════════════════════════════════════
 *  Next Generation — JSON → MongoDB Migration Script
 *  ─────────────────────────────────────────────────
 *  Reads every JSON database file in /database/ and /dashboard/database/ and
 *  upserts the data into the matching MongoDB collections.
 *
 *  ✅ Idempotent   — safe to run multiple times (all writes use upsert)
 *  ✅ Non-destructive — never deletes existing MongoDB documents
 *  ✅ Logged       — every step is printed; failures are caught per-record
 *  ✅ Dry-run mode — pass --dry-run to preview without writing to MongoDB
 *
 *  Usage:
 *    node migrate.js            # real migration
 *    node migrate.js --dry-run  # preview only
 * ════════════════════════════════════════════════════════════════════════════
 */

'use strict';

require('dotenv').config();
const fs      = require('fs');
const path    = require('path');
const mongoose = require('mongoose');

const DRY_RUN = process.argv.includes('--dry-run');

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg)  { console.log(`  ${msg}`); }
function ok(msg)   { console.log(`  ✅ ${msg}`); }
function skip(msg) { console.log(`  ⏭  ${msg}`); }
function warn(msg) { console.warn(`  ⚠️  ${msg}`); }
function err(msg)  { console.error(`  ❌ ${msg}`); }
function section(title) { console.log(`\n${'═'.repeat(60)}\n  ${title}\n${'═'.repeat(60)}`); }

/** Read a JSON file; returns null on failure. ENOENT is silently ignored. */
function readJson(filePath) {
    try {
        const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
        return JSON.parse(raw);
    } catch (e) {
        if (e.code !== 'ENOENT') warn(`Cannot read ${filePath}: ${e.message}`);
        return null;
    }
}

/** Upsert helper — skips write in dry-run mode */
async function upsert(Model, filter, update, label) {
    if (DRY_RUN) { skip(`[DRY] would upsert ${Model.modelName} ${label}`); return; }
    try {
        await Model.findOneAndUpdate(filter, { $set: update }, { upsert: true, new: true });
        ok(`Upserted ${Model.modelName} ${label}`);
    } catch (e) {
        err(`Failed to upsert ${Model.modelName} ${label}: ${e.message}`);
    }
}

/** Bulk upsert for large collections */
async function bulkUpsert(Model, ops, label) {
    if (!ops.length) { skip(`No ${label} records to migrate`); return; }
    if (DRY_RUN) { skip(`[DRY] would bulkWrite ${ops.length} ${label} records`); return; }
    try {
        const res = await Model.bulkWrite(ops, { ordered: false });
        ok(`${label}: ${res.upsertedCount} upserted, ${res.modifiedCount} modified (${ops.length} total)`);
    } catch (e) {
        err(`BulkWrite ${label} failed: ${e.message}`);
    }
}

// ── Connect to MongoDB ────────────────────────────────────────────────────────

async function connect() {
    const uri = process.env.MONGODB;
    if (!uri) { console.error('❌  MONGODB env variable is not set. Check your .env file.'); process.exit(1); }
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000 });
    console.log('✅ Connected to MongoDB Atlas');
}

// ── Load models ───────────────────────────────────────────────────────────────

function models() {
    const s = require('./systems/schemas');
    return {
        Guild:            s.Guild,
        AFK:              s.AFK,
        Warning:          s.Warning,
        Jail:             s.Jail,
        Mute:             s.Mute,
        TempRole:         s.TempRole,
        MemberLevel:      s.MemberLevel,
        Ticket:           s.Ticket,
        TicketFeedback:   s.TicketFeedback,
        Suggestion:       s.Suggestion,
        StaffScore:       s.StaffScore,
        InteractionScore: s.InteractionScore,
    };
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Global JSON files  (database/*.json)
// ════════════════════════════════════════════════════════════════════════════

async function migrateAFK(M) {
    section('1/9  AFK  (database/afk.json)');
    const data = readJson(path.join(__dirname, 'database', 'afk.json'));
    if (!data || !Object.keys(data).length) { skip('Empty — nothing to migrate'); return; }
    const ops = Object.entries(data).map(([userId, d]) => ({
        updateOne: {
            filter: { userId },
            update: { $set: { userId, reason: d.reason || 'AFK', guildId: d.guildId || null, timestamp: d.timestamp ? new Date(d.timestamp) : new Date() } },
            upsert: true,
        },
    }));
    await bulkUpsert(M.AFK, ops, 'AFK');
}

async function migrateWarnings(M) {
    section('2/9  Warnings  (database/warn.json + warning.json)');

    // warn.json — keyed by userId, holds cases array
    const warnData = readJson(path.join(__dirname, 'database', 'warn.json')) || {};
    // warning.json — old format keyed by userId, used as fallback
    const warningData = readJson(path.join(__dirname, 'database', 'warning.json')) || {};

    const merged = { ...warningData, ...warnData }; // warn.json wins on conflict

    if (!Object.keys(merged).length) { skip('Empty — nothing to migrate'); return; }

    const ops = [];
    for (const [userId, d] of Object.entries(merged)) {
        const cases = (d.cases || []).map((c, i) => ({
            caseId:      c.caseId      || c.id || `LEGACY_${userId}_${i}`,
            reason:      (c.reason     || 'No reason').substring(0, 1000),
            moderatorId: c.moderatorId || c.moderator || '0',
            createdAt:   c.createdAt   || c.timestamp ? new Date(c.createdAt || c.timestamp) : new Date(),
        }));
        ops.push({
            updateOne: {
                filter: { guildId: d.guildId || '_legacy', userId },
                update: { $set: {
                    guildId:    d.guildId || '_legacy',
                    userId,
                    username:   d.username || d.tag || '',
                    cases,
                    totalWarns: cases.length,
                }},
                upsert: true,
            },
        });
    }
    await bulkUpsert(M.Warning, ops, 'Warning');
}

async function migrateJails(M) {
    section('3/9  Jails  (database/jail.json + jailed.json)');

    const jailData   = readJson(path.join(__dirname, 'database', 'jail.json'))   || {};
    const jailedData = readJson(path.join(__dirname, 'database', 'jailed.json')) || {};
    const merged     = { ...jailedData, ...jailData };

    if (!Object.keys(merged).length) { skip('Empty — nothing to migrate'); return; }

    const ops = [];
    for (const [userId, d] of Object.entries(merged)) {
        if (d.expiresAt && new Date(d.expiresAt) < new Date()) { skip(`Jail ${userId} already expired — skipping`); continue; }
        const stableCaseId = d.caseId || `LEGACY_${userId}`;
        ops.push({
            updateOne: {
                filter: { guildId: d.guildId || '_legacy', userId, caseId: stableCaseId },
                update: { $set: {
                    guildId:     d.guildId   || '_legacy',
                    userId,
                    caseId:      stableCaseId,
                    reason:      d.reason    || 'No reason',
                    moderatorId: d.moderatorId || '0',
                    jailRoleId:  d.jailRoleId  || d.roleId || 'LEGACY_UNKNOWN',
                    savedRoles:  d.savedRoles  || d.roles   || [],
                    jailedAt:    d.jailedAt ? new Date(d.jailedAt) : new Date(),
                    expiresAt:   d.expiresAt   ? new Date(d.expiresAt) : null,
                    active:      d.active !== undefined ? d.active : true,
                }},
                upsert: true,
            },
        });
    }
    await bulkUpsert(M.Jail, ops, 'Jail');
}

async function migrateMutes(M) {
    section('4/9  Mutes  (database/muting.json + records.json)');

    const mutingData  = readJson(path.join(__dirname, 'database', 'muting.json'))  || {};
    const recordsData = readJson(path.join(__dirname, 'database', 'records.json')) || {};

    const ops = [];

    // muting.json — active mutes keyed by userId
    for (const [userId, d] of Object.entries(mutingData)) {
        if (d.expiresAt && new Date(d.expiresAt) < new Date()) { skip(`Mute ${userId} already expired — skipping`); continue; }
        ops.push({
            updateOne: {
                filter: { guildId: d.guildId || '_legacy', userId, caseId: d.caseId || `MUT_${userId}` },
                update: { $set: {
                    guildId:     d.guildId    || '_legacy',
                    userId,
                    caseId:      d.caseId     || `MUT_${userId}`,
                    reason:      d.reason     || 'No reason',
                    moderatorId: d.moderatorId || '0',
                    muteType:    d.muteType   || 'role',
                    duration:    d.duration   || null,
                    mutedAt:     d.mutedAt    ? new Date(d.mutedAt)   : new Date(),
                    expiresAt:   d.expiresAt  ? new Date(d.expiresAt) : null,
                    active:      true,
                }},
                upsert: true,
            },
        });
    }

    // records.json — case history keyed by userId, action=MUTE
    for (const [userId, d] of Object.entries(recordsData)) {
        const muteCases = (d.cases || []).filter(c => c.action === 'MUTE');
        muteCases.forEach((c, idx) => {
            const stableCaseId = c.caseId || `REC_${userId}_${idx}`;
            ops.push({
                updateOne: {
                    filter: { caseId: stableCaseId },
                    update: { $set: {
                        guildId:     '_legacy',
                        userId,
                        caseId:      stableCaseId,
                        reason:      c.reason    || 'No reason',
                        moderatorId: c.moderatorId || '0',
                        muteType:    'role',
                        duration:    null,
                        mutedAt:     c.timestamp ? new Date(c.timestamp) : new Date(),
                        expiresAt:   null,
                        active:      false,
                    }},
                    upsert: true,
                },
            });
        });
    }

    if (!ops.length) { skip('Empty — nothing to migrate'); return; }
    await bulkUpsert(M.Mute, ops, 'Mute');
}

async function migrateTempRoles(M) {
    section('5/9  TempRoles  (database/temp_role.json)');
    const data = readJson(path.join(__dirname, 'database', 'temp_role.json')) || {};
    if (!Object.keys(data).length) { skip('Empty — nothing to migrate'); return; }

    const ops = [];
    for (const [key, d] of Object.entries(data)) {
        const expiresAt = d.expiresAt || d.expireAt;
        if (expiresAt && new Date(expiresAt) < new Date()) { skip(`TempRole ${key} already expired — skipping`); continue; }
        ops.push({
            updateOne: {
                filter: { guildId: d.guildId, userId: d.userId, roleId: d.roleId },
                update: { $set: {
                    guildId:    d.guildId,
                    userId:     d.userId,
                    roleId:     d.roleId,
                    assignedBy: d.givenBy      || d.assignedBy  || '0',
                    assignedAt: d.givenAt      ? new Date(d.givenAt) : new Date(),
                    expiresAt:  expiresAt      ? new Date(expiresAt) : null,
                    active:     d.active !== undefined ? d.active : true,
                }},
                upsert: true,
            },
        });
    }
    await bulkUpsert(M.TempRole, ops, 'TempRole');
}

async function migrateAutoResponder(M) {
    section('6/9  Auto Responder  (database/auto_responder.json)');
    const data = readJson(path.join(__dirname, 'database', 'auto_responder.json')) || {};
    if (!Object.keys(data).length) { skip('Empty — nothing to migrate'); return; }

    for (const [guildId, cfg] of Object.entries(data)) {
        await upsert(M.Guild,
            { guildId },
            { guildId, 'autoResponder.enabled': cfg.enabled ?? false, 'autoResponder.responses': cfg.responses || [] },
            `(auto_responder) guild=${guildId}`
        );
    }
}

async function migrateAutoRoles(M) {
    section('7/9  Auto Roles  (database/auto_role.json)');
    const data = readJson(path.join(__dirname, 'database', 'auto_role.json')) || {};
    if (!Object.keys(data).length) { skip('Empty — nothing to migrate'); return; }

    for (const [guildId, cfg] of Object.entries(data)) {
        await upsert(M.Guild, { guildId }, { guildId, autoRoles: cfg }, `(auto_roles) guild=${guildId}`);
    }
}

async function migrateSuggestions(M) {
    section('8/9  Suggestions  (database/suggestions.json + suggestions_data.json)');

    // suggestions.json — per-guild config
    const cfgData  = readJson(path.join(__dirname, 'database', 'suggestions.json'))      || {};
    // suggestions_data.json — per-guild list of suggestion entries
    const itemData = readJson(path.join(__dirname, 'database', 'suggestions_data.json')) || {};

    // Merge config into Guild documents
    for (const [guildId, cfg] of Object.entries(cfgData)) {
        await upsert(M.Guild, { guildId }, { guildId, suggestionsConfig: cfg }, `(suggestions config) guild=${guildId}`);
    }

    // Upsert individual suggestion records
    const ops = [];
    for (const [guildId, gd] of Object.entries(itemData)) {
        const suggestions = gd.suggestions || gd;
        for (const [, s] of Object.entries(suggestions)) {
            ops.push({
                updateOne: {
                    filter: { guildId, suggId: String(s.id || s.suggId) },
                    update: { $set: {
                        guildId,
                        suggId:        String(s.id || s.suggId),
                        userId:        s.submitterId  || s.userId || '0',
                        content:       (s.content     || '').substring(0, 4000),
                        messageId:     s.messageId    || null,
                        channelId:     s.channelId    || null,
                        status:        ['pending','approved','denied','implemented','considering'].includes(s.status)
                                        ? s.status : 'pending',
                        upvotes:       typeof s.upvotes   === 'number' ? [] : (s.upvotes   || []),
                        downvotes:     typeof s.downvotes === 'number' ? [] : (s.downvotes || []),
                        staffResponse: s.moderatedBy   ? `Moderated by <@${s.moderatedBy}>` : null,
                        respondedBy:   s.moderatedBy   || null,
                        createdAt:     s.createdAt ? new Date(s.createdAt) : new Date(),
                    }},
                    upsert: true,
                },
            });
        }
    }
    if (ops.length) await bulkUpsert(M.Suggestion, ops, 'Suggestion');
    else skip('No suggestion entries to migrate');
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Per-guild JSON files  (dashboard/database/<guildId>/*.json)
// ════════════════════════════════════════════════════════════════════════════

async function migratePerGuild(M) {
    section('9/9  Per-guild data  (dashboard/database/<guildId>/*.json)');

    const dbRoot = path.join(__dirname, 'dashboard', 'database');
    if (!fs.existsSync(dbRoot)) {
        skip('dashboard/database/ not found — no per-guild JSON data to migrate');
        return;
    }
    const guilds = fs.readdirSync(dbRoot)
        .filter(n => fs.statSync(path.join(dbRoot, n)).isDirectory());

    log(`Found ${guilds.length} guild folder(s)`);

    for (const guildId of guilds) {
        const gDir = path.join(dbRoot, guildId);
        log(`\n  Processing guild ${guildId}...`);

        const read = (name) => readJson(path.join(gDir, `${name}.json`));

        // ── Guild document fields ─────────────────────────────────────────
        const guildUpdate = { guildId };

        const settings    = read('settings');
        const protection  = read('protection');
        const commands    = read('commands');
        const tickets     = read('tickets');
        const staffPoints = read('staff_points');
        const ticketStats = read('ticket_stats');

        if (protection)  guildUpdate.protection        = protection;
        if (staffPoints) guildUpdate.staffPointsConfig = staffPoints;
        if (ticketStats) guildUpdate['stats.ticketStats'] = ticketStats;

        // tickets.json → ticketGeneral + ticketPanels
        if (tickets) {
            const { panels, ...general } = tickets;
            guildUpdate.ticketGeneral  = general;
            if (panels) guildUpdate.ticketPanels = panels;
        }

        // Merge settings + commandsConfig into one object to avoid $set path conflict
        const mergedSettings = Object.assign({}, settings || {});
        if (settings?.LEVEL_SYSTEM) guildUpdate.levelSystem = settings.LEVEL_SYSTEM;
        if (commands) mergedSettings.commandsConfig = commands;
        if (Object.keys(mergedSettings).length) guildUpdate.settings = mergedSettings;

        // Upsert the Guild doc
        await upsert(M.Guild, { guildId }, guildUpdate, `guild=${guildId}`);

        // ── MemberLevel (levels.json) ─────────────────────────────────────
        const levels = read('levels');
        if (levels && Object.keys(levels).length) {
            const ops = Object.entries(levels).map(([userId, d]) => ({
                updateOne: {
                    filter: { guildId, userId },
                    update: { $set: {
                        guildId,
                        userId,
                        textXP:        d.textXP        ?? 0,
                        textMessages:  d.textMessages  ?? 0,
                        textLevel:     d.textLevel     ?? 0,
                        voiceXP:       d.voiceXP       ?? 0,
                        voiceMinutes:  d.voiceMinutes  ?? 0,
                        voiceLevel:    d.voiceLevel    ?? 0,
                        lastTextTime:  d.lastTextTime  ?? 0,
                        voiceJoinedAt: d.voiceJoinedAt ? new Date(d.voiceJoinedAt) : null,
                    }},
                    upsert: true,
                },
            }));
            await bulkUpsert(M.MemberLevel, ops, `MemberLevel guild=${guildId}`);
        }

        // ── Tickets  (open_tickets.json) ──────────────────────────────────
        const openTickets = read('open_tickets');
        const ticketList  = openTickets?.tickets || (Array.isArray(openTickets) ? openTickets : []);
        if (ticketList.length) {
            const ops = ticketList.map(t => ({
                updateOne: {
                    filter: { ticketId: t.id || t.ticketId },
                    update: { $set: {
                        ticketId:    t.id    || t.ticketId,
                        guildId:     t.guildId    || guildId,
                        userId:      t.userId,
                        channelId:   t.channelId  || null,
                        panelId:     t.panelId    || null,
                        status:      ['open','closed','pending_close'].includes(t.status) ? t.status : 'open',
                        claimedBy:   t.claimedBy  || null,
                        claimedAt:   t.claimedAt  ? new Date(t.claimedAt)  : null,
                        closedAt:    t.closedAt   ? new Date(t.closedAt)   : null,
                        closedBy:    t.closedBy   || null,
                        formAnswers: t.formAnswers || {},
                        rating:      t.rating     || null,
                        number:      t.number     ?? null,
                        closeReason: t.closeReason || null,
                        createdAt:   t.openedAt   ? new Date(t.openedAt)   : new Date(),
                    }},
                    upsert: true,
                },
            }));
            await bulkUpsert(M.Ticket, ops, `Ticket guild=${guildId}`);
        }

        // ── TicketFeedback  (ticket_feedback.json) ────────────────────────
        const feedback = read('ticket_feedback');
        const fbList   = feedback?.entries || (Array.isArray(feedback) ? feedback : []);
        if (fbList.length) {
            const ops = fbList.map(f => ({
                updateOne: {
                    filter: { ticketId: f.ticketId, userId: f.userId },
                    update: { $set: {
                        guildId:     guildId,
                        ticketId:    f.ticketId,
                        userId:      f.userId,
                        rating:      f.rating  || null,
                        comment:     f.comment || '',
                        submittedAt: f.submittedAt ? new Date(f.submittedAt) : new Date(),
                    }},
                    upsert: true,
                },
            }));
            await bulkUpsert(M.TicketFeedback, ops, `TicketFeedback guild=${guildId}`);
        }

        // ── StaffScore  (staff_scores.json) ───────────────────────────────
        const staffScores = read('staff_scores');
        if (staffScores && Object.keys(staffScores).length) {
            const ops = Object.entries(staffScores).map(([staffId, d]) => ({
                updateOne: {
                    filter: { guildId, staffId },
                    update: { $set: {
                        guildId,
                        staffId,
                        points:  d.points  ?? 0,
                        history: (d.history || []).slice(-100),
                    }},
                    upsert: true,
                },
            }));
            await bulkUpsert(M.StaffScore, ops, `StaffScore guild=${guildId}`);
        }

        // ── InteractionScore  (interaction_scores.json) ───────────────────
        const interScores = read('interaction_scores');
        if (interScores && Object.keys(interScores).length) {
            const ops = Object.entries(interScores).map(([userId, d]) => ({
                updateOne: {
                    filter: { guildId, userId },
                    update: { $set: {
                        guildId,
                        userId,
                        points:  d.points  ?? 0,
                        history: (d.history || []).slice(-100),
                    }},
                    upsert: true,
                },
            }));
            await bulkUpsert(M.InteractionScore, ops, `InteractionScore guild=${guildId}`);
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════

async function main() {
    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║   Next Generation — JSON → MongoDB Migration             ║');
    if (DRY_RUN)
    console.log('║   ⚠️  DRY-RUN MODE — no data will be written              ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    await connect();
    const M = models();

    // ── Run all migration sections ────────────────────────────────────────
    await migrateAFK(M);
    await migrateWarnings(M);
    await migrateJails(M);
    await migrateMutes(M);
    await migrateTempRoles(M);
    await migrateAutoResponder(M);
    await migrateAutoRoles(M);
    await migrateSuggestions(M);
    await migratePerGuild(M);

    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║   Migration complete ✅                                  ║');
    if (DRY_RUN)
    console.log('║   Re-run without --dry-run to apply changes              ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    await mongoose.disconnect();
}

main().catch(e => {
    console.error('\n❌ Migration crashed:', e);
    mongoose.disconnect().finally(() => process.exit(1));
});
