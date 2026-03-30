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

const fs         = require('fs');
const logger = require('./logger');
const path       = require('path');
const validators = require('./validators');

const SETTINGS_PATH = path.join(__dirname, '../settings.json');
const GLOBAL_CONFIG_KEY = 'global_settings';

let cache = null;

/**
 * Load settings from JSON file (initial baseline / migration source only).
 * Never writes back to disk.
 */
function load() {
    try {
        let raw = fs.readFileSync(SETTINGS_PATH);
        // Strip UTF-8 BOM if present
        if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) raw = raw.slice(3);
        cache = JSON.parse(raw.toString('utf8'));
        const vLoad = validators.SettingsSchema.safeParse(cache);
        if (!vLoad.success)
            logger.warn('[Settings] Schema warning on load:', validators.formatError(vLoad.error));
    } catch (e) {
        logger.error('[Settings] Failed to load settings.json:', e.message);
        if (!cache) cache = {};
    }
    return cache;
}

/**
 * Load global settings from MongoDB GlobalConfig (deep-merges on top of JSON baseline).
 * Must be called once at startup after the DB is connected.
 */
async function loadFromMongoDB() {
    try {
        const mongoose = require('mongoose');
        if (mongoose.connection.readyState < 1) return;
        const GlobalConfig = require('../systems/schemas/GlobalConfig');
        const doc = await GlobalConfig.findOne({ key: GLOBAL_CONFIG_KEY }).lean();
        if (doc?.data && Object.keys(doc.data).length > 0) {
            // Deep-merge MongoDB overrides on top of JSON baseline
            if (!cache) load();
            cache = deepMerge(cache, doc.data);
            logger.info('[Settings] Global settings loaded from MongoDB');
        }
    } catch (e) {
        logger.error('[Settings] Failed to load from MongoDB:', e.message);
    }
}

function deepMerge(base, override) {
    const out = { ...base };
    for (const key of Object.keys(override)) {
        if (
            override[key] && typeof override[key] === 'object' && !Array.isArray(override[key]) &&
            base[key]    && typeof base[key]     === 'object' && !Array.isArray(base[key])
        ) {
            out[key] = deepMerge(base[key], override[key]);
        } else {
            out[key] = override[key];
        }
    }
    return out;
}

/**
 * Get settings. Returns from cache (always synchronous).
 * @returns {object} settings
 */
function get() {
    if (!cache) load();
    return cache;
}

/**
 * Save a modified settings object to MongoDB GlobalConfig and update cache.
 * Never writes to disk.
 * @param {object} newSettings - The full settings object to save.
 */
function save(newSettings) {
    // Warn on schema violations
    const vSave = validators.SettingsSchema.safeParse(newSettings);
    if (!vSave.success)
        logger.warn('[Settings] Schema warning on save:', validators.formatError(vSave.error));

    cache = newSettings;

    // Persist to MongoDB asynchronously — never blocks the caller
    _saveToMongo(newSettings).catch(e =>
        logger.error('[Settings] MongoDB save failed:', e.message)
    );
}

async function _saveToMongo(data) {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState < 1) return;
    const GlobalConfig = require('../systems/schemas/GlobalConfig');
    await GlobalConfig.findOneAndUpdate(
        { key: GLOBAL_CONFIG_KEY },
        { $set: { key: GLOBAL_CONFIG_KEY, data } },
        { upsert: true }
    );
}

/**
 * Force reload from disk (dev utility — overwrites MongoDB overrides in cache).
 */
function reload() {
    cache = null;
    return load();
}

// Initial load from JSON baseline
load();

module.exports = { get, save, reload, loadFromMongoDB };


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */