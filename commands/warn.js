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

function saveWarning(userId, userData, caseData) {
    const dbPath = path.join(__dirname, '../database/warning.json');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    let db = {};
    try { db = JSON.parse(fs.readFileSync(dbPath, 'utf8').replace(/^\uFEFF/, '') || '{}'); } catch {}
    if (!db[userId]) db[userId] = { username: userData.username, tag: userData.tag, cases: [] };
    else { db[userId].username = userData.username; db[userId].tag = userData.tag; }
    db[userId].cases.push(caseData);
    try { fs.writeFileSync(dbPath, JSON.stringify(db, null, 2)); return true; }
    catch { return false; }
}

function warnCount(userId) {
    const dbPath = path.join(__dirname, '../database/warning.json');
    try {
        const db = JSON.parse(fs.readFileSync(dbPath, 'utf8').replace(/^\uFEFF/, '') || '{}');
        return db[userId]?.cases?.length ?? 0;
    } catch { return 0; }
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
        .addStringOption(o => o.setName('reason').setDescription('Reason for the warning').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

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

        /* ── Self-warn check ───────────────────────────── */
        if (user.id === moderator.id) {
            const p = buildError(t(lang, 'warn.self_warn'));
            return isSlash ? ctx.reply(p) : ctx.channel.send(p);
        }

        /* ── Record ────────────────────────────────────── */
        const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '../settings.json'), 'utf8'));
        const caseId   = genCaseId();
        const date     = new Date().toLocaleString('en-US');

        const caseData = {
            caseId, action: 'WARN', reason,
            moderatorId: moderator.id,
            moderator: moderator.username,
            court: settings.court?.name ?? '',
            timestamp: date,
        };

        let saveOk = true;
        if (settings.actions?.warn?.saveRecord) {
            saveOk = saveWarning(user.id, { username: user.username, tag: user.tag }, caseData);
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
        const totalWarns = warnCount(user.id);
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