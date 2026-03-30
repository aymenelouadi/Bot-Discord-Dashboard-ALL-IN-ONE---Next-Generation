/**
 * Per-guild command config manager.
 *
 * Each guild gets its own commands config stored in MongoDB via guildDb
 * (under Guild.settings.commandsConfig).
 * Guild-level settings override the global settings.json defaults.
 *
 * Fields that can be overridden per-guild:
 *   enabled, aliases, ignoredChannels, ignoredRoles,
 *   enabledChannels, allowedRoles, autoDeleteAuthor, autoDeleteReply
 */

/**
 * Get the raw per-guild config for one command (or the full guild object).
 * @param {string} guildId
 * @param {string} [cmdKey]
 * @returns {object}
 */
function get(guildId, cmdKey) {
    if (!guildId) return {};
    const guildDb = require('../dashboard/utils/guildDb');
    const data = guildDb.read(guildId, 'commands', {});
    return cmdKey ? (data[cmdKey] || {}) : data;
}

/**
 * Initialise a guild's command config from settings.json defaults.
 * Only adds keys that are not already present (never overwrites existing guild settings).
 * @param {string} guildId
 */
function init(guildId) {
    if (!guildId) return;
    const guildDb      = require('../dashboard/utils/guildDb');
    const settingsUtil = require('./settings');
    const actions      = settingsUtil.get().actions || {};

    const data    = guildDb.read(guildId, 'commands', {});
    let changed   = false;

    for (const [key, cfg] of Object.entries(actions)) {
        if (data[key]) continue;
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

    if (changed) guildDb.write(guildId, 'commands', data);
}

/**
 * Merge-write updates for one command into the guild config.
 * @param {string} guildId
 * @param {string} cmdKey
 * @param {object} updates
 */
function set(guildId, cmdKey, updates) {
    const guildDb = require('../dashboard/utils/guildDb');
    const data    = guildDb.read(guildId, 'commands', {});
    data[cmdKey]  = { ...(data[cmdKey] || {}), ...updates };
    guildDb.write(guildId, 'commands', data);
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
