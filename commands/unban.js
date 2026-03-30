/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

﻿const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const logSystem  = require('../systems/log.js');
const adminGuard = require('../utils/adminGuard');
const { t, langOf } = require('../utils/cmdLang');
const settingsUtil   = require('../utils/settings');
const db             = require('../systems/schemas');

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
function buildSuccess(user, userId, reason, caseId, moderator, lang) {
    const date = new Date().toLocaleString('en-US');
    return {
        flags: CV2,
        components: [{
            type: C.Container,
            accent_color: 0x22c55e,
            components: [{
                type: C.Text,
                content: [
                    `## ${t(lang, 'unban.title')}`,
                    ``,
                    `👤 **${t(lang, 'unban.label_target')}**  ${user.username}  (\`${userId}\`)`,
                    `📝 **${t(lang, 'unban.label_reason')}**  ${reason}`,
                    ``,
                    `\`\`\``,
                    `${t(lang, 'unban.label_case')}  ${caseId}`,
                    `\`\`\``,
                    `-# 🛡️ ${t(lang, 'unban.label_mod')}: ${moderator.username}  ·  ${date}`,
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
        .setName('unban')
        .setDescription('Unban a member from the server')
        .addStringOption(o => o.setName('user').setDescription('User ID to unban').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason for the unban').setRequired(true)),
    textCommand: { name: 'unban', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash = ctx.isCommand?.();
        const guildId = ctx.guild?.id;
        const chanId  = isSlash ? ctx.channelId : ctx.channel.id;
        const lang    = langOf(guildId);

        /* ── Guard ─────────────────────────────────────── */
        const g = adminGuard.check('unban', guildId, chanId, ctx.member ?? null);
        if (!g.ok) return adminGuard.deny(ctx, g.reason);

        /* ── Parse inputs ──────────────────────────────── */
        let userId, reason, moderator, guild;

        if (isSlash) {
            userId    = ctx.options.getString('user').trim();
            reason    = ctx.options.getString('reason');
            moderator = ctx.user;
            guild     = ctx.guild;
        } else {
            if (args.length < 2) {
                return ctx.reply(`${t(lang, 'unban.usage')}  \`!unban userID reason\``).catch(() => {});
            }
            userId    = args[0].trim();
            reason    = args.slice(1).join(' ');
            moderator = ctx.author;
            guild     = ctx.guild;
        }

        /* ── Validate ID format ────────────────────────── */
        if (!/^\d{17,20}$/.test(userId)) {
            const p = buildError(t(lang, 'unban.invalid_id'));
            return isSlash ? ctx.reply(p) : ctx.channel.send(p);
        }

        /* ── Check ban list ────────────────────────────── */
        let bannedEntry;
        try {
            const banList = await guild.bans.fetch();
            bannedEntry   = banList.get(userId);
        } catch (err) {
            console.error('[unban] bans.fetch error:', err);
            const p = buildError(t(lang, 'unban.no_perm_bot'));
            return isSlash ? ctx.reply(p) : ctx.channel.send(p);
        }

        if (!bannedEntry) {
            const p = buildError(t(lang, 'unban.not_banned'));
            return isSlash ? ctx.reply(p) : ctx.channel.send(p);
        }

        /* ── Execute unban ─────────────────────────────── */
        try {
            await guild.members.unban(userId, reason);
        } catch (err) {
            console.error('[unban] unban error:', err);
            let msg = t(lang, 'unban.failed');
            if (err.code === 50013) msg = t(lang, 'unban.no_perm_bot');
            else if (err.code === 10026) msg = t(lang, 'unban.not_banned');
            const p = buildError(msg);
            return isSlash ? ctx.reply(p) : ctx.channel.send(p);
        }

        /* ── Fetch user object (best effort) ───────────── */
        let user;
        try { user = await client.users.fetch(userId); }
        catch { user = bannedEntry.user ?? { id: userId, username: 'Unknown', tag: 'Unknown#0000' }; }

        /* ── Record & log ──────────────────────────────── */
        const settings = settingsUtil.get();
        const caseId   = genCaseId();
        const date     = new Date().toLocaleString('en-US');

        if (settings.actions?.ban?.saveRecord) {
            await db.Ban.end(guildId, userId)
                .catch(err => console.error('[unban] Ban.end error:', err));
        }

        if (g.cfg.log) {
            await logSystem.logCommandUsage({
                interaction: ctx, commandName: 'unban', moderator, target: user,
                reason, action: 'UNBAN',
            }).catch(() => {});
        }

        /* ── Reply ─────────────────────────────────────── */
        const payload = buildSuccess(user, userId, reason, caseId, moderator, lang);
        let botReply;
        if (isSlash) await ctx.reply(payload);
        else botReply = await ctx.channel.send(payload).catch(() => null);
        await adminGuard.cleanup(g.cfg, isSlash ? null : ctx, botReply);

        /* ── DM ────────────────────────────────────────── */
        if (settings.actions?.unban?.dm) {
            user.send(t(lang, 'unban.dm_msg', {
                guild: guild.name, case: caseId, reason, mod: moderator.id, date,
            })).catch(() => {});
        }
    },
};

/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */