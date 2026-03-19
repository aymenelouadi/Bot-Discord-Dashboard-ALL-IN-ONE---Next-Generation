/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

/**
 * systems/points_tickets.js
 * Staff Points engine — ticket ratings, commands, rewards, CV2 logging.
 *
 * Config stored at: dashboard/database/<guildId>/staff_points.json
 * Scores stored at: dashboard/database/<guildId>/staff_scores.json
 *
 * Rating schema: per-star (1–5 each has its own point value).
 * Command schema: dynamic array — admin adds any command name with a point value.
 * Rewards: each entry has optional roleId and optional text label.
 */

'use strict';

const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    MessageFlags,
} = require('discord.js');

const guildDb = require('../dashboard/utils/guildDb');

// ── Default configuration ────────────────────────────────────────────────
const DEFAULT_CONFIG = {
    enabled: false,
    ticketPoints: {
        enabled: false,
        claim: { enabled: true, points: 5 },
        close: { enabled: true, points: 3 },
    },
    ratingPoints: {
        enabled: false,
        // Per-star point values (can be 0 or negative)
        stars: { 5: 10, 4: 5, 3: 0, 2: -2, 1: -5 },
    },
    commandPoints: {
        enabled: false,
        // Dynamic array: [{ id, name, points }]
        commands: [],
    },
    logsChannelId: null,
    antiAbuse: {
        enabled: true,
        noSelfClaim: true,
        noSelfRate: true,
        noDuplicatePoints: true,
        cooldownMinutes: 60,
    },
    rewards: {
        enabled: false,
        // [{ id, points, roleId?, label? }]
        list: [],
    },
};

// ── Config helpers ───────────────────────────────────────────────────────

function getConfig(guildId) {
    const saved = guildDb.read(guildId, 'staff_points', {});
    return _deepMerge(DEFAULT_CONFIG, saved);
}

function getScores(guildId) {
    return guildDb.read(guildId, 'staff_scores', {});
}

function saveScores(guildId, data) {
    guildDb.write(guildId, 'staff_scores', data);
}

// ── Core: award / deduct points ──────────────────────────────────────────

/**
 * Award (or deduct if negative) points for a staff member.
 * Handles CV2 log + reward checks.
 */
async function awardPoints(client, guildId, staffId, delta, reason, meta = {}) {
    const config = getConfig(guildId);
    if (!config.enabled) return;

    const scores = getScores(guildId);
    if (!scores[staffId]) scores[staffId] = { points: 0, history: [], lastActions: {} };

    const entry = scores[staffId];
    entry.points = (entry.points || 0) + delta;
    if (!entry.history) entry.history = [];

    entry.history.push({ delta, reason, ...meta, at: new Date().toISOString() });
    if (entry.history.length > 100) entry.history = entry.history.slice(-100);

    saveScores(guildId, scores);

    if (config.logsChannelId && client) {
        await _sendLog(client, guildId, staffId, delta, reason, entry.points, config).catch(() => {});
    }

    if (config.rewards?.enabled && config.rewards.list?.length > 0 && client) {
        await _checkRewards(client, guildId, staffId, entry.points, config).catch(() => {});
    }
}

// ── Specialised award functions ──────────────────────────────────────────

/**
 * Award points based on per-star ticket rating.
 * Called from systems/ticket_feedback.js.
 *
 * @param {import('discord.js').Client|null} client
 * @param {string} guildId
 * @param {string|null} claimedById  – staff who claimed the ticket
 * @param {number} rating  – 1–5 stars
 * @param {string} ticketId
 * @param {string} voterId – user who rated (ticket opener)
 */
async function awardRatingPoints(client, guildId, claimedById, rating, ticketId, voterId) {
    if (!claimedById) return;
    const config = getConfig(guildId);
    if (!config.enabled || !config.ratingPoints?.enabled) return;

    const rp = config.ratingPoints;

    // Anti-abuse: no self-rating
    if (config.antiAbuse?.enabled && config.antiAbuse?.noSelfRate && voterId === claimedById) return;

    // Anti-abuse: deduplicate per (voter, ticket)
    const dedupeKey = `rate_${voterId}_${ticketId}`;
    if (config.antiAbuse?.enabled && config.antiAbuse?.noDuplicatePoints) {
        const scores = getScores(guildId);
        const staffEntry = scores[claimedById] || {};
        if (staffEntry.lastActions?.[dedupeKey]) return;
        if (!staffEntry.lastActions) staffEntry.lastActions = {};
        staffEntry.lastActions[dedupeKey] = new Date().toISOString();
        saveScores(guildId, { ...scores, [claimedById]: staffEntry });
    }

    // Resolve points: new per-star schema first, fall back to old threshold schema
    let delta = 0;
    const clampedRating = Math.min(5, Math.max(1, Math.round(rating)));

    if (rp.stars) {
        delta = Number(rp.stars[clampedRating] ?? rp.stars[String(clampedRating)] ?? 0);
    } else {
        // Backward compat: old threshold schema
        if (clampedRating >= (rp.positiveThreshold ?? 4)) {
            delta = Number(rp.positivePoints) || 10;
        } else if (clampedRating <= (rp.negativeThreshold ?? 2)) {
            delta = Number(rp.negativePoints) || -5;
        }
    }

    if (delta === 0) return; // neutral — no change

    const stars = '⭐'.repeat(clampedRating);
    const reason = `تقييم التذكرة (${stars})`;

    await awardPoints(client, guildId, claimedById, delta, reason, { ticketId, voterId, rating: clampedRating });
}

/**
 * Award points for ticket claim or close.
 */
async function awardTicketPoints(client, guildId, staffId, action, ticketId, openerId = null) {
    const config = getConfig(guildId);
    if (!config.enabled || !config.ticketPoints?.enabled) return;

    const actionCfg = config.ticketPoints[action];
    if (!actionCfg?.enabled) return;

    // Anti-abuse: no self-claim
    if (action === 'claim' && config.antiAbuse?.enabled && config.antiAbuse?.noSelfClaim && openerId && openerId === staffId) return;

    const dedupeKey = `${action}_${ticketId}`;
    if (config.antiAbuse?.enabled && config.antiAbuse?.noDuplicatePoints) {
        const scores = getScores(guildId);
        const staffEntry = scores[staffId] || {};
        if (staffEntry.lastActions?.[dedupeKey]) return;
        if (!staffEntry.lastActions) staffEntry.lastActions = {};
        staffEntry.lastActions[dedupeKey] = new Date().toISOString();
        saveScores(guildId, { ...scores, [staffId]: staffEntry });
    }

    const delta  = Number(actionCfg.points) || (action === 'claim' ? 5 : 3);
    const reason = action === 'claim' ? 'استلام تذكرة' : 'إغلاق تذكرة';

    await awardPoints(client, guildId, staffId, delta, reason, { ticketId, action });
}

/**
 * Award points for a moderation command.
 * Looks up the command in the dynamic commands array.
 *
 * @param {import('discord.js').Client|null} client
 * @param {string} guildId
 * @param {string} staffId
 * @param {string} command – command name e.g. 'ban', 'kick'
 * @param {string|null} [targetId]
 */
async function awardCommandPoints(client, guildId, staffId, command, targetId = null) {
    const config = getConfig(guildId);
    if (!config.enabled || !config.commandPoints?.enabled) return;

    const cmds = config.commandPoints.commands;

    // Support both new array format and legacy dict format
    let cmdCfg;
    if (Array.isArray(cmds)) {
        cmdCfg = cmds.find(c => c.name === command);
    } else if (cmds && typeof cmds === 'object') {
        // Legacy schema: { ban: { enabled, points }, ... }
        const legacy = cmds[command];
        if (legacy?.enabled) cmdCfg = { name: command, points: legacy.points };
    }
    if (!cmdCfg) return;

    const delta  = Number(cmdCfg.points) || 1;
    const reason = `أمر إداري: /${command}`;

    await awardPoints(client, guildId, staffId, delta, reason, { command, targetId });
}

/**
 * Sorted leaderboard for a guild.
 */
function getLeaderboard(guildId) {
    const scores = getScores(guildId);
    return Object.entries(scores)
        .map(([userId, data]) => ({ userId, points: data.points || 0 }))
        .sort((a, b) => b.points - a.points);
}

// ── Internal helpers ─────────────────────────────────────────────────────

async function _sendLog(client, guildId, staffId, delta, reason, totalPoints, config) {
    try {
        const guild   = client.guilds.cache.get(guildId);
        const channel = guild?.channels.cache.get(config.logsChannelId);
        if (!channel) return;

        const isPos = delta >= 0;
        const color = isPos ? 0x57f287 : 0xed4245;
        const sign  = isPos ? '+' : '';

        const container = new ContainerBuilder().setAccentColor(color);
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `## ${isPos ? '📈' : '📉'} تحديث نقاط الإدارة`
            )
        );
        container.addSeparatorComponents(new SeparatorBuilder());
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `<@${staffId}> — **${sign}${delta} نقطة**\n` +
                `-# ${reason} • الرصيد الكلي: **${totalPoints} نقطة**`
            )
        );

        await channel.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
    } catch (_) { /* non-critical */ }
}

async function _checkRewards(client, guildId, staffId, totalPoints, config) {
    try {
        const guild  = client?.guilds.cache.get(guildId);
        const member = await guild?.members.fetch(staffId).catch(() => null);
        if (!member) return;

        for (const reward of (config.rewards.list || [])) {
            if (!reward.points || totalPoints < reward.points) continue;

            // Grant role if specified
            if (reward.roleId) {
                const role = guild.roles.cache.get(reward.roleId);
                if (role && !member.roles.cache.has(reward.roleId)) {
                    await member.roles.add(role).catch(() => {});
                }
            }

            // Log notification
            if (config.logsChannelId && (reward.roleId || reward.label)) {
                const channel = guild.channels.cache.get(config.logsChannelId);
                if (!channel) continue;

                const rolePart  = reward.roleId ? `\n<@&${reward.roleId}>` : '';
                const labelPart = reward.label  ? `\n-# ${reward.label}` : '';

                const container = new ContainerBuilder().setAccentColor(0xf59e0b);
                container.addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`## 🏅 مكافأة نقاط الإدارة`)
                );
                container.addSeparatorComponents(new SeparatorBuilder());
                container.addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `<@${staffId}> وصل إلى **${reward.points} نقطة**!` +
                        rolePart + labelPart
                    )
                );
                await channel.send({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
            }
        }
    } catch (_) { /* non-critical */ }
}

// ── Deep merge utility ───────────────────────────────────────────────────

function _deepMerge(defaults, overrides) {
    const result = { ...defaults };
    for (const key of Object.keys(overrides)) {
        if (overrides[key] !== null && typeof overrides[key] === 'object' && !Array.isArray(overrides[key])
            && defaults[key] !== null && typeof defaults[key] === 'object' && !Array.isArray(defaults[key])) {
            result[key] = _deepMerge(defaults[key], overrides[key]);
        } else {
            result[key] = overrides[key];
        }
    }
    return result;
}

// ── Exports ──────────────────────────────────────────────────────────────

module.exports = {
    DEFAULT_CONFIG,
    getConfig,
    getScores,
    saveScores,
    awardPoints,
    awardRatingPoints,
    awardTicketPoints,
    awardCommandPoints,
    getLeaderboard,
};
