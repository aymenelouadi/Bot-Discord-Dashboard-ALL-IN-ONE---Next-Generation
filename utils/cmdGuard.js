/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

/**
 * Command Guard — centralised per-guild runtime checks for public commands.
 *
 * Checks (in order):
 *   1. Command is enabled
 *   2. Channel not in ignoredChannels
 *   3. Channel in enabledChannels (if list is non-empty)
 *   4. Member does not have an ignoredRole
 *   5. Member has at least one allowedRole (if list is non-empty)
 *
 * After the command runs, call cleanup() to handle autoDeleteAuthor /
 * autoDeleteReply.
 */

const guildCmds   = require('./guildCmds');
const guildSystem = require('./guildSystem');
const cmdLang     = require('./cmdLang');

/**
 * Check whether a command may run.
 *
 * @param {string}      cmdKey    - settings.json action key  (e.g. 'ping')
 * @param {string}      guildId
 * @param {string}      channelId
 * @param {GuildMember} member    - may be null (DMs / missing cache)
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

    // 5. Allowed roles (whitelist)
    if (roles && cfg.allowedRoles?.length && !cfg.allowedRoles.some(id => roles.has(id)))
        return { ok: false, reason: 'no_permission', cfg };

    return { ok: true, cfg };
}

/**
 * Send a short denial notice.
 * Slash → ephemeral reply.
 * Text  → visible reply that self-deletes after 5 s.
 *
 * @param {Interaction|Message} ctx
 * @param {string}              reason  - key from DENY_MSG
 */
async function deny(ctx, reason) {
    const guildId = ctx.guild?.id ?? ctx.guildId;
    const lang    = guildSystem.resolve(guildId).COMMANDS.lang || 'en';
    const content = cmdLang.t(lang, `system.${reason}`);
    const isSlash  = ctx.isCommand?.();

    if (isSlash) {
        return ctx.reply({ content, flags: 64 }).catch(() => {});
    }
    const msg = await ctx.reply(content).catch(() => null);
    if (msg) setTimeout(() => msg.delete().catch(() => {}), 5000);
}

/**
 * Post-execution cleanup (auto-delete).
 *
 * @param {object}       cfg        - resolved command config
 * @param {Message|null} authorMsg  - original user message  (text commands)
 * @param {Message|null} botReply   - the bot's reply message
 * @param {number}       [replyDelay=8000] - ms before deleting bot reply
 */
async function cleanup(cfg, authorMsg, botReply, replyDelay = 8000) {
    if (cfg.autoDeleteAuthor && authorMsg?.deletable)
        setTimeout(() => authorMsg.delete().catch(() => {}), 500);

    if (cfg.autoDeleteReply && botReply?.deletable)
        setTimeout(() => botReply.delete().catch(() => {}), replyDelay);
}

module.exports = { check, deny, cleanup };


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */