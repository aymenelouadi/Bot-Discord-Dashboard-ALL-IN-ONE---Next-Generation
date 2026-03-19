/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

/**
 * Command translation loader.
 *
 * Lang files live in: commands/lang/{lang}.json
 * Falls back to 'en' when a key is missing or lang file not found.
 *
 * Usage:
 *   const { t } = require('./cmdLang');
 *   t('ar', 'system.maintenance')
 *   t('en', 'afk.enabled')
 *   t('en', 'afk.duration', { time: '5m' })  →  "You were AFK for 5m"
 */

const path = require('path');

const _cache = {};

function _load(lang) {
    if (_cache[lang]) return _cache[lang];
    try {
        // Use require so Node caches it; clear with delete require.cache for hot reload
        const p = path.join(__dirname, '../commands/lang', `${lang}.json`);
        _cache[lang] = require(p);
    } catch {
        if (lang !== 'en') return _load('en');
        _cache[lang] = {};
    }
    return _cache[lang];
}

function _get(data, dotKey) {
    return dotKey.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), data);
}

/**
 * Get a translated string.
 * @param {string} lang   - 'en' | 'ar'
 * @param {string} key    - dot-notation key e.g. 'system.maintenance'
 * @param {object} [vars] - substitution variables e.g. { time: '5m' }
 * @returns {string}
 */
function t(lang, key, vars = {}) {
    let str = _get(_load(lang), key);
    if (str === undefined && lang !== 'en') str = _get(_load('en'), key);
    if (str === undefined) return `[${key}]`;
    return str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : `{${k}}`));
}

/**
 * Resolve lang for a guild (helper shortcut).
 * @param {string} [guildId]
 * @returns {string}
 */
function langOf(guildId) {
    try {
        return require('./guildSystem').resolve(guildId).COMMANDS.lang || 'en';
    } catch {
        return 'en';
    }
}

module.exports = { t, langOf };


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */