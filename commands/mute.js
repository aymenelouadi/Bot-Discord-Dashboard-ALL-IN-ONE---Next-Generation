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
function genCaseId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let id = '';
    for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}

function parseDuration(raw, lang) {
    const m = raw.match(/^(\d+)([mhdw])$/i);
    if (!m) return null;
    const [, n, u] = m;
    const ms = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
    const label = {
        m: { en: 'min',  ar: 'دقيقة'  },
        h: { en: 'hr',   ar: 'ساعة'   },
        d: { en: 'day',  ar: 'يوم'    },
        w: { en: 'week', ar: 'أسبوع'  },
    };
    const unit = u.toLowerCase();
    return { ms: parseInt(n) * ms[unit], text: `${n} ${label[unit][lang]}` };
}

function saveRecord(userId, userData, caseData) {
    const dbPath = path.join(__dirname, '../database/records.json');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    let db = {};
    try { db = JSON.parse(fs.readFileSync(dbPath, 'utf8').replace(/^\uFEFF/, '') || '{}'); } catch {}
    if (!db[userId]) db[userId] = { username: userData.username, tag: userData.tag, cases: [] };
    else { db[userId].username = userData.username; db[userId].tag = userData.tag; }
    db[userId].cases.push(caseData);
    try { fs.writeFileSync(dbPath, JSON.stringify(db, null, 2)); return true; } catch { return false; }
}

/* ── CV2 builders ────────────────────────────────────── */
function buildSuccess(user, reason, dur, endStr, caseId, moderator, lang) {
    const date = new Date().toLocaleString('en-US');
    return {
        flags: CV2,
        components: [{
            type: C.Container,
            accent_color: 0x8b5cf6,
            components: [{
                type: C.Text,
                content: [
                    `## ${t(lang, 'mute.title')}`,
                    ``,
                    `👤 **${t(lang, 'mute.label_target')}**  ${user.username}  (\`${user.id}\`)`,
                    `📝 **${t(lang, 'mute.label_reason')}**  ${reason}`,
                    `⏱ **${t(lang, 'mute.label_duration')}**  ${dur.text}`,
                    `🔓 **${t(lang, 'mute.label_ends')}**  ${endStr}`,
                    ``,
                    `\`\`\``,
                    `${t(lang, 'mute.label_case')}  ${caseId}`,
                    `\`\`\``,
                    `-# 🛡️ ${t(lang, 'mute.label_mod')}: ${moderator.username}  ·  ${date}`,
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
        .setName('mute')
        .setDescription('Timeout a member')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addStringOption(o => o.setName('duration').setDescription('Duration — e.g. 5m 1h 1d 7d (max 28d)').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason for the timeout').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    textCommand: { name: 'mute', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash = ctx.isCommand?.();
        const guildId = ctx.guild?.id;
        const chanId  = isSlash ? ctx.channelId : ctx.channel.id;
        const lang    = langOf(guildId);

        /* ── Guard ─────────────────────────────────────── */
        const g = adminGuard.check('mute', guildId, chanId, ctx.member ?? null);
        if (!g.ok) return adminGuard.deny(ctx, g.reason);

        /* ── Parse inputs ──────────────────────────────── */
        let user, rawDur, reason, moderator, guild;

        if (isSlash) {
            user      = ctx.options.getUser('user');
            rawDur    = ctx.options.getString('duration');
            reason    = ctx.options.getString('reason');
            moderator = ctx.user;
            guild     = ctx.guild;
        } else {
            if (args.length < 3) {
                return ctx.reply(`${t(lang, 'mute.usage')}  \`!mute @user duration reason\``).catch(() => {});
            }
            user = ctx.mentions.users.first();
            if (!user) {
                try { user = await client.users.fetch(args[0].replace(/[<@!>]/g, '')); } catch { user = null; }
            }
            if (!user) return ctx.reply(t(lang, 'mute.not_found'));
            rawDur    = args[1];
            reason    = args.slice(2).join(' ');
            moderator = ctx.author;
            guild     = ctx.guild;
        }

        /* ── Self check ────────────────────────────────── */
        if (user.id === moderator.id) {
            const p = buildError(t(lang, 'mute.self_mute'));
            return isSlash ? ctx.reply(p) : ctx.channel.send(p);
        }

        /* ── Parse duration ────────────────────────────── */
        const dur = parseDuration(rawDur, lang);
        if (!dur) {
            const p = buildError(t(lang, 'mute.invalid_duration'));
            return isSlash ? ctx.reply(p) : ctx.channel.send(p);
        }

        const MAX_MS = 28 * 24 * 60 * 60 * 1000;
        if (dur.ms > MAX_MS) {
            const p = buildError(t(lang, 'mute.max_exceeded'));
            return isSlash ? ctx.reply(p) : ctx.channel.send(p);
        }

        /* ── Fetch target ──────────────────────────────── */
        let targetMember;
        if (isSlash) targetMember = ctx.options.getMember('user');
        else targetMember = await guild.members.fetch(user.id).catch(() => null);

        if (!targetMember) {
            const p = buildError(t(lang, 'mute.not_in_server'));
            return isSlash ? ctx.reply(p) : ctx.channel.send(p);
        }

        /* Check already muted */
        if (targetMember.communicationDisabledUntil && new Date(targetMember.communicationDisabledUntil) > new Date()) {
            const until = new Date(targetMember.communicationDisabledUntil).toLocaleString('en-US');
            const p = buildError(t(lang, 'mute.already_muted', { until }));
            return isSlash ? ctx.reply(p) : ctx.channel.send(p);
        }

        /* ── Execute timeout ───────────────────────────── */
        try {
            await targetMember.timeout(dur.ms, reason);
        } catch (err) {
            console.error('[mute] error:', err);
            let msg = t(lang, 'mute.failed');
            if (err.code === 50013) msg = t(lang, 'mute.no_perm_bot');
            else if (err.code === 10007) msg = t(lang, 'mute.not_found');
            const p = buildError(msg);
            return isSlash ? ctx.reply(p) : ctx.channel.send(p);
        }

        /* ── Record & log ──────────────────────────────── */
        const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '../settings.json'), 'utf8'));
        const caseId   = genCaseId();
        const date     = new Date().toLocaleString('en-US');
        const endStr   = new Date(Date.now() + dur.ms).toLocaleString('en-US');

        const caseData = {
            caseId, action: 'MUTE', reason,
            duration: dur.text, durationMs: dur.ms, endTime: endStr,
            moderatorId: moderator.id, moderator: moderator.username,
            court: settings.court?.name ?? '', timestamp: date,
        };

        if (settings.actions?.mute?.saveRecord) {
            saveRecord(user.id, { username: user.username, tag: user.tag }, caseData);
        }

        if (g.cfg.log) {
            await logSystem.logCommandUsage({
                interaction: ctx, commandName: 'mute', moderator, target: user,
                reason: `${reason} (${t(lang, 'mute.label_duration')}: ${dur.text})`, action: 'MUTE',
            }).catch(() => {});
        }

        /* ── Reply ─────────────────────────────────────── */
        const payload = buildSuccess(user, reason, dur, endStr, caseId, moderator, lang);
        let botReply;
        if (isSlash) await ctx.reply(payload);
        else botReply = await ctx.channel.send(payload).catch(() => null);
        await adminGuard.cleanup(g.cfg, isSlash ? null : ctx, botReply);

        /* ── DM ────────────────────────────────────────── */
        if (settings.actions?.mute?.dm) {
            user.send(t(lang, 'mute.dm_msg', {
                guild: guild.name, case: caseId, reason,
                duration: dur.text, ends: endStr, mod: moderator.id, date,
            })).catch(() => {});
        }
    },
};

/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */