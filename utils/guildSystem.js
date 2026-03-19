/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

/**
 * Per-guild system config manager.
 *
 * Each guild can override the global settings.json→system block.
 * Stored in: database/guilds/{guildId}/system.json
 *
 * Supported overrides:
 *   PREFIX, COMMANDS.ENABLE_PREFIX, COMMANDS.ENABLE_SLASH_COMMANDS,
 *   COMMANDS.ACTIVITY_TYPE, COMMANDS.STATUS, COMMANDS.lang
 */

const fs   = require('fs');
const path = require('path');

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

function cfgPath(guildId) {
    return path.join(__dirname, '..', 'dashboard', 'database', guildId, 'system.json');
}

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
        const p = cfgPath(guildId);
        if (fs.existsSync(p)) {
            try { guildData = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
        }
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
    const p   = cfgPath(guildId);
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let data = {};
    if (fs.existsSync(p)) {
        try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    }

    if (updates.COMMANDS) {
        data.COMMANDS = { ...(data.COMMANDS || {}), ...updates.COMMANDS };
        const rest = { ...updates };
        delete rest.COMMANDS;
        Object.assign(data, rest);
    } else {
        Object.assign(data, updates);
    }

    fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

module.exports = { resolve, set };


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */