/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

﻿const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db         = require('../systems/schemas');
const logSystem  = require('../systems/log.js');
const adminGuard = require('../utils/adminGuard');
const { t, langOf } = require('../utils/cmdLang');
const validators     = require('../utils/validators');
const settingsUtil   = require('../utils/settings');

/* ── Components V2 ─────────────────────────────────── */
const CV2 = 1 << 15;
const C   = { Container: 17, Text: 10 };

/* ── Helpers ─────────────────────────────────────────── */
function genCaseId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let id = '';
    for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}



/* ── CV2 builders ────────────────────────────────────── */
function buildSuccess(user, reason, caseId, moderator, totalWarns, lang) {
    const date = new Date().toLocaleString('en-US');
    return {
        flags: CV2,
        components: [{
            type: C.Container,
            accent_color: 0xf59e0b,
            components: [{
                type: C.Text,
                content: [
                    `## ${t(lang, 'warn.title')}`,
                    ``,
                    `👤 **${t(lang, 'warn.label_target')}**  ${user.username}  (\`${user.id}\`)`,
                    `📝 **${t(lang, 'warn.label_reason')}**  ${reason}`,
                    `⚠️ **${t(lang, 'warn.total_warns')}**  ${totalWarns}`,
                    ``,
                    `\`\`\``,
                    `${t(lang, 'warn.label_case')}  ${caseId}`,
                    `\`\`\``,
                    `-# 🛡️ ${t(lang, 'warn.label_mod')}: ${moderator.username}  ·  ${date}`,
                ].join('\n'),
            }],
        }],
    };
}

function buildError(msg) {
    return {
        flags: CV2 | 64,
        components: [{
            type: C.Container,
            accent_color: 0xef4444,
            components: [{ type: C.Text, content: `⛔  ${msg}` }],
        }],
    };
}

/* ── Module ──────────────────────────────────────────── */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('warn')
        .setDescription('Issue a warning to a member')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason for the warning').setRequired(true)),
    textCommand: { name: 'warn', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash  = ctx.isCommand?.();
        const guildId  = ctx.guild?.id;
        const chanId   = isSlash ? ctx.channelId : ctx.channel.id;
        const lang     = langOf(guildId);

        /* ── Guard ─────────────────────────────────────── */
        const g = adminGuard.check('warn', guildId, chanId, ctx.member ?? null);
        if (!g.ok) return adminGuard.deny(ctx, g.reason);

        /* ── Parse inputs ──────────────────────────────── */
        let user, reason, moderator, guild;

        if (isSlash) {
            user      = ctx.options.getUser('user');
            reason    = ctx.options.getString('reason');
            moderator = ctx.user;
            guild     = ctx.guild;
        } else {
            if (args.length < 2) {
                return ctx.reply(`${t(lang, 'warn.usage')}  \`!warn @user reason\``).catch(() => {});
            }
            user = ctx.mentions.users.first();
            if (!user) {
                try { user = await client.users.fetch(args[0].replace(/[<@!>]/g, '')); } catch { user = null; }
            }
            if (!user) return ctx.reply(t(lang, 'warn.not_found'));
            reason    = args.slice(1).join(' ');
            moderator = ctx.author;
            guild     = ctx.guild;
        }

        /* ── Validate inputs ──────────────────────────── */
        const vWarn = validators.WarnArgs.safeParse({ userId: user.id, reason });
        if (!vWarn.success) {
            const p = buildError(validators.formatError(vWarn.error));
            return isSlash ? ctx.reply(p) : ctx.channel.send(p);
        }
        reason = vWarn.data.reason; // trimmed

        /* ── Self-warn check ───────────────────────────── */
        if (user.id === moderator.id) {
            const p = buildError(t(lang, 'warn.self_warn'));
            return isSlash ? ctx.reply(p) : ctx.channel.send(p);
        }

        /* ── Record ────────────────────────────────────── */
        const settings = settingsUtil.get();
        const caseId   = genCaseId();
        const date     = new Date().toLocaleString('en-US');

        if (settings.actions?.warn?.saveRecord) {
            await db.Warning.addCase(guildId, user.id, user.username, {
                caseId, reason, moderatorId: moderator.id,
            }).catch(err => console.error('[warn] Warning.addCase error:', err));
        }

        /* ── Log ───────────────────────────────────────── */
        if (g.cfg.log) {
            await logSystem.logCommandUsage({
                interaction: ctx,
                commandName: 'warn',
                moderator,
                target: user,
                reason,
                action: 'WARN',
            }).catch(() => {});
        }

        /* ── Reply ─────────────────────────────────────── */
        const warnDoc    = await db.Warning.findOne({ guildId, userId: user.id }).lean().catch(() => null);
        const totalWarns = warnDoc?.totalWarns ?? 0;
        const payload    = buildSuccess(user, reason, caseId, moderator, totalWarns, lang);

        let botReply;
        if (isSlash) {
            await ctx.reply(payload);
        } else {
            botReply = await ctx.channel.send(payload).catch(() => null);
        }

        await adminGuard.cleanup(g.cfg, isSlash ? null : ctx, botReply);

        /* ── DM ────────────────────────────────────────── */
        if (settings.actions?.warn?.dm) {
            const dmText = t(lang, 'warn.dm_msg', {
                guild: guild.name,
                case:  caseId,
                reason,
                mod:  moderator.id,
                date,
            });
            user.send(dmText).catch(() => {});
        }
    },
};

/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */