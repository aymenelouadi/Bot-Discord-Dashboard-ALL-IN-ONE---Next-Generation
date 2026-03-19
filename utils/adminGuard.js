/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

/**
 * Admin Guard — per-guild permission checks for moderation commands.
 *
 * Supports 3 permission types (any one grants access):
 *   1. requireAdministrator — member has the Administrator permission
 *   2. allowedRoles         — member has at least one listed role
 *   3. allowedUsers         — member's user ID is in the list
 *
 * Also checks standard gate rules:
 *   enabled, ignoredChannels, enabledChannels, ignoredRoles
 *
 * After execution, call cleanup() to handle autoDeleteAuthor / autoDeleteReply.
 */

const { PermissionFlagsBits } = require('discord.js');
const guildCmds   = require('./guildCmds');
const guildSystem = require('./guildSystem');

const CV2 = 1 << 15;   // MessageFlags.IsComponentsV2
const C   = { Container: 17, Text: 10 };

const DENY_MSG = {
    disabled:        { ar: '⛔  هذا الأمر معطل حالياً', en: '⛔  This command is currently disabled' },
    no_permission:   { ar: '🚫  ليس لديك صلاحية لاستخدام هذا الأمر', en: '🚫  You do not have permission to use this command' },
    ignored_channel: { ar: '🔇  لا يمكن استخدام هذا الأمر في هذه القناة', en: '🔇  This command cannot be used in this channel' },
    wrong_channel:   { ar: '📍  هذا الأمر مقيد بقنوات معينة فقط', en: '📍  This command is restricted to specific channels' },
    ignored_role:    { ar: '🚫  رتبتك لا تسمح باستخدام هذا الأمر', en: '🚫  Your role is not allowed to use this command' },
};

/**
 * Check whether an admin command may run.
 * @param {string}      cmdKey    - settings.json action key (e.g. 'ban')
 * @param {string}      guildId
 * @param {string}      channelId
 * @param {GuildMember} member
 * @returns {{ ok: boolean, reason?: string, cfg: object }}
 */
function check(cmdKey, guildId, channelId, member) {
    const cfg = guildCmds.resolve(guildId, cmdKey);

    // 1. Disabled
    if (cfg.enabled === false)
        return { ok: false, reason: 'disabled', cfg };

    // 2. Ignored channels (blacklist)
    if (cfg.ignoredChannels?.length && cfg.ignoredChannels.includes(channelId))
        return { ok: false, reason: 'ignored_channel', cfg };

    // 3. Enabled channels (whitelist)
    if (cfg.enabledChannels?.length && !cfg.enabledChannels.includes(channelId))
        return { ok: false, reason: 'wrong_channel', cfg };

    const roles = member?.roles?.cache;

    // 4. Ignored roles (blacklist)
    if (roles && cfg.ignoredRoles?.length && cfg.ignoredRoles.some(id => roles.has(id)))
        return { ok: false, reason: 'ignored_role', cfg };

    // 5. Permission check — 3-type system
    const hasAdminReq = cfg.requireAdministrator === true;
    const hasRoles    = cfg.allowedRoles?.length > 0;
    const hasUsers    = cfg.allowedUsers?.length > 0;

    // No restrictions configured → default to Administrator permission
    if (!hasAdminReq && !hasRoles && !hasUsers) {
        if (member && !member.permissions.has(PermissionFlagsBits.Administrator))
            return { ok: false, reason: 'no_permission', cfg };
        return { ok: true, cfg };
    }

    const isAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
    const roleOk  = hasRoles && roles && cfg.allowedRoles.some(id => roles.has(id));
    const userOk  = hasUsers && cfg.allowedUsers.some(u => (u?.id ?? u) === member?.user?.id);

    if ((hasAdminReq && isAdmin) || roleOk || userOk)
        return { ok: true, cfg };

    return { ok: false, reason: 'no_permission', cfg };
}

/**
 * Send a CV2 denial card.
 * Slash → ephemeral (flags 64).
 * Text  → channel message that self-deletes after 6 s.
 */
async function deny(ctx, reason) {
    const guildId = ctx.guild?.id ?? ctx.guildId;
    const gs      = guildSystem.resolve(guildId);
    const lang    = gs?.COMMANDS?.lang || 'en';
    const label   = (DENY_MSG[reason] ?? DENY_MSG.no_permission)[lang];
    const isSlash = ctx.isCommand?.();

    const payload = {
        flags: CV2,
        components: [{
            type: C.Container,
            accent_color: 0xef4444,
            components: [{ type: C.Text, content: label }],
        }],
    };

    if (isSlash) {
        return ctx.reply({ ...payload, flags: CV2 | 64 }).catch(() => {});
    }
    const msg = await ctx.channel.send(payload).catch(() => null);
    if (msg) setTimeout(() => msg.delete().catch(() => {}), 6000);
}

/**
 * Post-execution cleanup (auto-delete).
 * @param {object}          cfg       - resolved command config
 * @param {Message|null}    authorMsg - original user message
 * @param {Message|null}    botReply  - the bot's reply/send
 */
async function cleanup(cfg, authorMsg, botReply) {
    if (cfg.autoDeleteAuthor && authorMsg?.deletable)
        setTimeout(() => authorMsg.delete().catch(() => {}), 600);
    if (cfg.autoDeleteReply && botReply?.deletable)
        setTimeout(() => botReply.delete().catch(() => {}), 8000);
}

module.exports = { check, deny, cleanup };


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */