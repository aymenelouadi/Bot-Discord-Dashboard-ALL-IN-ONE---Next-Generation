/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

/**
 * dashboardLogs.js
 * Stores and manages dashboard activity logs in MongoDB.
 * Log types: login | guild_join | guild_leave | dashboard_action
 */
'use strict';

const crypto   = require('crypto');
const https    = require('https');
const mongoose = require('mongoose');

const MAX_ENTRIES     = 500;
const CLEAR_REQ_KEY   = 'dashboard_clear_request';

/* ── Lazy MongoDB model ─────────────────────────────── */
function _getModel() {
    if (mongoose.models.SystemLog) return mongoose.models.SystemLog;
    const schema = new mongoose.Schema({}, {
        strict: false, timestamps: false, versionKey: false,
        collection: 'system_logs',
    });
    return mongoose.model('SystemLog', schema);
}

function _GlobalConfig() {
    return require('../../systems/schemas/GlobalConfig');
}

/* ── Webhook sender ──────────────────────────────────── */
function _colorToInt(hex) {
    try { return parseInt((hex || '#7c3aed').replace('#', ''), 16); } catch { return 0x7c3aed; }
}

function _buildEmbed(entry, color) {
    const typeLabels = {
        login:       '🔐 Dashboard Login',
        guild_join:  '📥 Bot Added to Server',
        guild_leave: '📤 Bot Left Server',
    };
    const title = typeLabels[entry.type] || `⚡ ${entry.type}`;
    const fields = [];
    if (entry.type === 'login') {
        fields.push({ name: 'User', value: `${entry.displayName || entry.username || '?'} \`${entry.userId || ''}\``, inline: true });
        if (entry.ip) fields.push({ name: 'IP', value: `\`${entry.ip}\``, inline: true });
    } else if (entry.type === 'guild_join') {
        fields.push({ name: 'Server', value: `${entry.guildName || '?'} \`${entry.guildId || ''}\``, inline: true });
    } else if (entry.type === 'guild_leave') {
        fields.push({ name: 'Server', value: `${entry.guildName || '?'} \`${entry.guildId || ''}\``, inline: true });
        if (entry.byUsername) fields.push({ name: 'By', value: entry.byUsername, inline: true });
        if (entry.deleteData) fields.push({ name: 'Data', value: '⚠️ Deleted', inline: true });
    }
    return {
        title,
        color: _colorToInt(color),
        fields,
        footer: { text: 'Dashboard Logs' },
        timestamp: entry.timestamp,
    };
}

// Validate that a URL is a Discord webhook (prevents SSRF)
function _isDiscordWebhook(rawUrl) {
    try {
        const u = new URL(rawUrl);
        return u.protocol === 'https:' &&
            (u.hostname === 'discord.com' || u.hostname === 'discordapp.com') &&
            u.pathname.startsWith('/api/webhooks/');
    } catch { return false; }
}

function _sendWebhook(entry) {
    try {
        const settingsUtil = require('../../utils/settings');
        const cfg = settingsUtil.get();
        const wh = cfg?.DASHBOARD?.WEBHOOK_LOG;
        if (!wh?.URL) return;
        // Security: only allow valid Discord webhook URLs (prevents SSRF)
        if (!_isDiscordWebhook(wh.URL)) return;
        const payload = JSON.stringify({
            username: 'Dashboard Logs',
            embeds: [_buildEmbed(entry, wh.COLOR || '#7c3aed')],
        });
        const url = new URL(wh.URL);
        const req  = https.request({
            hostname: url.hostname,
            path:     url.pathname + url.search,
            method:   'POST',
            headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        });
        req.on('error', () => {});
        req.write(payload);
        req.end();
    } catch (_) {}
}

/* ── Public API ───────────────────────────────────────── */

/**
 * Add a log entry (fire-and-forget safe).
 */
async function addEntry(entry) {
    try {
        const SystemLog = _getModel();
        const full = {
            id:        crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            ...entry,
        };
        await SystemLog.create(full);
        // Prune oldest if over MAX_ENTRIES
        const count = await SystemLog.countDocuments();
        if (count > MAX_ENTRIES) {
            const oldest = await SystemLog.find({}, { _id: 1 })
                .sort({ timestamp: 1 })
                .limit(count - MAX_ENTRIES)
                .lean();
            if (oldest.length) await SystemLog.deleteMany({ _id: { $in: oldest.map(d => d._id) } });
        }
        _sendWebhook(full);
    } catch (_) {}
}

/**
 * Returns { entries, clearRequest }.
 */
async function getAll() {
    try {
        const SystemLog   = _getModel();
        const GlobalConfig = _GlobalConfig();
        const [entries, crDoc] = await Promise.all([
            SystemLog.find({}, { _id: 0, __v: 0 }).sort({ timestamp: -1 }).limit(MAX_ENTRIES).lean(),
            GlobalConfig.findOne({ key: CLEAR_REQ_KEY }).lean(),
        ]);
        return { entries, clearRequest: crDoc?.data || null };
    } catch (_) { return { entries: [], clearRequest: null }; }
}

/**
 * Initiate a clear-all request.
 */
async function requestClear(userId, username, allShipIds) {
    const GlobalConfig = _GlobalConfig();
    const needed = allShipIds.map(String).filter(id => id !== String(userId));
    const data = {
        id:                crypto.randomUUID(),
        requestedBy:       String(userId),
        requestedByName:   username,
        timestamp:         new Date().toISOString(),
        needed,
        approvals:         [String(userId)],
        rejections:        [],
    };
    await GlobalConfig.findOneAndUpdate(
        { key: CLEAR_REQ_KEY },
        { $set: { key: CLEAR_REQ_KEY, data } },
        { upsert: true },
    );
    return data;
}

/**
 * Vote on an existing clear request.
 */
async function vote(userId, approve) {
    const GlobalConfig = _GlobalConfig();
    const doc = await GlobalConfig.findOne({ key: CLEAR_REQ_KEY }).lean();
    if (!doc?.data) return { error: 'no_request' };
    const req = { ...doc.data, approvals: [...doc.data.approvals], rejections: [...doc.data.rejections] };

    if (req.approvals.includes(String(userId)) || req.rejections.includes(String(userId))) {
        return { error: 'already_voted' };
    }

    if (approve) {
        req.approvals.push(String(userId));
        const allNeeded  = [req.requestedBy, ...req.needed];
        const allApproved = allNeeded.every(id => req.approvals.includes(id));
        if (allApproved) {
            const SystemLog = _getModel();
            await SystemLog.deleteMany({});
            await GlobalConfig.deleteOne({ key: CLEAR_REQ_KEY });
            return { done: true, cleared: true };
        }
        await GlobalConfig.findOneAndUpdate({ key: CLEAR_REQ_KEY }, { $set: { data: req } });
        return { done: false, pending: req };
    } else {
        req.rejections.push(String(userId));
        await GlobalConfig.deleteOne({ key: CLEAR_REQ_KEY });
        return { done: true, cleared: false, rejected: true };
    }
}

/**
 * Cancel an existing clear request (only by the requester).
 */
async function cancelRequest(userId) {
    const GlobalConfig = _GlobalConfig();
    const doc = await GlobalConfig.findOne({ key: CLEAR_REQ_KEY }).lean();
    if (!doc?.data) return { error: 'no_request' };
    if (doc.data.requestedBy !== String(userId)) return { error: 'not_owner' };
    await GlobalConfig.deleteOne({ key: CLEAR_REQ_KEY });
    return { success: true };
}

module.exports = { addEntry, getAll, requestClear, vote, cancelRequest };
