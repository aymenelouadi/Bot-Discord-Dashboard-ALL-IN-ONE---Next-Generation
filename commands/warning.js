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
const C   = { Container: 17, Text: 10, Sep: 14 };

/* ── Helpers ─────────────────────────────────────────── */
function getWarnings(userId) {
    const dbPath = path.join(__dirname, '../database/warning.json');
    if (!fs.existsSync(dbPath)) return null;
    try {
        const db = JSON.parse(fs.readFileSync(dbPath, 'utf8').replace(/^\uFEFF/, '') || '{}');
        return db[userId] || null;
    } catch { return null; }
}

function timeAgo(ts) {
    const ms   = Date.now() - new Date(ts).getTime();
    const days = Math.floor(ms / 86_400_000);
    if (days === 0) return 'today';
    if (days === 1) return '1 day ago';
    if (days < 30)  return `${days} days ago`;
    const mo = Math.floor(days / 30);
    return `${mo} month${mo > 1 ? 's' : ''} ago`;
}

/* ── CV2 builders ────────────────────────────────────── */
function buildWarnings(user, data, lang) {
    const cases  = data.cases || [];
    const active = cases.filter(c => c.action === 'WARN').length;
    const SEP    = '─────────────────────────────';

    const lines = [];
    lines.push(`## ${t(lang, 'warning.title')}`);
    lines.push('');
    lines.push(`👤 **${user.username}**  (\`${user.id}\`)`);
    lines.push(`${t(lang, 'warning.total_label')}: **${cases.length}**  ·  ${t(lang, 'warning.active_label')}: **${active}**`);
    lines.push('');

    if (cases.length === 0) {
        lines.push(`*${t(lang, 'warning.no_records')}*`);
    } else {
        // Show up to 10 most recent; oldest first for readability
        const slice = cases.slice(-10);
        for (const c of slice) {
            const emoji  = c.action === 'WARN' ? '⚠️' : '✅';
            const ago    = timeAgo(c.timestamp);
            lines.push(SEP);
            lines.push(`${emoji} **${c.action}**  ·  \`${c.caseId}\`  ·  *${ago}*`);
            lines.push(`📝 ${c.reason}`);
            lines.push(`🛡️ <@${c.moderatorId}>`);
        }
        lines.push(SEP);
        if (cases.length > 10) {
            lines.push(`-# *${t(lang, 'warning.showing_last', { n: 10, total: cases.length })}*`);
        }
    }

    // Keep content under 4000 chars (CV2 text limit)
    let content = lines.join('\n');
    if (content.length > 3900) content = content.slice(0, 3900) + '\n…';

    return {
        flags: CV2,
        components: [{
            type: C.Container,
            accent_color: active > 0 ? 0xf59e0b : 0x22c55e,
            components: [{ type: C.Text, content }],
        }],
    };
}

function buildEmpty(user, lang) {
    return {
        flags: CV2,
        components: [{
            type: C.Container,
            accent_color: 0x22c55e,
            components: [{
                type: C.Text,
                content: [
                    `## ${t(lang, 'warning.title')}`,
                    ``,
                    `👤 **${user.username}**  (\`${user.id}\`)`,
                    ``,
                    `✅  ${t(lang, 'warning.clean')}`,
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
        .setName('warning')
        .setDescription('View warning history for a member')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    textCommand: { name: 'warning', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash = ctx.isCommand?.();
        const guildId = ctx.guild?.id;
        const chanId  = isSlash ? ctx.channelId : ctx.channel.id;
        const lang    = langOf(guildId);

        /* ── Guard ─────────────────────────────────────── */
        const g = adminGuard.check('warning', guildId, chanId, ctx.member ?? null);
        if (!g.ok) return adminGuard.deny(ctx, g.reason);

        /* ── Parse inputs ──────────────────────────────── */
        let user, moderator;

        if (isSlash) {
            user      = ctx.options.getUser('user');
            moderator = ctx.user;
        } else {
            if (!args[0]) {
                return ctx.reply(`${t(lang, 'warning.usage')}  \`!warning @user\``).catch(() => {});
            }
            user = ctx.mentions.users.first();
            if (!user) {
                try { user = await client.users.fetch(args[0].replace(/[<@!>]/g, '')); } catch { user = null; }
            }
            if (!user) {
                const p = buildError(t(lang, 'warning.not_found'));
                return ctx.channel.send(p);
            }
            moderator = ctx.author;
        }

        /* ── Fetch data ────────────────────────────────── */
        const data = getWarnings(user.id);
        const payload = (!data || !data.cases?.length)
            ? buildEmpty(user, lang)
            : buildWarnings(user, data, lang);

        /* ── Log ───────────────────────────────────────── */
        if (g.cfg.log) {
            await logSystem.logCommandUsage({
                interaction: ctx, commandName: 'warning', moderator, target: user,
                reason: `Viewed ${data?.cases?.length ?? 0} records`,
                action: 'VIEW_WARNINGS',
            }).catch(() => {});
        }

        /* ── Reply ─────────────────────────────────────── */
        let botReply;
        if (isSlash) await ctx.reply(payload);
        else botReply = await ctx.channel.send(payload).catch(() => null);
        await adminGuard.cleanup(g.cfg, isSlash ? null : ctx, botReply);
    },
};

/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */