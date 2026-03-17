/*
 * Guild activity tracker — records hourly events per guild.
 * Data stored at dashboard/database/<guildId>/activity.json
 * Tracks: joins, leaves, messages, voice (new connection)
 */

const path = require('path');
const fs   = require('fs');

const DB_BASE = path.join(__dirname, '../database');

function getFilePath(guildId) {
    return path.join(DB_BASE, guildId, 'activity.json');
}

function readData(guildId) {
    try {
        const f = getFilePath(guildId);
        return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    } catch { return {}; }
}

function writeData(guildId, data) {
    try {
        const dir = path.join(DB_BASE, guildId);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(getFilePath(guildId), JSON.stringify(data));
    } catch (_) {}
}

function getKey() {
    const now  = new Date();
    const date = now.toISOString().slice(0, 10);               // YYYY-MM-DD
    const hour = now.getUTCHours().toString().padStart(2, '0'); // 00-23
    return { date, hour };
}

/**
 * Increment a counter for the current hour.
 * @param {string} guildId
 * @param {'joins'|'leaves'|'messages'|'voice'} field
 */
function increment(guildId, field) {
    if (!guildId) return;
    const data         = readData(guildId);
    const { date, hour } = getKey();
    if (!data[date]) data[date] = {};
    if (!data[date][hour]) data[date][hour] = { joins: 0, leaves: 0, messages: 0, voice: 0 };
    data[date][hour][field] = (data[date][hour][field] || 0) + 1;

    // Prune: keep only the last 3 days to avoid file bloat
    const keys = Object.keys(data).sort();
    while (keys.length > 3) delete data[keys.shift()];

    writeData(guildId, data);
}

/**
 * Return last 24 hours of activity as parallel arrays (index 0 = oldest hour).
 * @param {string} guildId
 * @returns {{ joins: number[], leaves: number[], messages: number[], voice: number[], labels: string[] }}
 */
function getLast24h(guildId) {
    const data   = readData(guildId);
    const result = { joins: [], leaves: [], messages: [], voice: [], labels: [] };
    const now    = new Date();

    for (let i = 23; i >= 0; i--) {
        const d    = new Date(now.getTime() - i * 3_600_000);
        const date = d.toISOString().slice(0, 10);
        const hour = d.getUTCHours().toString().padStart(2, '0');
        const h    = d.getUTCHours();
        const entry = (data[date] && data[date][hour]) || {};
        result.joins.push(entry.joins || 0);
        result.leaves.push(entry.leaves || 0);
        result.messages.push(entry.messages || 0);
        result.voice.push(entry.voice || 0);
        result.labels.push(`${h}:00`);
    }
    return result;
}

/**
 * Sum of today's events.
 * @param {string} guildId
 */
function getTodayTotals(guildId) {
    const data  = readData(guildId);
    const today = new Date().toISOString().slice(0, 10);
    const day   = data[today] || {};
    const out   = { joins: 0, leaves: 0, messages: 0, voice: 0 };
    for (const h of Object.values(day)) {
        out.joins    += h.joins    || 0;
        out.leaves   += h.leaves   || 0;
        out.messages += h.messages || 0;
        out.voice    += h.voice    || 0;
    }
    return out;
}

/**
 * Sum of yesterday's events (for % comparison).
 */
function getYesterdayTotals(guildId) {
    const data      = readData(guildId);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const day       = data[yesterday] || {};
    const out       = { joins: 0, leaves: 0, messages: 0, voice: 0 };
    for (const h of Object.values(day)) {
        out.joins    += h.joins    || 0;
        out.leaves   += h.leaves   || 0;
        out.messages += h.messages || 0;
        out.voice    += h.voice    || 0;
    }
    return out;
}

module.exports = { increment, getLast24h, getTodayTotals, getYesterdayTotals };
