/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

﻿const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const adminGuard = require('../utils/adminGuard.js');
const { langOf, t } = require('../utils/cmdLang.js');
const logSystem  = require('../systems/log.js');

const CV2 = 1 << 15;
const C   = { Container: 17, Text: 10, Sep: 14 };
const ACCENT = 0x64748b; // slate

function parseDuration(raw) {
    if (!raw) return null;
    const s = raw.trim().toLowerCase();
    if (s === '0' || s === 'off') return 0;
    const m = s.match(/^(\d+)(s|m|h)?$/);
    if (!m) return null;
    const v = parseInt(m[1]);
    const u = m[2] || 's';
    let sec = u === 's' ? v : u === 'm' ? v * 60 : v * 3600;
    if (sec > 21600) sec = 21600;
    return sec;
}

function fmtDuration(sec, lang) {
    if (sec === 0) return lang === 'ar' ? 'معطل' : 'Disabled';
    if (sec < 60)   return lang === 'ar' ? `${sec} ثانية`  : `${sec}s`;
    if (sec < 3600) return lang === 'ar' ? `${Math.floor(sec/60)} دقيقة` : `${Math.floor(sec/60)}m`;
    return lang === 'ar' ? `${Math.floor(sec/3600)} ساعة` : `${Math.floor(sec/3600)}h`;
}

function buildCard(color, lines) {
    return {
        flags: CV2,
        components: [{
            type: C.Container, accent_color: color,
            components: [
                { type: C.Text, content: lines.join('\n') }
            ]
        }]
    };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('slowmode')
        .setDescription('Set slowmode on a channel')
        .addStringOption(o => o.setName('time').setDescription('e.g. 5s 10m 1h 0').setRequired(true))
        .addChannelOption(o => o.setName('channel').setDescription('Target channel (default: current)').setRequired(false).addChannelTypes(ChannelType.GuildText)),
    textCommand: { name: 'slowmode', aliases: ['slow'] },

    async execute(client, ctx, args) {
        const isSlash = ctx.isCommand?.();
        const guild   = ctx.guild;
        const lang    = langOf(guild?.id);

        if (!guild) return;

        const guard = await adminGuard.check('slowmode', guild.id, (ctx.channel || ctx.channelId), ctx.member);
        if (!guard.ok) return adminGuard.deny(ctx, guard.reason);

        const author    = isSlash ? ctx.user : ctx.author;
        const authorMsg = isSlash ? null : ctx;

        /* ── resolve channel + time ── */
        let targetChannel, rawTime;

        if (isSlash) {
            rawTime       = ctx.options.getString('time');
            targetChannel = ctx.options.getChannel('channel') || ctx.channel;
        } else {
            if (!args.length) {
                const usage = buildCard(0xef4444, [`❌  \`${t(lang,'slowmode.usage')}\`: \`!slowmode [#channel] <time>\``]);
                const m = await ctx.channel.send(usage);
                setTimeout(() => m.delete().catch(() => {}), 8000);
                return;
            }
            /* first arg is a channel mention/id or a time literal */
            const first = args[0];
            const mentionedCh = ctx.mentions?.channels?.first();
            if (mentionedCh) {
                targetChannel = mentionedCh;
                rawTime = args[1];
            } else if (/^\d{17,20}$/.test(first)) {
                targetChannel = guild.channels.cache.get(first) || ctx.channel;
                rawTime = args[1] ?? args[0];
            } else {
                targetChannel = ctx.channel;
                rawTime = first;
            }
        }

        if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'slowmode.text_only')}`]);
            const m = isSlash
                ? await ctx.reply({ ...err, ephemeral: true })
                : await ctx.channel.send(err);
            if (!isSlash) setTimeout(() => m.delete().catch(() => {}), 8000);
            return;
        }

        const seconds = parseDuration(rawTime);
        if (seconds === null) {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'slowmode.invalid_time')}`]);
            const m = isSlash
                ? await ctx.reply({ ...err, ephemeral: true })
                : await ctx.channel.send(err);
            if (!isSlash) setTimeout(() => m.delete().catch(() => {}), 8000);
            return;
        }

        try {
            await targetChannel.setRateLimitPerUser(seconds);
        } catch {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'slowmode.failed')}`]);
            const m = isSlash
                ? await ctx.reply({ ...err, ephemeral: true })
                : await ctx.channel.send(err);
            if (!isSlash) setTimeout(() => m.delete().catch(() => {}), 8000);
            return;
        }

        const durText = fmtDuration(seconds, lang);
        const lines = [
            `## 🐢  ${t(lang,'slowmode.title')}`,
            `${t(lang,'slowmode.label_channel')}  →  ${targetChannel}`,
            `${t(lang,'slowmode.label_duration')}  →  **${durText}**`,
            `${t(lang,'slowmode.label_mod')}  →  <@${author.id}>`,
        ];
        const card = buildCard(ACCENT, lines);

        let botReply;
        if (isSlash) {
            botReply = await ctx.reply({ ...card, ephemeral: false });
        } else {
            botReply = await ctx.channel.send(card);
        }
        setTimeout(() => adminGuard.cleanup(guard.cfg, authorMsg, isSlash ? null : botReply), 8000);

        if (guard.cfg?.log !== false) {
            await logSystem.logCommandUsage({
                interaction: ctx, commandName: 'slowmode',
                moderator: author,
                target: { username: `#${targetChannel.name}`, displayAvatarURL: () => guild.iconURL() },
                reason: `Slowmode → ${durText}`,
                action: 'SLOWMODE'
            }).catch(() => {});
        }
    }
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */