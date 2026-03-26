/*
 * Next Generation — Role Automation Engine v2
 * ─────────────────────────────────────────────────────────────────────────────
 * A full Decision Engine for role management inside the Embed Flow system.
 *
 * Design Philosophy
 * ──────────────────
 *  Roles are NOT just "give/remove" buttons.
 *  A role action is a Decision Node with:
 *
 *    Conditions  →  Anti-Abuse  →  Execute  →  Side Effects
 *
 *  Every action passes through this pipeline, making the system:
 *    • Conditional: only act when requirements are met
 *    • Safe:        cooldown + use-limit per user per action
 *    • Smart:       toggle, exclusive groups, temp expiry
 *    • Integrated:  reads XP / levels to gate premium actions
 *
 * Supported Action Types (all accept { conditions?, abuse?, denyMessage? })
 * ──────────────────────────────────────────────────────────────────────────
 *  role_toggle      Toggle a role on/off
 *  role_exclusive   Mutual-exclusion: remove all group siblings, add target
 *  role_temp        Time-limited role with persistence across bot restarts
 *  role_conditional Explicit add OR remove based on conditions
 *  role_check_branch Evaluate conditions → route to different target state
 *  grant_xp         Award XP points (text or voice track)
 *
 * Condition Types
 * ────────────────
 *  has_role          { roleId }
 *  missing_role      { roleId }
 *  has_all_roles     { roleIds: [] }
 *  has_any_role      { roleIds: [] }
 *  missing_all_roles { roleIds: [] }    — has NONE of the listed roles
 *  min_level         { level }          — textLevel + voiceLevel >= level
 *  min_xp            { xp }             — textXP + voiceXP >= xp
 *  min_text_level    { level }
 *  min_voice_level   { level }
 *  min_messages      { messages }
 *  min_voice_minutes { minutes }
 *
 *  Operator: first condition may carry operator: 'OR' to change AND→OR logic.
 *
 * Anti-Abuse Config  { cooldown, maxUses, windowMs, cooldownMessage, limitMessage }
 */

'use strict';

const logger     = require('../utils/logger');
const TempRole   = require('./schemas/TempRole');
const MemberLevel = require('./schemas/MemberLevel');
const guildDb    = require('../dashboard/utils/guildDb');

// ─────────────────────────────────────────────────────────────────────────────
// XP HELPERS  (integrates with levels.js JSON-file system)
// ─────────────────────────────────────────────────────────────────────────────

const MESSAGES_PER_LEVEL = 50;
const MINUTES_PER_LEVEL  = 30;

function _xpForLevel(n)        { return 5 * n * n + 50 * n + 100; }
function _levelFromXp(totalXp) {
    let lvl = 0;
    while (totalXp >= _xpForLevel(lvl)) { totalXp -= _xpForLevel(lvl++); }
    return lvl;
}
function _levelFromMessages(m) { return Math.floor(m / MESSAGES_PER_LEVEL); }
function _levelFromMinutes(m)  { return Math.floor(m / MINUTES_PER_LEVEL); }

/** Read a member's XP/level totals from the JSON levels file (no DB round-trip). */
function _getMemberLevelData(guildId, userId) {
    try {
        const db   = guildDb.read(guildId, 'levels', {});
        const user = db[userId];
        if (!user) return { level: 0, xp: 0, textXP: 0, voiceXP: 0 };
        const textXP  = user.textXP  || 0;
        const voiceXP = user.voiceXP || 0;
        const totalXP = textXP + voiceXP;
        return { level: _levelFromXp(totalXP), xp: totalXP, textXP, voiceXP };
    } catch { return { level: 0, xp: 0, textXP: 0, voiceXP: 0 }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATE ENGINE  — {{var.path}} interpolation in all string action fields
// ─────────────────────────────────────────────────────────────────────────────

const _TMPL_RE = /\{\{([^}]+)\}\}/g;

/**
 * Build a template variable context from the current execution state.
 * This is passed to resolveTemplate() for every message/payload field.
 *
 * Available variables:
 *   {{member.id}}          User ID
 *   {{member.tag}}         username#0000
 *   {{member.username}}    username
 *   {{member.displayName}} Guild display name
 *   {{member.mention}}     <@userId>
 *   {{guild.id}}           Guild ID
 *   {{guild.name}}         Guild name
 *   {{level}}              Total combined level
 *   {{xp}}                 Total combined XP
 *   {{timestamp}}          Unix epoch (seconds)
 *   {{result.*}}           Fields from the previous action's result
 */
function _buildContext(member, guildData = {}, result = {}) {
    const uid = member?.id;
    return {
        member: {
            id:          uid                                   || '',
            tag:         member?.user?.tag                    || '',
            username:    member?.user?.username               || '',
            displayName: member?.displayName                  || member?.user?.username || '',
            mention:     uid ? `<@${uid}>` : '',
        },
        guild: {
            id:   member?.guild?.id   || '',
            name: member?.guild?.name || '',
        },
        level:     guildData.level   ?? '',
        xp:        guildData.xp      ?? '',
        timestamp: Math.floor(Date.now() / 1000),
        result,
    };
}

/**
 * Replace {{key.path}} placeholders in a string.
 * Unknown paths collapse to empty string; never throws.
 *
 * @param {string}  str  — Input string (undefined/null → returned as-is)
 * @param {object}  ctx  — Built by _buildContext
 * @returns {string}
 */
function resolveTemplate(str, ctx) {
    if (!str || typeof str !== 'string') return str ?? '';
    return str.replace(_TMPL_RE, (_, path) => {
        try {
            const keys = path.trim().split('.');
            let v = ctx;
            for (const k of keys) { if (v == null) return ''; v = v[k]; }
            return v ?? '';
        } catch { return ''; }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// CONDITION EVALUATORS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Each evaluator receives (member, condition, guildId) and returns bool/Promise<bool>.
 */
const CONDITION_EVALUATORS = {

    // ── Role conditions ──────────────────────────────────────────────────────
    has_role:          ({ member, roleId }) =>
        !!roleId && member.roles.cache.has(roleId),

    missing_role:      ({ member, roleId }) =>
        !!roleId && !member.roles.cache.has(roleId),

    has_all_roles:     ({ member, roleIds = [] }) =>
        roleIds.every(rid => member.roles.cache.has(rid)),

    has_any_role:      ({ member, roleIds = [] }) =>
        roleIds.some(rid => member.roles.cache.has(rid)),

    missing_all_roles: ({ member, roleIds = [] }) =>
        roleIds.every(rid => !member.roles.cache.has(rid)),

    // ── Level / XP conditions (reads live levels.js JSON) ───────────────────
    min_level: ({ member, level = 1, guildId }) => {
        try {
            const db   = guildDb.read(guildId, 'levels', {});
            const user = db[member.id];
            if (!user) return false;
            const textMode  = guildDb.read(guildId, 'settings', {})?.LEVEL_SYSTEM?.TEXT_ACTIVITY?.TRACK_MODE  || 'MESSAGES';
            const voiceMode = guildDb.read(guildId, 'settings', {})?.LEVEL_SYSTEM?.VOICE_ACTIVITY?.TRACK_MODE || 'XP';
            const tLvl = textMode  === 'XP'     ? _levelFromXp(user.textXP || 0)       :
                         textMode  === 'MESSAGES'? _levelFromMessages(user.textMessages || 0) : 0;
            const vLvl = voiceMode === 'XP'     ? _levelFromXp(user.voiceXP || 0)      :
                         voiceMode === 'MINUTES' ? _levelFromMinutes(user.voiceMinutes || 0) : 0;
            return (tLvl + vLvl) >= Number(level);
        } catch { return false; }
    },

    min_text_level: ({ member, level = 1, guildId }) => {
        try {
            const db   = guildDb.read(guildId, 'levels', {});
            const user = db[member.id];
            if (!user) return false;
            const mode = guildDb.read(guildId, 'settings', {})?.LEVEL_SYSTEM?.TEXT_ACTIVITY?.TRACK_MODE || 'MESSAGES';
            const tLvl = mode === 'XP' ? _levelFromXp(user.textXP || 0) : _levelFromMessages(user.textMessages || 0);
            return tLvl >= Number(level);
        } catch { return false; }
    },

    min_voice_level: ({ member, level = 1, guildId }) => {
        try {
            const db   = guildDb.read(guildId, 'levels', {});
            const user = db[member.id];
            if (!user) return false;
            const mode = guildDb.read(guildId, 'settings', {})?.LEVEL_SYSTEM?.VOICE_ACTIVITY?.TRACK_MODE || 'XP';
            const vLvl = mode === 'XP' ? _levelFromXp(user.voiceXP || 0) : _levelFromMinutes(user.voiceMinutes || 0);
            return vLvl >= Number(level);
        } catch { return false; }
    },

    min_xp: ({ member, xp = 0, guildId }) => {
        try {
            const db   = guildDb.read(guildId, 'levels', {});
            const user = db[member.id];
            if (!user) return false;
            return ((user.textXP || 0) + (user.voiceXP || 0)) >= Number(xp);
        } catch { return false; }
    },

    min_messages: ({ member, messages = 0, guildId }) => {
        try {
            const db   = guildDb.read(guildId, 'levels', {});
            const user = db[member.id];
            return user ? (user.textMessages || 0) >= Number(messages) : false;
        } catch { return false; }
    },

    min_voice_minutes: ({ member, minutes = 0, guildId }) => {
        try {
            const db   = guildDb.read(guildId, 'levels', {});
            const user = db[member.id];
            return user ? (user.voiceMinutes || 0) >= Number(minutes) : false;
        } catch { return false; }
    },
};

/**
 * Recursively evaluate a single condition node:
 *   • Flat condition:  { type: 'has_role', roleId: '...' }
 *   • Nested group:    { op: 'AND'|'OR', conditions: [...] }
 *
 * Groups can be nested to any depth for complex rule trees:
 *   { op: 'OR', conditions: [
 *     { op: 'AND', conditions: [{ type:'min_level', level:5 }, { type:'has_role', roleId:'X' }] },
 *     { type: 'has_role', roleId:'BYPASS' }
 *   ]}
 */
async function evaluateConditionGroup(member, node, guildId) {
    if (node.op) {
        const op   = node.op.toUpperCase();
        const subs = [...(node.conditions || []), ...(node.groups || [])];
        for (const sub of subs) {
            const r = await evaluateConditionGroup(member, sub, guildId);
            if (op === 'OR'  &&  r) return true;   // short-circuit OR
            if (op === 'AND' && !r) return false;  // short-circuit AND
        }
        return op === 'AND'; // AND: all passed  |  OR: none passed
    }
    // Leaf condition
    const ev = CONDITION_EVALUATORS[node.type];
    if (!ev) return true; // Unknown type → permissive
    return !!(await Promise.resolve(ev({ member, ...node, guildId })));
}

/**
 * Evaluate an array of conditions.
 *
 * Three syntaxes supported (all forward-compatible):
 *   1. Legacy flat:  [{ type, ... }, ...]   — conditions[0].operator='OR' toggles mode
 *   2. Nested group: [{ op:'OR', conditions:[...] }]  — full AND/OR tree
 *   3. Mixed:        flat array may contain nested { op } group nodes
 *
 * @param {import('discord.js').GuildMember} member
 * @param {object[]} conditions
 * @param {string}   guildId
 * @returns {Promise<boolean>}
 */
async function evaluateConditions(member, conditions = [], guildId = '') {
    if (!conditions.length) return true;

    const isOR = (conditions[0]?.operator || '').toUpperCase() === 'OR';

    for (const cond of conditions) {
        // Nested group node embedded inside a flat array
        if (cond.op) {
            const r = await evaluateConditionGroup(member, cond, guildId);
            if (isOR  &&  r) return true;
            if (!isOR && !r) return false;
            continue;
        }
        const ev = CONDITION_EVALUATORS[cond.type];
        if (!ev) continue; // Unknown → skip (permissive)

        const result = await Promise.resolve(ev({ member, ...cond, guildId }));
        if (isOR  &&  result) return true;
        if (!isOR && !result) return false;
    }
    return !isOR; // AND: all passed; OR: none passed
}

// ─────────────────────────────────────────────────────────────────────────────
// ANTI-ABUSE TRACKER
// ─────────────────────────────────────────────────────────────────────────────

/** In-memory usage records. key = `${docId}:${actionKey}:${userId}` */
const _abuseMap = new Map();

/**
 * @param {object} cfg   { cooldown: s, maxUses: n, windowMs: ms,
 *                         cooldownMessage?, limitMessage? }
 * @param {string} key   Unique key (docId:actionId:userId)
 * @returns {{ allowed: boolean, remaining?: number, reason?: string }}
 */
function checkAntiAbuse(cfg, key) {
    if (!cfg?.cooldown && !cfg?.maxUses) return { allowed: true };

    const now   = Date.now();
    const entry = _abuseMap.get(key) || { lastUse: 0, useCount: 0, windowStart: now };

    // Window reset
    const windowMs = Number(cfg.windowMs) || 0;
    if (windowMs > 0 && now - entry.windowStart >= windowMs) {
        entry.useCount    = 0;
        entry.windowStart = now;
    }

    // Cooldown
    if (Number(cfg.cooldown) > 0) {
        const elapsed = (now - entry.lastUse) / 1000;
        if (elapsed < cfg.cooldown)
            return { allowed: false, remaining: Math.ceil(cfg.cooldown - elapsed), reason: 'cooldown' };
    }

    // Max uses
    if (Number(cfg.maxUses) > 0 && entry.useCount >= Number(cfg.maxUses))
        return { allowed: false, reason: 'max_uses' };

    // Pass — record this use
    entry.lastUse  = now;
    entry.useCount = (entry.useCount || 0) + 1;
    _abuseMap.set(key, entry);

    if (Number(cfg.cooldown) > 0)
        setTimeout(() => _abuseMap.delete(key), Number(cfg.cooldown) * 1000 + 500);

    return { allowed: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// TEMPORARY ROLE ENGINE
// ─────────────────────────────────────────────────────────────────────────────

/** In-memory removal timers. key = `${guildId}:${userId}:${roleId}` */
const _tempTimers = new Map();

async function _scheduleRemoval(client, guildId, userId, roleId, dbId, expiresAt) {
    const key   = `${guildId}:${userId}:${roleId}`;
    const timer = _tempTimers.get(key);
    if (timer) clearTimeout(timer);

    const delay = Math.max(1, expiresAt.getTime() - Date.now());
    _tempTimers.set(key, setTimeout(async () => {
        _tempTimers.delete(key);
        try {
            const guild  = await client.guilds.fetch(guildId).catch(() => null);
            const member = guild && await guild.members.fetch(userId).catch(() => null);
            if (member && member.roles.cache.has(roleId))
                await member.roles.remove(roleId, 'Temp role expired (flow automation)');
        } catch (e) {
            logger.warn('[RoleAuto] Temp role expiry failed:', { error: e?.message });
        }
        TempRole.findOneAndUpdate({ guildId, userId, roleId }, { $set: { active: false } }).catch(() => {});
    }, delay));
}

/**
 * Called once on bot startup — re-schedules all active temp role removals
 * that survived a restart.
 * @param {import('discord.js').Client} client
 */
async function restoreTempRoles(client) {
    try {
        const active = await TempRole.find({ active: true, expiresAt: { $gt: new Date() } }).lean();
        if (active.length)
            logger.info(`[RoleAuto] Restoring ${active.length} active temp role(s) from DB`);
        for (const tr of active)
            _scheduleRemoval(client, tr.guildId, tr.userId, tr.roleId, tr._id, tr.expiresAt);

        // Purge already-expired active docs (missed by previous run)
        const expired = await TempRole.find({ active: true, expiresAt: { $lte: new Date() } }).lean();
        if (expired.length) {
            for (const tr of expired) {
                try {
                    const g  = await client.guilds.fetch(tr.guildId).catch(() => null);
                    const m  = g && await g.members.fetch(tr.userId).catch(() => null);
                    if (m && m.roles.cache.has(tr.roleId))
                        await m.roles.remove(tr.roleId, 'Temp role expired (startup cleanup)');
                } catch {}
                await TempRole.findByIdAndUpdate(tr._id, { $set: { active: false } }).catch(() => {});
            }
        }
    } catch (e) {
        logger.warn('[RoleAuto] restoreTempRoles failed:', { error: e?.message });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// XP GRANT  (gamification hook)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Award XP to a member from a flow action.
 *
 * Writes to BOTH the JSON-file levels system (compatibility with levels.js)
 * AND the MongoDB MemberLevel schema (for the dashboard Leaderboard).
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {number} xp
 * @param {'text'|'voice'} track
 */
async function grantXP(guildId, userId, xp, track = 'text') {
    if (!xp || xp <= 0) return;
    const field = track === 'voice' ? 'voiceXP' : 'textXP';

    // ── JSON file system (levels.js compatibility) ───────────────────────────
    try {
        const db   = guildDb.read(guildId, 'levels', {});
        if (!db[userId]) db[userId] = {
            textXP: 0, textMessages: 0, textLevel: 0,
            voiceXP: 0, voiceMinutes: 0, voiceLevel: 0,
            lastTextTime: 0, voiceJoinedAt: null
        };
        db[userId][field] = (db[userId][field] || 0) + xp;
        guildDb.write(guildId, 'levels', db);
    } catch (e) {
        logger.warn('[RoleAuto] grantXP JSON write failed:', { error: e?.message });
    }

    // ── MongoDB MemberLevel (dashboard / leaderboard) ────────────────────────
    MemberLevel.findOneAndUpdate(
        { guildId, userId },
        { $inc: { [field]: xp }, $set: { lastSeen: new Date() } },
        { upsert: true }
    ).catch(e => logger.warn('[RoleAuto] grantXP MongoDB failed:', { error: e?.message }));
}

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK INTEGRATION  (SSRF-protected outbound POST)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a webhook target URL against SSRF attack vectors.
 * Only HTTP/HTTPS URLs pointing to publicly routable addresses are allowed.
 */
function _isSafeWebhookUrl(urlStr) {
    try {
        const u = new URL(urlStr);
        if (!['https:', 'http:'].includes(u.protocol)) return false;
        const h = u.hostname.toLowerCase();
        if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(h)) return false;
        if (/^10\./.test(h))                            return false; // RFC-1918 class A
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(h))      return false; // RFC-1918 class B
        if (/^192\.168\./.test(h))                      return false; // RFC-1918 class C
        if (/^169\.254\./.test(h))                      return false; // link-local
        if (/^fd|^fc|^fe80/i.test(h))                   return false; // IPv6 ULA / link-local
        if (h === 'metadata.google.internal')            return false; // GCP metadata service
        return true;
    } catch { return false; }
}

/**
 * POST a JSON payload to an external webhook (SSRF-safe, 5 s timeout).
 *
 * The payload string is template-resolved before sending — so you can use
 * {{member.id}}, {{guild.name}}, {{result.*}}, etc. inside the payload template.
 *
 * @param {string}        url              Webhook URL
 * @param {string|object} payloadTemplate  JSON string or object (templates resolved)
 * @param {object}        ctx              Template context from _buildContext
 * @returns {Promise<{ status: number }>}
 */
async function fireWebhook(url, payloadTemplate, ctx = {}) {
    if (!url) return { status: 0 };
    if (!_isSafeWebhookUrl(url)) {
        logger.warn('[RoleAuto] fireWebhook: blocked unsafe URL', { url });
        return { status: 0 };
    }
    const rawPayload = typeof payloadTemplate === 'string'
        ? payloadTemplate
        : JSON.stringify(payloadTemplate || {});
    const resolved = resolveTemplate(rawPayload, ctx);
    let payload;
    try   { payload = JSON.parse(resolved); }
    catch { payload = { content: resolved }; }

    const https  = require('https');
    const http   = require('http');
    const urlObj = new URL(url);
    const lib    = urlObj.protocol === 'https:' ? https : http;
    const body   = JSON.stringify(payload);

    return new Promise(resolve => {
        const req = lib.request({
            hostname: urlObj.hostname,
            port:     urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path:     urlObj.pathname + urlObj.search,
            method:   'POST',
            headers: {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body),
                'User-Agent':     'NextGenBot-Automation/2.0',
            },
        }, res => { res.resume(); resolve({ status: res.statusCode }); });
        req.on('error', () => resolve({ status: 0 }));
        req.setTimeout(5000, () => { req.destroy(); resolve({ status: 0 }); });
        req.write(body);
        req.end();
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// GUILD ROLE GROUPS  — Named role-group registry stored in guild settings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a named role group from guild settings.
 *
 * Groups are stored in guild settings under ROLE_GROUPS:
 *   { "ROLE_GROUPS": { "tier_roles": ["id1", "id2", "id3"] } }
 *
 * In role_exclusive you can then use:
 *   { type: 'role_exclusive', roleId: '...', groupName: 'tier_roles' }
 * instead of manually listing every sibling ID.
 *
 * @param {string} guildId
 * @param {string} groupName
 * @returns {string[]}
 */
function resolveGroupByName(guildId, groupName) {
    if (!groupName || !guildId) return [];
    try {
        const settings = guildDb.read(guildId, 'settings', {});
        const groups   = settings?.ROLE_GROUPS || {};
        const roles    = groups[groupName];
        return Array.isArray(roles) ? roles.map(String) : [];
    } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE GUARD — Condition + Anti-Abuse wrapper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run condition checks and anti-abuse guard.
 * Sends a followUp ephemeral if blocked.
 * Returns { pass: true } or { pass: false, reason }.
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {import('discord.js').GuildMember} member
 * @param {object} action   — Full action object from the pipeline
 * @param {string} abuseKey — Unique key: `${docId}:${action.type}:${userId}`
 * @param {object} ctx      — Template context built by _buildContext
 */
// ── Helper: normalize a value that may be an array or comma-sep string ──────
function _toArray(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val.map(String).filter(Boolean);
    return String(val).split(',').map(s => s.trim()).filter(Boolean);
}

async function runGuard(interaction, member, action, abuseKey, ctx = {}) {
    const guildId = interaction.guildId || member.guild.id;

    // ── Anti-abuse ───────────────────────────────────────────────────────────
    // Support nested `action.abuse` object OR flat form keys:
    // abuse_cooldown, abuse_maxUses, abuse_windowMs, abuse_cooldownMessage, abuse_limitMessage
    const abuseCfg = action.abuse
        || ((action.abuse_cooldown || action.abuse_maxUses) ? {
               cooldown:        Number(action.abuse_cooldown)       || 0,
               maxUses:         Number(action.abuse_maxUses)        || 0,
               windowMs:        Number(action.abuse_windowMs)       || 0,
               cooldownMessage: String(action.abuse_cooldownMessage || ''),
               limitMessage:    String(action.abuse_limitMessage    || ''),
           } : null);
    if (abuseCfg) {
        const r = checkAntiAbuse(abuseCfg, abuseKey);
        if (!r.allowed) {
            const rawMsg = r.reason === 'cooldown'
                ? (abuseCfg.cooldownMessage?.trim() || `⏳ Please wait **${r.remaining}s** before using this again.`)
                : (abuseCfg.limitMessage?.trim()    || `🚫 You've reached the maximum uses for this action.`);
            await interaction.followUp({ content: resolveTemplate(rawMsg, ctx), flags: 64 }).catch(() => {});
            return { pass: false, reason: r.reason };
        }
    }

    // ── Conditions ───────────────────────────────────────────────────────────
    if (action.conditions?.length || action.hasRole || action.missingRole ||
        action.minLevel || action.minXp || action.minTextLevel || action.minVoiceLevel ||
        action.minMessages || action.hasAllRoles || action.hasAnyRole || action.missingAllRoles) {

        const conds = [...(action.conditions || [])];
        if (action.hasRole)         conds.push({ type: 'has_role',          roleId:   action.hasRole });
        if (action.missingRole)     conds.push({ type: 'missing_role',      roleId:   action.missingRole });
        if (action.hasAllRoles)     conds.push({ type: 'has_all_roles',     roleIds:  _toArray(action.hasAllRoles) });
        if (action.hasAnyRole)      conds.push({ type: 'has_any_role',      roleIds:  _toArray(action.hasAnyRole) });
        if (action.missingAllRoles) conds.push({ type: 'missing_all_roles', roleIds:  _toArray(action.missingAllRoles) });
        if (action.minLevel)        conds.push({ type: 'min_level',          level:    action.minLevel });
        if (action.minTextLevel)    conds.push({ type: 'min_text_level',     level:    action.minTextLevel });
        if (action.minVoiceLevel)   conds.push({ type: 'min_voice_level',    level:    action.minVoiceLevel });
        if (action.minXp)           conds.push({ type: 'min_xp',             xp:       action.minXp });
        if (action.minMessages)     conds.push({ type: 'min_messages',       messages: action.minMessages });

        const passed = await evaluateConditions(member, conds, guildId);
        if (!passed) {
            const rawMsg = action.denyMessage?.trim() || '🚫 You do not meet the requirements for this action.';
            await interaction.followUp({ content: resolveTemplate(rawMsg, ctx), flags: 64 }).catch(() => {});
            return { pass: false, reason: 'conditions_failed' };
        }
    }

    return { pass: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ROLE ACTION EXECUTOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute one role automation action from the embed pipeline.
 *
 * Returns an enriched result object used by role_check_branch to decide
 * which state to navigate to.
 *
 * @param {import('discord.js').Client}      client
 * @param {import('discord.js').Interaction} interaction
 * @param {object}      action     — Action from emped _execute pipeline
 * @param {object}      doc        — EmbedMessage lean doc (for context / docId)
 * @param {object|null} flowCtx    — Active flow context (DM/channel forwarded)
 * @param {object}      prevResult — Result from previous action (for {{result.*}} templates)
 * @returns {Promise<{ granted: boolean, denyReason?: string, had?: boolean, operator?: string, expiresAt?: Date }>}
 */
async function executeRoleAction(client, interaction, action, doc, flowCtx = null, prevResult = {}) {

    // ── Resolve guild + member ────────────────────────────────────────────────
    const guildId = interaction.guildId || flowCtx?.guildId;
    const userId  = interaction.user?.id || flowCtx?.userId;
    if (!guildId || !userId) {
        logger.warn('[RoleAuto] Cannot resolve guild/user for role action');
        return { granted: false, denyReason: 'no_context' };
    }

    const guild  = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild)  return { granted: false, denyReason: 'guild_not_found' };

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return { granted: false, denyReason: 'member_not_found' };

    // ── Template context (built once; used in all string fields) ────────────────
    const levelData = _getMemberLevelData(guildId, userId);
    const ctx       = _buildContext(member, levelData, prevResult);

    // ── Guard (anti-abuse + conditions) ──────────────────────────────────────────
    const abuseKey = `${doc._id}:${action.type}:${userId}`;
    const guard    = await runGuard(interaction, member, action, abuseKey, ctx);
    if (!guard.pass) return { granted: false, denyReason: guard.reason };

    // ── Execute ───────────────────────────────────────────────────────────────
    try {
        switch (action.type) {

            // ── Toggle ───────────────────────────────────────────────────────
            case 'role_toggle': {
                if (!action.roleId) return { granted: false, denyReason: 'no_roleId' };
                const hadRole = member.roles.cache.has(action.roleId);
                if (hadRole) {
                    await member.roles.remove(action.roleId, 'Flow: toggle off');
                } else {
                    await member.roles.add(action.roleId, 'Flow: toggle on');
                }
                return { granted: true, had: hadRole };
            }

            // ── Exclusive (mutual-exclusion group) ───────────────────────────
            case 'role_exclusive': {
                if (!action.roleId) return { granted: false, denyReason: 'no_roleId' };
                // Siblings from: explicit IDs, comma-sep string, AND/OR named group
                const explicitIds = _toArray(action.groupRoles);
                const namedGroup  = action.groupName ? resolveGroupByName(guildId, action.groupName) : [];
                const siblings    = [...new Set([...explicitIds, ...namedGroup])]
                    .filter(rid => rid !== action.roleId);
                for (const rid of siblings)
                    if (member.roles.cache.has(rid))
                        await member.roles.remove(rid, 'Flow: exclusive group swap');
                if (!member.roles.cache.has(action.roleId))
                    await member.roles.add(action.roleId, 'Flow: exclusive group assign');
                return { granted: true };
            }

            // ── Temporary role ───────────────────────────────────────────────
            case 'role_temp': {
                if (!action.roleId) return { granted: false, denyReason: 'no_roleId' };
                const durationMs = Number(action.duration) || 3_600_000; // default 1h
                const expiresAt  = new Date(Date.now() + durationMs);

                // Add the role
                if (!member.roles.cache.has(action.roleId))
                    await member.roles.add(action.roleId, 'Flow: temp role assigned');

                // Persist to DB and (re-)schedule removal timer
                const tr = await TempRole.assign(
                    guildId, userId, action.roleId,
                    `flow:${doc._id}`, expiresAt
                );
                await _scheduleRemoval(client, guildId, userId, action.roleId, tr._id, expiresAt);

                return { granted: true, expiresAt };
            }

            // ── Conditional add / remove ─────────────────────────────────────
            case 'role_conditional': {
                if (!action.roleId) return { granted: false, denyReason: 'no_roleId' };
                const op = action.operator === 'remove' ? 'remove' : 'add';
                if (op === 'add' && !member.roles.cache.has(action.roleId))
                    await member.roles.add(action.roleId, 'Flow: conditional add');
                else if (op === 'remove' && member.roles.cache.has(action.roleId))
                    await member.roles.remove(action.roleId, 'Flow: conditional remove');
                return { granted: true, operator: op };
            }

            // ── XP grant (gamification) ──────────────────────────────────────
            case 'grant_xp': {
                const xp    = Number(action.xp) || 0;
                const track = action.track === 'voice' ? 'voice' : 'text';
                await grantXP(guildId, userId, xp, track);
                return { granted: true };
            }
            // ── Role Sequence — run multiple sub-actions as a single pipeline ─────
            // Each sub-action's result is passed as prevResult to the next,
            // making {{result.*}} available for chained message templates.
            // Set continueOnFail: true on a sub-action to keep going after a deny.
            case 'role_sequence': {
                const subActions = action.actions || [];
                if (!Array.isArray(subActions) || !subActions.length)
                    return { granted: false, denyReason: 'no_actions' };
                let lastResult = { ...prevResult };
                for (const subAction of subActions) {
                    try {
                        lastResult = await executeRoleAction(
                            client, interaction, subAction, doc, flowCtx, lastResult
                        );
                        if (!lastResult.granted && !subAction.continueOnFail) break;
                    } catch (e) {
                        logger.warn('[RoleAuto] role_sequence sub-action failed:',
                            { type: subAction.type, error: e?.message });
                        if (!subAction.continueOnFail) break;
                    }
                }
                return lastResult;
            }

            // ── Fire Webhook — POST to external endpoint ────────────────────────────
            // Payload supports {{member.id}}, {{guild.name}}, {{result.*}}, etc.
            case 'fire_webhook': {
                if (!action.url) return { granted: false, denyReason: 'no_url' };
                const wResult = await fireWebhook(
                    action.url,
                    action.payload || action.payloadTemplate || {},
                    ctx
                );
                const ok = wResult.status >= 200 && wResult.status < 300;
                if (!ok && action.failMessage)
                    await interaction.followUp({
                        content: resolveTemplate(action.failMessage, ctx), flags: 64,
                    }).catch(() => {});
                if (ok && action.successMessage)
                    await interaction.followUp({
                        content: resolveTemplate(action.successMessage, ctx), flags: 64,
                    }).catch(() => {});
                return { granted: true, webhookStatus: wResult.status, webhookOk: ok };
            }
            default:
                return { granted: false, denyReason: 'unknown_type' };
        }
    } catch (e) {
        logger.warn(`[RoleAuto] "${action.type}" failed:`, { error: e?.message, stack: e?.stack?.split('\n')[0] });
        return { granted: false, denyReason: 'error', error: e?.message };
    }
}

/**
 * Evaluate a role_check_branch action:
 * checks conditions → returns which branch target won.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {object} action  — { conditions, hasRole, missingRole, minLevel, … }
 * @param {string} guildId
 * @returns {Promise<{ passed: boolean }>}
 */
async function evalBranchConditions(member, action, guildId) {
    // Build full conditions array
    const conds = [...(action.conditions || [])];
    if (action.hasRole)         conds.push({ type: 'has_role',       roleId:  action.hasRole });
    if (action.missingRole)     conds.push({ type: 'missing_role',   roleId:  action.missingRole });
    if (action.hasAllRoles)     conds.push({ type: 'has_all_roles',     roleIds: _toArray(action.hasAllRoles) });
    if (action.hasAnyRole)      conds.push({ type: 'has_any_role',      roleIds: _toArray(action.hasAnyRole) });
    if (action.missingAllRoles) conds.push({ type: 'missing_all_roles', roleIds: _toArray(action.missingAllRoles) });
    if (action.minLevel)        conds.push({ type: 'min_level',          level:   action.minLevel });
    if (action.minTextLevel)    conds.push({ type: 'min_text_level',     level:   action.minTextLevel });
    if (action.minVoiceLevel)   conds.push({ type: 'min_voice_level',    level:   action.minVoiceLevel });
    if (action.minXp)           conds.push({ type: 'min_xp',             xp:      action.minXp });
    if (action.minMessages)     conds.push({ type: 'min_messages',       messages: action.minMessages });

    if (!conds.length) return { passed: true }; // No conditions → always pass
    const passed = await evaluateConditions(member, conds, guildId);
    return { passed };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
    executeRoleAction,
    evalBranchConditions,
    evaluateConditions,
    evaluateConditionGroup,
    checkAntiAbuse,
    restoreTempRoles,
    grantXP,
    resolveTemplate,
    resolveGroupByName,
    fireWebhook,
    CONDITION_EVALUATORS,
};

/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */
