/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

﻿const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const logSystem = require('../systems/log.js');
const adminGuard = require('../utils/adminGuard');
const { t, langOf } = require('../utils/cmdLang');
const validators     = require('../utils/validators');
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

function parseDurationLabel(raw, lang) {
    if (!raw || /^permanent$/i.test(raw)) return t(lang, 'ban.permanent');
    const m = raw.match(/^(\d+)([dhmw])$/i);
    if (!m) return raw;
    const [, n, u] = m;
    const units = { d: { en: 'Day',  ar: 'يوم'  },
                    h: { en: 'Hour', ar: 'ساعة' },
                    m: { en: 'Min',  ar: 'دقيقة' },
                    w: { en: 'Week', ar: 'أسبوع' } };
    const unit = units[u.toLowerCase()]?.[lang] ?? u;
    return `${n} ${unit}`;
}

function parseDurationMs(raw) {
    if (!raw || /^permanent$/i.test(raw)) return null;
    const m = raw.match(/^(\d+)([dhmw])$/i);
    if (!m) return null;
    const ms = { d: 86400000, h: 3600000, m: 60000, w: 604800000 };
    return parseInt(m[1]) * (ms[m[2].toLowerCase()] ?? 0) || null;
}


/* ── CV2 card builders ────────────────────────────────── */
function buildSuccess(user, reason, durationLabel, caseId, moderator, lang) {
    const date = new Date().toLocaleString('en-US');
    return {
        flags: CV2,
        components: [{
            type: C.Container,
            accent_color: 0xef4444,
            components: [{
                type: C.Text,
                content: [
                    `## ${t(lang, 'ban.title')}`,
                    ``,
                    `👤 **${t(lang, 'ban.label_target')}**  ${user.username}  (\`${user.id}\`)`,
                    `📝 **${t(lang, 'ban.label_reason')}**  ${reason}`,
                    `⏱ **${t(lang, 'ban.label_duration')}**  ${durationLabel}`,
                    ``,
                    `\`\`\``,
                    `${t(lang, 'ban.label_case')}  ${caseId}`,
                    `\`\`\``,
                    `-# 🛡️ ${t(lang, 'ban.label_mod')}: ${moderator.username}  ·  ${date}`,
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
        .setName('ban')
        .setDescription('Ban a member from the server')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason for the ban').setRequired(true))
        .addStringOption(o => o.setName('duration').setDescription('Ban duration (e.g. 7d, 30d) — leave empty for permanent').setRequired(false)),
    textCommand: { name: 'ban', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash  = ctx.isCommand?.();
        const guildId  = ctx.guild?.id;
        const chanId   = isSlash ? ctx.channelId : ctx.channel.id;
        const lang     = langOf(guildId);

        /* ── Guard ─────────────────────────────────────── */
        const g = adminGuard.check('ban', guildId, chanId, ctx.member ?? null);
        if (!g.ok) return adminGuard.deny(ctx, g.reason);

        /* ── Parse inputs ──────────────────────────────── */
        let user, reason, rawDuration, moderator, guild;

        if (isSlash) {
            user        = ctx.options.getUser('user');
            reason      = ctx.options.getString('reason');
            rawDuration = ctx.options.getString('duration') || 'permanent';
            moderator   = ctx.user;
            guild       = ctx.guild;
        } else {
            if (args.length < 2) {
                return ctx.reply(`${t(lang, 'ban.usage')}  \`!ban @user reason [duration]\``).catch(() => {});
            }
            user = ctx.mentions.users.first();
            if (!user) {
                try { user = await client.users.fetch(args[0].replace(/[<@!>]/g, '')); } catch { user = null; }
            }
            if (!user) return ctx.reply(t(lang, 'ban.not_found'));

            const lastArg = args[args.length - 1];
            const isDur   = /^\d+[dhmw]$|^permanent$/i.test(lastArg);
            if (isDur && args.length >= 3) {
                rawDuration = lastArg;
                reason      = args.slice(1, -1).join(' ');
            } else {
                rawDuration = 'permanent';
                reason      = args.slice(1).join(' ');
            }
            moderator = ctx.author;
            guild     = ctx.guild;
        }

        /* ── Validate inputs ──────────────────────────── */
        const vBan = validators.BanArgs.safeParse({ userId: user.id, reason, duration: rawDuration });
        if (!vBan.success) {
            const p = buildError(validators.formatError(vBan.error));
            return isSlash ? ctx.reply(p) : ctx.channel.send(p);
        }
        reason      = vBan.data.reason;      // trimmed
        rawDuration = vBan.data.duration;    // normalised to lowercase

        /* ── Self-ban check ────────────────────────────── */
        if (user.id === moderator.id) {
            const p = buildError(t(lang, 'ban.self_ban'));
            return isSlash ? ctx.reply(p) : ctx.channel.send(p);
        }

        /* ── Fetch target member ───────────────────────── */
        const targetMember = await guild.members.fetch(user.id).catch(() => null);

        if (targetMember && !targetMember.bannable) {
            const p = buildError(t(lang, 'ban.not_bannable'));
            return isSlash ? ctx.reply(p) : ctx.channel.send(p);
        }

        /* ── Execute ban ───────────────────────────────── */
        const settings   = settingsUtil.get();
        const deleteSecs = settings.actions?.ban?.deleteMessageSeconds ?? 604800;

        try {
            if (targetMember) {
                await targetMember.ban({ reason, deleteMessageSeconds: Math.min(deleteSecs, 604800) });
            } else {
                await guild.members.ban(user.id, { reason, deleteMessageSeconds: Math.min(deleteSecs, 604800) });
            }
        } catch (err) {
            console.error('[ban] ban error:', err);
            let msg = t(lang, 'ban.failed');
            if (err.code === 50013) msg = t(lang, 'ban.no_perm_bot');
            else if (err.code === 50035) msg = t(lang, 'ban.already_banned');
            else if (err.code === 10007) msg = t(lang, 'ban.not_found');
            const p = buildError(msg);
            return isSlash ? ctx.reply(p) : ctx.channel.send(p);
        }

        /* ── Record & log ──────────────────────────────── */
        const caseId  = genCaseId();
        const date    = new Date().toLocaleString('en-US');
        const durationLabel = parseDurationLabel(rawDuration, lang);

        if (settings.actions?.ban?.saveRecord) {
            const durMs = parseDurationMs(rawDuration);
            await new db.Ban({
                guildId,
                userId:      user.id,
                username:    user.username,
                caseId,
                reason,
                moderatorId: moderator.id,
                duration:    durMs,
                expiresAt:   durMs ? new Date(Date.now() + durMs) : null,
            }).save().catch(err => console.error('[ban] Ban.save error:', err));
        }

        if (g.cfg.log) {
            await logSystem.logCommandUsage({
                interaction: ctx,
                commandName: 'ban',
                moderator,
                target: user,
                reason: `${reason} (${t(lang, 'ban.label_duration')}: ${durationLabel})`,
                action: 'BAN',
            }).catch(() => {});
        }

        /* ── Reply ─────────────────────────────────────── */
        const payload = buildSuccess(user, reason, durationLabel, caseId, moderator, lang);

        let botReply;
        if (isSlash) {
            await ctx.reply(payload);
        } else {
            botReply = await ctx.channel.send(payload).catch(() => null);
        }

        await adminGuard.cleanup(g.cfg, isSlash ? null : ctx, botReply);

        /* ── DM ────────────────────────────────────────── */
        if (settings.actions?.ban?.dm) {
            const dmLine = /^permanent$/i.test(rawDuration)
                ? ''
                : t(lang, 'ban.duration_line', { d: durationLabel });
            const dmText = t(lang, 'ban.dm_msg', {
                guild: guild.name,
                case:  caseId,
                reason,
                duration: dmLine,
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