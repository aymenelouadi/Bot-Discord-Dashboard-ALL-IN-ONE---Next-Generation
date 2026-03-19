/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

/**
 * Per-guild database helper.
 *
 * Every guild gets its own folder:
 *   dashboard/database/<guildId>/
 *
 * Files inside are plain JSON (e.g. settings.json, logs.json …)
 *
 * Usage:
 *   const guildDb = require('./utils/guildDb');
 *   const data    = guildDb.read('123456789', 'settings');
 *   guildDb.write('123456789', 'settings', { prefix: '!' });
 */

const fs   = require('fs');
const path = require('path');

const DB_ROOT = path.join(__dirname, '../database');

/* Ensure the guild folder exists */
function ensureDir(guildId) {
    const dir = path.join(DB_ROOT, guildId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Read a JSON file for a guild.
 * Returns `defaultValue` (default: {}) if file doesn't exist or is invalid.
 */
function read(guildId, filename = 'settings', defaultValue = {}) {
    const dir  = ensureDir(guildId);
    const file = path.join(dir, `${filename}.json`);
    if (!fs.existsSync(file)) return defaultValue;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return defaultValue;
    }
}

/**
 * Write data as JSON for a guild.
 */
function write(guildId, filename = 'settings', data = {}) {
    const dir  = ensureDir(guildId);
    const file = path.join(dir, `${filename}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Check if a guild has any database folder (≡ bot was active in it).
 */
function exists(guildId) {
    return fs.existsSync(path.join(DB_ROOT, guildId));
}

/**
 * List all guild IDs that have a database folder.
 */
function list() {
    if (!fs.existsSync(DB_ROOT)) return [];
    return fs.readdirSync(DB_ROOT).filter(name => {
        return fs.statSync(path.join(DB_ROOT, name)).isDirectory();
    });
}

module.exports = { read, write, exists, ensureDir, list };


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */