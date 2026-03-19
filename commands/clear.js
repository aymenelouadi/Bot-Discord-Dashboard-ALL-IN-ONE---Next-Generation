/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

﻿const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const fs         = require('fs');
const path       = require('path');
const logSystem  = require('../systems/log.js');
const adminGuard = require('../utils/adminGuard');
const { t, langOf } = require('../utils/cmdLang');

/* ── Components V2 ─────────────────────────────────── */
const CV2 = 1 << 15;
const C   = { Container: 17, Text: 10 };

/* ── Helpers ─────────────────────────────────────────── */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;   // 14 days (Discord bulk-delete limit)

function saveLog(logData) {
    const dbPath = path.join(__dirname, '../database/clear-logs.json');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    let db = [];
    try { db = JSON.parse(fs.readFileSync(dbPath, 'utf8') || '[]'); } catch {}
    db.push(logData);
    try { fs.writeFileSync(dbPath, JSON.stringify(db, null, 2)); } catch {}
}

/* ── CV2 builders ────────────────────────────────────── */
function buildSuccess(deleted, channel, targetUser, reason, moderator, lang) {
    const date = new Date().toLocaleString('en-US');
    const targetLine = targetUser
        ? `\n🎯 **${t(lang, 'clear.label_filter')}**  ${targetUser.username}  (\`${targetUser.id}\`)`
        : '';
    const reasonLine = reason ? `\n📝 **${t(lang, 'clear.label_reason')}**  ${reason}` : '';
    return {
        flags: CV2,
        components: [{
            type: C.Container,
            accent_color: 0x3b82f6,
            components: [{
                type: C.Text,
                content: [
                    `## ${t(lang, 'clear.title')}`,
                    ``,
                    `🗑️ **${t(lang, 'clear.label_deleted')}**  ${deleted}`,
                    `📍 **${t(lang, 'clear.label_channel')}**  <#${channel.id}>${targetLine}${reasonLine}`,
                    ``,
                    `-# 🛡️ ${t(lang, 'clear.label_mod')}: ${moderator.username}  ·  ${date}`,
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
        .setName('clear')
        .setDescription('Bulk delete messages in a channel')
        .addIntegerOption(o => o.setName('amount').setDescription('Number of messages to delete (1–100)').setRequired(true).setMinValue(1).setMaxValue(100))
        .addUserOption(o => o.setName('user').setDescription('Only delete messages from this user (optional)').setRequired(false))
        .addStringOption(o => o.setName('reason').setDescription('Reason (optional)').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    textCommand: { name: 'clear', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash  = ctx.isCommand?.();
        const guildId  = ctx.guild?.id;
        const chanId   = isSlash ? ctx.channelId : ctx.channel.id;
        const lang     = langOf(guildId);

        /* ── Guard ─────────────────────────────────────── */
        const g = adminGuard.check('clear', guildId, chanId, ctx.member ?? null);
        if (!g.ok) return adminGuard.deny(ctx, g.reason);

        /* ── Parse inputs ──────────────────────────────── */
        let amount, targetUser, reason, moderator, guild, channel;

        if (isSlash) {
            amount     = ctx.options.getInteger('amount');
            targetUser = ctx.options.getUser('user') ?? null;
            reason     = ctx.options.getString('reason') ?? null;
            moderator  = ctx.user;
            guild      = ctx.guild;
            channel    = ctx.channel;
        } else {
            amount = parseInt(args[0]);
            if (isNaN(amount) || amount < 1) {
                return ctx.reply(`${t(lang, 'clear.usage')}  \`!clear amount [@user] [reason]\``).catch(() => {});
            }
            amount = Math.min(amount, 100);
            targetUser = ctx.mentions.users.first() ?? null;
            const startIdx = targetUser ? args.findIndex(a => a.includes(targetUser.id)) + 1 : 1;
            const rawReason = args.slice(startIdx).join(' ').trim();
            reason    = rawReason || null;
            moderator = ctx.author;
            guild     = ctx.guild;
            channel   = ctx.channel;
        }

        /* ── Bot perms check ───────────────────────────── */
        const botPerms = channel.permissionsFor(client.user);
        if (!botPerms.has(PermissionFlagsBits.ManageMessages)) {
            const p = buildError(t(lang, 'clear.no_manage_perm'));
            return isSlash ? ctx.reply(p) : ctx.channel.send(p);
        }

        /* ── Defer for slash (delete takes time) ───────── */
        if (isSlash) await ctx.deferReply({ ephemeral: false }).catch(() => {});

        /* ── Fetch & filter messages ───────────────────── */
        let deleted = 0;
        try {
            const fetched = await channel.messages.fetch({ limit: 100 });
            let msgs = [...fetched.values()].filter(
                m => (Date.now() - m.createdTimestamp) < MAX_AGE_MS
            );

            if (targetUser) msgs = msgs.filter(m => m.author.id === targetUser.id);
            msgs = msgs.slice(0, amount);

            if (msgs.length === 0) {
                const p = buildError(targetUser
                    ? t(lang, 'clear.no_msgs_user', { user: targetUser.username })
                    : t(lang, 'clear.no_msgs_old'));
                return isSlash ? ctx.editReply(p) : ctx.channel.send(p);
            }

            if (msgs.length === 1) {
                await msgs[0].delete();
            } else {
                await channel.bulkDelete(msgs, true);
            }

            deleted = msgs.length;
        } catch (err) {
            console.error('[clear] delete error:', err);
            let msg = t(lang, 'clear.failed');
            if (err.code === 50013) msg = t(lang, 'clear.no_manage_perm');
            else if (err.code === 50034) msg = t(lang, 'clear.too_old');
            const p = buildError(msg);
            return isSlash ? ctx.editReply(p) : ctx.channel.send(p);
        }

        /* ── Log ───────────────────────────────────────── */
        const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '../settings.json'), 'utf8'));
        const date     = new Date().toLocaleString('en-US');

        if (g.cfg.log) {
            const logTarget = targetUser ?? { username: 'All', displayAvatarURL: () => client.user.displayAvatarURL() };
            await logSystem.logCommandUsage({
                interaction: ctx, commandName: 'clear', moderator, target: logTarget,
                reason: `Deleted ${deleted} msg${deleted !== 1 ? 's' : ''}${targetUser ? ` from ${targetUser.username}` : ''}${reason ? ` — ${reason}` : ''}`,
                action: 'CLEAR',
            }).catch(() => {});
        }

        saveLog({
            moderatorId: moderator.id, moderatorUsername: moderator.username,
            channelId: channel.id, channelName: channel.name,
            amount, deletedCount: deleted,
            targetUserId: targetUser?.id ?? null, targetUsername: targetUser?.username ?? null,
            reason, date, timestamp: Date.now(),
        });

        /* ── Reply (auto-delete after 5 s) ─────────────── */
        const payload  = buildSuccess(deleted, channel, targetUser, reason, moderator, lang);

        let botReply;
        if (isSlash) {
            await ctx.editReply(payload);
            setTimeout(() => ctx.deleteReply().catch(() => {}), 5000);
        } else {
            botReply = await ctx.channel.send(payload).catch(() => null);
            if (botReply) setTimeout(() => botReply.delete().catch(() => {}), 5000);
        }

        await adminGuard.cleanup(g.cfg, isSlash ? null : ctx, null);   // no auto-delete override (handled above)
    },
};

/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */