/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

/**
 * _protectionHelper.js
 * Shared helper for all anti_* protection commands.
 *
 * Handles:
 *  - Per-guild protection config read/write via guildDb
 *  - Language detection (Arabic / English) per guild
 *  - Permission check (dashboard user_permissions > OWNERS > rolesAllowed > Administrator)
 *  - Rich bilingual embed builder
 *  - Unified response sender (slash + prefix CV2)
 */

const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const settingsUtil  = require('../utils/settings');
const guildDb       = require('../dashboard/utils/guildDb');

// ──────────────────────────────────────────────────────────────────────────────
// I18n strings
// ──────────────────────────────────────────────────────────────────────────────
const i18n = {
    ar: {
        disabled:       'هذا الأمر معطل حالياً',
        noPermission:   'ليس لديك الصلاحية لاستخدام هذا الأمر',
        error:          'حدث خطأ، يرجى المحاولة لاحقاً',
        success:        'تم الحفظ بنجاح',
        enabled:        'مفعّل ✅',
        disabled_val:   'معطّل ❌',
        limit:          'الحد',
        action:         'الإجراء',
        actions:        { '1': 'كير 👢', '2': 'إزالة الرتب 🔰', '3': 'حظر 🔨' },
        fieldStatus:    'الحالة',
        fieldLimit:     'الحد المسموح به',
        fieldAction:    'الإجراء عند التجاوز',
        notApplicable:  'غير مطبّق',
        usage:          'الاستخدام',
    },
    en: {
        disabled:       'This command is currently disabled',
        noPermission:   'You do not have permission to use this command',
        error:          'An error occurred, please try again',
        success:        'Saved successfully',
        enabled:        'Enabled ✅',
        disabled_val:   'Disabled ❌',
        limit:          'Limit',
        action:         'Action',
        actions:        { '1': 'Kick 👢', '2': 'Remove Roles 🔰', '3': 'Ban 🔨' },
        fieldStatus:    'Status',
        fieldLimit:     'Action Limit',
        fieldAction:    'Punishment',
        notApplicable:  'N/A',
        usage:          'Usage',
    }
};

// ──────────────────────────────────────────────────────────────────────────────
// Language detection
// ──────────────────────────────────────────────────────────────────────────────
/**
 * Returns 'ar' or 'en' for the given guild.
 * Priority: guildDb settings → global settings.json → 'ar'
 */
function getLang(guildId) {
    try {
        const guildSettings = guildDb.read(guildId, 'settings', null);
        if (guildSettings?.lang) return guildSettings.lang === 'en' ? 'en' : 'ar';
        const global = settingsUtil.get();
        const lang = global?.system?.COMMANDS?.lang;
        return lang === 'en' ? 'en' : 'ar';
    } catch {
        return 'ar';
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Per-guild protection read/write
// ──────────────────────────────────────────────────────────────────────────────
/**
 * Read the merged protection config for a guild.
 * Guild-level (dashboard) overrides global defaults.
 */
function getProtection(guildId) {
    const global = settingsUtil.get().protection || {};
    const guild  = guildDb.read(guildId, 'protection', null);
    if (!guild) return { ...global };

    const merged = {};
    const keys = new Set([...Object.keys(global), ...Object.keys(guild)]);
    for (const k of keys) {
        const gv = global[k];
        const lv = guild[k];
        if (gv && lv && typeof gv === 'object' && !Array.isArray(gv) &&
                        typeof lv === 'object' && !Array.isArray(lv)) {
            merged[k] = { ...gv, ...lv };
        } else {
            merged[k] = (k in guild) ? lv : gv;
        }
    }
    return merged;
}

/**
 * Write a partial update to the per-guild protection data.
 * Only the keys provided in `patch` are changed.
 */
function saveProtection(guildId, patch) {
    const current = guildDb.read(guildId, 'protection', {});
    const updated = { ...current };
    for (const [k, v] of Object.entries(patch)) {
        if (
            v !== null && typeof v === 'object' && !Array.isArray(v) &&
            current[k] !== null && typeof current[k] === 'object' && !Array.isArray(current[k])
        ) {
            updated[k] = { ...current[k], ...v }; // deep-merge per feature key
        } else {
            updated[k] = v;
        }
    }
    guildDb.write(guildId, 'protection', updated);
    return updated;
}

// ──────────────────────────────────────────────────────────────────────────────
// Permission check
// ──────────────────────────────────────────────────────────────────────────────
/**
 * Returns true if the member is allowed to configure protection in this guild.
 *
 * Priority:
 *  1. Bot owner (DASHBOARD.OWNERS)
 *  2. Guild dashboard user_permissions list
 *  3. Command-specific rolesAllowed (settings.actions[commandName].rolesAllowed)
 *  4. Server Administrator permission
 */
function checkPermission(member, guildId, commandName) {
    const global = settingsUtil.get();

    // 1. Global owners always allowed
    const owners = global?.DASHBOARD?.OWNERS || [];
    if (owners.includes(member.id)) return true;

    // 2. Dashboard user_permissions for this guild
    const guildProtection = guildDb.read(guildId, 'protection', {});
    const userPerms = guildProtection?.user_permissions || [];
    if (userPerms.includes(member.id)) return true;

    // 3. Command-specific roles
    const commandCfg = global?.actions?.[commandName];
    if (commandCfg?.rolesAllowed?.length > 0) {
        if (commandCfg.rolesAllowed.some(r => member.roles.cache.has(r))) return true;
    }

    // 4. Administrator fallback
    return member.permissions.has(PermissionFlagsBits.Administrator);
}

/**
 * Returns true if the command is enabled globally.
 */
function isCommandEnabled(commandName) {
    const global = settingsUtil.get();
    return global?.actions?.[commandName]?.enabled !== false;
}

// ──────────────────────────────────────────────────────────────────────────────
// Embed builder
// ──────────────────────────────────────────────────────────────────────────────
/**
 * Build a rich embed for a protection command response.
 *
 * @param {object} opts
 * @param {string} opts.guildId
 * @param {string} opts.protectionKey       e.g. 'anti_ban'
 * @param {string} opts.titleAr
 * @param {string} opts.titleEn
 * @param {boolean} opts.enabled
 * @param {number|null} opts.limit          null for no-limit features (anti_bots, anti_webhooks)
 * @param {string} opts.action              '1' | '2' | '3'
 * @param {string} opts.lang                'ar' | 'en'
 */
function buildEmbed({ guildId, protectionKey, titleAr, titleEn, enabled, limit, action, lang }) {
    const t = i18n[lang] || i18n.ar;
    const title = lang === 'en' ? titleEn : titleAr;
    const color = 0x7c3aed;

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`🛡️ ${title}`)
        .setTimestamp()
        .addFields(
            {
                name: t.fieldStatus,
                value: enabled ? t.enabled : t.disabled_val,
                inline: true
            },
            {
                name: t.fieldAction,
                value: t.actions[String(action)] || String(action),
                inline: true
            }
        );

    if (limit !== null && limit !== undefined) {
        embed.addFields({
            name: t.fieldLimit,
            value: String(limit),
            inline: true
        });
    }

    embed.setFooter({ text: `Guild: ${guildId} • ${protectionKey}` });
    return embed;
}

// ──────────────────────────────────────────────────────────────────────────────
// Response sender (CV2: slash + prefix)
// ──────────────────────────────────────────────────────────────────────────────
/**
 * Send a string or embed response, supporting both slash and prefix commands.
 */
async function sendResponse(ctx, isSlash, content) {
    try {
        if (typeof content === 'string') {
            if (isSlash) {
                if (ctx.deferred || ctx.replied) {
                    return ctx.editReply({ content, embeds: [] });
                }
                return ctx.reply({ content, ephemeral: true });
            } else {
                return ctx.reply(content);
            }
        }
        // EmbedBuilder
        if (isSlash) {
            if (ctx.deferred || ctx.replied) {
                return ctx.editReply({ embeds: [content], content: '' });
            }
            return ctx.reply({ embeds: [content], ephemeral: false });
        } else {
            return ctx.reply({ embeds: [content] });
        }
    } catch (e) {
        console.error('[ProtectionHelper] sendResponse error:', e.message);
    }
}

module.exports = {
    i18n,
    getLang,
    getProtection,
    saveProtection,
    checkPermission,
    isCommandEnabled,
    buildEmbed,
    sendResponse
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */