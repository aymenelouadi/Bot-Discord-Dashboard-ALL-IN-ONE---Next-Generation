/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

/**
 * Per-guild command config manager.
 *
 * Each guild gets its own file: database/guilds/{guildId}/commands.json
 * Guild-level settings override the global settings.json defaults.
 *
 * Fields that can be overridden per-guild:
 *   enabled, aliases, ignoredChannels, ignoredRoles,
 *   enabledChannels, allowedRoles, autoDeleteAuthor, autoDeleteReply
 */

const fs   = require('fs');
const path = require('path');

function cfgPath(guildId) {
    return path.join(__dirname, '..', 'dashboard', 'database', guildId, 'commands.json');
}

/**
 * Get the raw per-guild config for one command (or the full guild object).
 * @param {string} guildId
 * @param {string} [cmdKey]
 * @returns {object}
 */
function get(guildId, cmdKey) {
    if (!guildId) return {};
    const p = cfgPath(guildId);
    if (!fs.existsSync(p)) return {};
    try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        return cmdKey ? (data[cmdKey] || {}) : data;
    } catch {
        return {};
    }
}

/**
 * Initialise a guild's commands.json from settings.json defaults.
 * Only adds keys that are not already present (never overwrites existing guild settings).
 * @param {string} guildId
 */
function init(guildId) {
    if (!guildId) return;
    const settingsUtil = require('./settings');
    const actions = settingsUtil.get().actions || {};

    const p   = cfgPath(guildId);
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let data = {};
    if (fs.existsSync(p)) {
        try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    }

    let changed = false;
    for (const [key, cfg] of Object.entries(actions)) {
        if (data[key]) continue; // already has guild-level entry — skip
        data[key] = {
            enabled:              typeof cfg.enabled === 'boolean' ? cfg.enabled : true,
            aliases:              Array.isArray(cfg.aliases) ? [...cfg.aliases] : [],
            ignoredChannels:     [],
            ignoredRoles:        [],
            enabledChannels:     [],
            allowedRoles:        [],
            allowedUsers:        [],
            requireAdministrator: false,
            autoDeleteAuthor:    false,
            autoDeleteReply:     false,
        };
        changed = true;
    }

    if (changed) fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

/**
 * Merge-write updates for one command into the guild config.
 * @param {string} guildId
 * @param {string} cmdKey
 * @param {object} updates
 */
function set(guildId, cmdKey, updates) {
    const p   = cfgPath(guildId);
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let data = {};
    if (fs.existsSync(p)) {
        try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    }
    data[cmdKey] = { ...(data[cmdKey] || {}), ...updates };
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

/**
 * Resolve the effective config for a command in a guild.
 * Guild settings take precedence over global settings.json.
 * @param {string} guildId
 * @param {string} cmdKey
 * @returns {object} merged config
 */
function resolve(guildId, cmdKey) {
    const settingsUtil = require('./settings');
    const global = settingsUtil.get().actions?.[cmdKey] || {};
    const guild  = get(guildId, cmdKey);
    return { ...global, ...guild };
}

/**
 * Get all public commands for a guild, merged with global defaults.
 * @param {string} guildId
 * @returns {Array<{ key: string, ...config }>}
 */
function resolveAllPublic(guildId) {
    const settingsUtil = require('./settings');
    const guildData    = get(guildId);
    const actions      = settingsUtil.get().actions || {};

    return Object.entries(actions)
        .filter(([, v]) => v.public === true)
        .map(([key, globalCfg]) => ({
            key,
            ...globalCfg,
            ...(guildData[key] || {}),
        }));
}

/**
 * Get all admin commands for a guild, merged with global defaults.
 * @param {string} guildId
 * @returns {Array<{ key: string, ...config }>}
 */
function resolveAllAdmin(guildId) {
    const settingsUtil = require('./settings');
    const guildData    = get(guildId);
    const actions      = settingsUtil.get().actions || {};

    return Object.entries(actions)
        .filter(([, v]) => v.admin === true)
        .map(([key, globalCfg]) => ({
            key,
            ...globalCfg,
            ...(guildData[key] || {}),
        }));
}

module.exports = { get, set, init, resolve, resolveAllPublic, resolveAllAdmin };


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */