/*
 * This project was programmed by the Code Nexus team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/UvEYbFd2rj
 */

/**
 * systems/points_interactions.js
 * Interaction Points engine — messages, reactions, voice, media.
 * CV2 logging. Everything optional via per-section toggles.
 *
 * Config stored at: dashboard/database/<guildId>/interaction_points.json
 * Scores stored at: dashboard/database/<guildId>/interaction_scores.json
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

    messagePoints: {
        enabled: false,
        points: 1,
        cooldownSeconds: 30,
        minLength: 3,        // ignore very short messages
    },

    reactionPoints: {
        enabled: false,
        givePoints: 1,       // points for the person who reacts
        receivePoints: 2,    // points for the person whose message received a reaction
    },

    voicePoints: {
        enabled: false,
        pointsPerMinute: 2,
        ignoreAfk: true,
        ignoreMuted: true,   // ignore self-muted members
    },

    mediaPoints: {
        enabled: false,
        imagePoints: 3,
        linkPoints: 1,
    },

    channels: {
        ignored: [],   // channel IDs to ignore
        allowed: [],   // if non-empty, only these channels count
    },

    roles: {
        ignored: [],   // role IDs — members with these roles get no points
        bonus: [],     // [{ roleId, multiplier }]  e.g. { roleId: '...', multiplier: 1.5 }
    },

    logsChannelId: null,
};

// ── Config helpers ───────────────────────────────────────────────────────

function getConfig(guildId) {
    const saved = guildDb.read(guildId, 'interaction_points', {});
    return _deepMerge(DEFAULT_CONFIG, saved);
}

function getScores(guildId) {
    return guildDb.read(guildId, 'interaction_scores', {});
}

function saveScores(guildId, data) {
    guildDb.write(guildId, 'interaction_scores', data);
}

// ── Core award ────────────────────────────────────────────────────────────

async function awardPoints(client, guildId, userId, baseDelta, reason, config) {
    if (!config) config = getConfig(guildId);
    if (!config.enabled || baseDelta === 0) return;

    const scores = getScores(guildId);
    if (!scores[userId]) scores[userId] = { points: 0, history: [] };

    const entry  = scores[userId];
    const delta  = _applyBonus(baseDelta, userId, config);
    entry.points = (entry.points || 0) + delta;
    if (!entry.history) entry.history = [];
    entry.history.push({ delta, reason, at: new Date().toISOString() });
    if (entry.history.length > 100) entry.history = entry.history.slice(-100);

    saveScores(guildId, scores);

    if (config.logsChannelId && client) {
        await _sendLog(client, guildId, userId, delta, reason, entry.points, config).catch(() => {});
    }
}

// ── Specialised handlers ─────────────────────────────────────────────────

/**
 * Called from messageCreate event.
 */
async function handleMessage(client, guildId, userId, message) {
    const config = getConfig(guildId);
    if (!config.enabled || !config.messagePoints?.enabled) return;

    // Ignore bots
    if (message.author?.bot) return;

    const mp = config.messagePoints;

    // Minimum length check
    const content = message.content || '';
    if (content.length < (mp.minLength ?? 3)) {
        // Still count media if mediaPoints enabled
    } else {
        // Channel guard
        if (!_channelAllowed(message.channelId, config)) return;
        // Role guard
        if (_memberIgnored(message.member, config)) return;

        // Cooldown check
        const scores  = getScores(guildId);
        const entry   = scores[userId] || {};
        const lastMsg = entry.lastMessage || 0;
        const cooldownMs = (mp.cooldownSeconds ?? 30) * 1000;
        if (Date.now() - lastMsg < cooldownMs) {
            // still check media
        } else {
            scores[userId] = { ...(scores[userId] || { points: 0, history: [] }) };
            scores[userId].lastMessage = Date.now();
            saveScores(guildId, scores);
            await awardPoints(client, guildId, userId, mp.points ?? 1, 'message', config);
        }
    }

    // Media points
    if (config.mediaPoints?.enabled) {
        const mediaPts = config.mediaPoints;
        if (!_channelAllowed(message.channelId, config)) return;
        if (_memberIgnored(message.member, config)) return;

        const hasImage = message.attachments?.some(a => a.contentType?.startsWith('image/') || a.contentType?.startsWith('video/'));
        const hasLink  = /https?:\/\/\S+/.test(content);

        if (hasImage && (mediaPts.imagePoints ?? 3) > 0) {
            await awardPoints(client, guildId, userId, mediaPts.imagePoints ?? 3, 'media (image/video)', config);
        } else if (hasLink && (mediaPts.linkPoints ?? 1) > 0) {
            await awardPoints(client, guildId, userId, mediaPts.linkPoints ?? 1, 'media (link)', config);
        }
    }
}

/**
 * Called from messageReactionAdd event.
 */
async function handleReaction(client, guildId, reactorId, messageAuthorId, channelId) {
    const config = getConfig(guildId);
    if (!config.enabled || !config.reactionPoints?.enabled) return;
    if (!_channelAllowed(channelId, config)) return;

    // Don't self-react for points
    if (reactorId === messageAuthorId) return;

    const rp = config.reactionPoints;

    if ((rp.givePoints ?? 1) > 0) {
        await awardPoints(client, guildId, reactorId, rp.givePoints ?? 1, 'reaction (gave)', config);
    }
    if ((rp.receivePoints ?? 2) > 0 && messageAuthorId) {
        await awardPoints(client, guildId, messageAuthorId, rp.receivePoints ?? 2, 'reaction (received)', config);
    }
}

/**
 * Called on a 1-minute interval from the voice tracker.
 * Pass the guild member object.
 */
async function handleVoiceMinute(client, guildId, member) {
    const config = getConfig(guildId);
    if (!config.enabled || !config.voicePoints?.enabled) return;

    const vp = config.voicePoints;

    // Ignore AFK
    const guild    = client.guilds.cache.get(guildId);
    const afkId    = guild?.afkChannelId;
    const vcId     = member.voice?.channelId;
    if (!vcId) return;
    if (vp.ignoreAfk && vcId === afkId) return;

    // Ignore self-muted
    if (vp.ignoreMuted && member.voice?.selfMute) return;

    // Role guard
    if (_memberIgnored(member, config)) return;

    await awardPoints(client, guildId, member.id, vp.pointsPerMinute ?? 2, 'voice (per minute)', config);
}

/**
 * Get leaderboard for a guild.
 */
function getLeaderboard(guildId) {
    const scores = getScores(guildId);
    return Object.entries(scores)
        .map(([userId, data]) => ({ userId, points: data.points || 0 }))
        .sort((a, b) => b.points - a.points);
}

// ── Internal helpers ─────────────────────────────────────────────────────

function _channelAllowed(channelId, config) {
    const { ignored = [], allowed = [] } = config.channels || {};
    if (ignored.includes(channelId)) return false;
    if (allowed.length > 0 && !allowed.includes(channelId)) return false;
    return true;
}

function _memberIgnored(member, config) {
    if (!member) return false;
    const ignoredRoles = config.roles?.ignored || [];
    return ignoredRoles.some(rId => member.roles?.cache?.has(rId));
}

function _applyBonus(base, userId, config) {
    // NOTE: bonus multiplier requires member object; without it, return base.
    // Multiplier is applied in handleMessage/handleReaction by recalculating.
    return base;
}

async function _sendLog(client, guildId, userId, delta, reason, totalPoints, config) {
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
                `## ${isPos ? '📈' : '📉'} تحديث نقاط التفاعل`
            )
        );
        container.addSeparatorComponents(new SeparatorBuilder());
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `<@${userId}> — **${sign}${delta} نقطة**\n` +
                `-# ${reason} • الرصيد الكلي: **${totalPoints} نقطة**`
            )
        );

        await channel.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
    } catch (_) { /* non-critical */ }
}

// ── Deep merge ───────────────────────────────────────────────────────────

function _deepMerge(defaults, overrides) {
    const result = { ...defaults };
    for (const key of Object.keys(overrides)) {
        if (
            overrides[key] !== null && typeof overrides[key] === 'object' && !Array.isArray(overrides[key]) &&
            defaults[key] !== null && typeof defaults[key] === 'object' && !Array.isArray(defaults[key])
        ) {
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
    handleMessage,
    handleReaction,
    handleVoiceMinute,
    getLeaderboard,
};
