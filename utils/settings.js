/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

/**
 * Settings Utility — Central cached settings manager.
 *
 * Usage in any command/system:
 *   const settingsUtil = require('../utils/settings');
 *
 *   // Read settings (from memory cache, not disk every time):
 *   const settings = settingsUtil.get();
 *
 *   // Save settings after modification:
 *   settings.someKey = 'newValue';
 *   settingsUtil.save(settings);
 */

const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(__dirname, '../settings.json');

let cache = null;

/**
 * Load settings from disk and update cache.
 */
function load() {
    try {
        let raw = fs.readFileSync(SETTINGS_PATH);
        // Strip UTF-8 BOM if present
        if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) raw = raw.slice(3);
        cache = JSON.parse(raw.toString('utf8'));
    } catch (e) {
        console.error('[Settings] Failed to load settings.json:', e.message);
        if (!cache) cache = {};
    }
    return cache;
}

/**
 * Get settings. Returns from cache if available, otherwise reads from disk.
 * @returns {object} settings
 */
function get() {
    if (!cache) load();
    return cache;
}

/**
 * Save a modified settings object to disk and update the cache.
 * @param {object} newSettings - The full settings object to save.
 */
function save(newSettings) {
    try {
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(newSettings, null, 4), 'utf8');
        cache = newSettings;
    } catch (e) {
        console.error('[Settings] Failed to save settings.json:', e.message);
        throw e;
    }
}

/**
 * Force reload from disk (useful after external edits).
 */
function reload() {
    cache = null;
    return load();
}

// Watch file for external changes (e.g. manual edits) and auto-reload cache.
fs.watchFile(SETTINGS_PATH, { interval: 2000 }, () => {
    console.log('[Settings] settings.json changed on disk — reloading cache...');
    reload();
});

// Initial load
load();

module.exports = { get, save, reload };


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */