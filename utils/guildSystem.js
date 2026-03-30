/**
 * Per-guild system config manager.
 *
 * Each guild can override the global settings.json→system block.
 * Data stored in MongoDB via guildDb (Guild.system field).
 *
 * Supported overrides:
 *   PREFIX, COMMANDS.ENABLE_PREFIX, COMMANDS.ENABLE_SLASH_COMMANDS,
 *   COMMANDS.ACTIVITY_TYPE, COMMANDS.STATUS, COMMANDS.lang
 */

const DEFAULTS = {
    PREFIX: '!',
    COMMANDS: {
        ENABLE_PREFIX:         true,
        ENABLE_SLASH_COMMANDS: true,
        ACTIVITY_TYPE:         'none',
        STATUS:                'ONLINE',
        lang:                  'en',
    },
};

/**
 * Resolve effective system config for a guild.
 * Priority: guild override > global settings.json > built-in defaults.
 * @param {string} [guildId]
 * @returns {{ PREFIX: string, COMMANDS: object }}
 */
function resolve(guildId) {
    const settingsUtil = require('./settings');
    const global       = settingsUtil.get().system || {};

    let guildData = {};
    if (guildId) {
        const guildDb = require('../dashboard/utils/guildDb');
        guildData = guildDb.read(guildId, 'system', {});
    }

    return {
        PREFIX: guildData.PREFIX ?? global.PREFIX ?? DEFAULTS.PREFIX,
        COMMANDS: {
            ...DEFAULTS.COMMANDS,
            ...(global.COMMANDS || {}),
            ...(guildData.COMMANDS || {}),
        },
    };
}

/**
 * Write per-guild system overrides (deep-merges COMMANDS sub-object).
 * @param {string} guildId
 * @param {object} updates  e.g. { PREFIX: '?', COMMANDS: { lang: 'ar' } }
 */
function set(guildId, updates) {
    const guildDb = require('../dashboard/utils/guildDb');
    const data    = guildDb.read(guildId, 'system', {});

    if (updates.COMMANDS) {
        data.COMMANDS = { ...(data.COMMANDS || {}), ...updates.COMMANDS };
        const rest = { ...updates };
        delete rest.COMMANDS;
        Object.assign(data, rest);
    } else {
        Object.assign(data, updates);
    }

    guildDb.write(guildId, 'system', data);
}

module.exports = { resolve, set };
