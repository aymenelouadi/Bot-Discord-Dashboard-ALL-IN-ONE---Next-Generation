/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

/**
 * dashboardLogs.js
 * Stores and manages dashboard activity logs.
 * Log types: login | guild_join | guild_leave | dashboard_action
 */
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');

const LOG_FILE  = path.join(__dirname, '../data/dashboard-logs.json');
const MAX_ENTRIES = 500;

/* ── Webhook sender ──────────────────────────────── */
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

/* ── File helpers ─────────────────────────────────── */
function _read() {
    try {
        if (!fs.existsSync(LOG_FILE)) return { entries: [], clearRequest: null };
        return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    } catch { return { entries: [], clearRequest: null }; }
}

function _write(data) {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LOG_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/* ── Public API ───────────────────────────────────── */

/**
 * Add a log entry (auto-prepends, keeps max MAX_ENTRIES).
 * @param {object} entry - Fields to store (type, userId, etc.)
 */
function addEntry(entry) {
    const data = _read();
    const full = {
        id:        crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        ...entry,
    };
    data.entries.unshift(full);
    if (data.entries.length > MAX_ENTRIES) data.entries = data.entries.slice(0, MAX_ENTRIES);
    _write(data);
    _sendWebhook(full);
}

/**
 * Returns the full data object { entries, clearRequest }.
 */
function getAll() {
    return _read();
}

/**
 * Initiate a clear-all request.
 * The requester auto-approves; all other ships must also approve.
 * @param {string} userId
 * @param {string} username
 * @param {string[]} allShipIds  - All ship/owner IDs
 * @returns {object} clearRequest
 */
function requestClear(userId, username, allShipIds) {
    const data = _read();
    const needed = allShipIds.map(String).filter(id => id !== String(userId));
    data.clearRequest = {
        id:                crypto.randomUUID(),
        requestedBy:       String(userId),
        requestedByName:   username,
        timestamp:         new Date().toISOString(),
        needed,            // other ships that must approve
        approvals:         [String(userId)], // requester auto-approves
        rejections:        [],
    };
    _write(data);
    return data.clearRequest;
}

/**
 * Vote on an existing clear request.
 * @param {string} userId
 * @param {boolean} approve  true = approve, false = reject
 * @returns {{ error?, done, cleared, rejected, pending? }}
 */
function vote(userId, approve) {
    const data = _read();
    if (!data.clearRequest) return { error: 'no_request' };
    const req = data.clearRequest;

    if (req.approvals.includes(String(userId)) || req.rejections.includes(String(userId))) {
        return { error: 'already_voted' };
    }

    if (approve) {
        req.approvals.push(String(userId));
        // All ships = needed + original requester
        const allNeeded = [req.requestedBy, ...req.needed];
        const allApproved = allNeeded.every(id => req.approvals.includes(id));
        if (allApproved) {
            data.entries      = [];
            data.clearRequest = null;
            _write(data);
            return { done: true, cleared: true };
        }
        _write(data);
        return { done: false, pending: req };
    } else {
        req.rejections.push(String(userId));
        data.clearRequest = null; // cancel on any rejection
        _write(data);
        return { done: true, cleared: false, rejected: true };
    }
}

/**
 * Cancel an existing clear request (only by the requester).
 * @param {string} userId
 */
function cancelRequest(userId) {
    const data = _read();
    if (!data.clearRequest) return { error: 'no_request' };
    if (data.clearRequest.requestedBy !== String(userId)) return { error: 'not_owner' };
    data.clearRequest = null;
    _write(data);
    return { success: true };
}

module.exports = { addEntry, getAll, requestClear, vote, cancelRequest };


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */