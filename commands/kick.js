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

function saveRecord(userId, userData, caseData) {
    const dbPath = path.join(__dirname, '../database/records.json');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    let db = {};
    try { db = JSON.parse(fs.readFileSync(dbPath, 'utf8').replace(/^\uFEFF/, '') || '{}'); } catch {}
    if (!db[userId]) db[userId] = { username: userData.username, tag: userData.tag, cases: [] };
    else { db[userId].username = userData.username; db[userId].tag = userData.tag; }
    db[userId].cases.push(caseData);
    try { fs.writeFileSync(dbPath, JSON.stringify(db, null, 2)); return true; }
    catch { return false; }
}

/* ── CV2 builders ────────────────────────────────────── */
function buildSuccess(user, reason, caseId, moderator, lang) {
    const date = new Date().toLocaleString('en-US');
    return {
        flags: CV2,
        components: [{
            type: C.Container,
            accent_color: 0xf97316,
            components: [{
                type: C.Text,
                content: [
                    `## ${t(lang, 'kick.title')}`,
                    ``,
                    `👤 **${t(lang, 'kick.label_target')}**  ${user.username}  (\`${user.id}\`)`,
                    `📝 **${t(lang, 'kick.label_reason')}**  ${reason}`,
                    ``,
                    `\`\`\``,
                    `${t(lang, 'kick.label_case')}  ${caseId}`,
                    `\`\`\``,
                    `-# 🛡️ ${t(lang, 'kick.label_mod')}: ${moderator.username}  ·  ${date}`,
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
        .setName('kick')
        .setDescription('Kick a member from the server')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason for the kick').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    textCommand: { name: 'kick', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash  = ctx.isCommand?.();
        const guildId  = ctx.guild?.id;
        const chanId   = isSlash ? ctx.channelId : ctx.channel.id;
        const lang     = langOf(guildId);

        /* ── Guard ─────────────────────────────────────── */
        const g = adminGuard.check('kick', guildId, chanId, ctx.member ?? null);
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
                return ctx.reply(`${t(lang, 'kick.usage')}  \`!kick @user reason\``).catch(() => {});
            }
            user = ctx.mentions.users.first();
            if (!user) {
                try { user = await client.users.fetch(args[0].replace(/[<@!>]/g, '')); } catch { user = null; }
            }
            if (!user) return ctx.reply(t(lang, 'kick.not_found'));
            reason    = args.slice(1).join(' ');
            moderator = ctx.author;
            guild     = ctx.guild;
        }

        /* ── Self-kick check ───────────────────────────── */
        if (user.id === moderator.id) {
            const p = buildError(t(lang, 'kick.self_kick'));
            return isSlash ? ctx.reply(p) : ctx.channel.send(p);
        }

        /* ── Fetch target ──────────────────────────────── */
        let targetMember;
        if (isSlash) {
            targetMember = ctx.options.getMember('user');
        } else {
            targetMember = await guild.members.fetch(user.id).catch(() => null);
        }

        if (!targetMember) {
            const p = buildError(t(lang, 'kick.not_in_server'));
            return isSlash ? ctx.reply(p) : ctx.channel.send(p);
        }

        if (!targetMember.kickable) {
            const p = buildError(t(lang, 'kick.not_kickable'));
            return isSlash ? ctx.reply(p) : ctx.channel.send(p);
        }

        /* ── Execute kick ──────────────────────────────── */
        try {
            await targetMember.kick(reason);
        } catch (err) {
            console.error('[kick] error:', err);
            let msg = t(lang, 'kick.failed');
            if (err.code === 50013) msg = t(lang, 'kick.no_perm_bot');
            else if (err.code === 10007) msg = t(lang, 'kick.not_found');
            const p = buildError(msg);
            return isSlash ? ctx.reply(p) : ctx.channel.send(p);
        }

        /* ── Record & log ──────────────────────────────── */
        const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '../settings.json'), 'utf8'));
        const caseId   = genCaseId();
        const date     = new Date().toLocaleString('en-US');

        const caseData = {
            caseId, action: 'KICK', reason,
            moderatorId: moderator.id,
            moderator: moderator.username,
            court: settings.court?.name ?? '',
            timestamp: date,
        };

        if (settings.actions?.kick?.saveRecord) {
            saveRecord(user.id, { username: user.username, tag: user.tag }, caseData);
        }

        if (g.cfg.log) {
            await logSystem.logCommandUsage({
                interaction: ctx,
                commandName: 'kick',
                moderator,
                target: user,
                reason,
                action: 'KICK',
            }).catch(() => {});
        }

        /* ── Reply ─────────────────────────────────────── */
        const payload = buildSuccess(user, reason, caseId, moderator, lang);

        let botReply;
        if (isSlash) {
            await ctx.reply(payload);
        } else {
            botReply = await ctx.channel.send(payload).catch(() => null);
        }

        await adminGuard.cleanup(g.cfg, isSlash ? null : ctx, botReply);

        /* ── DM ────────────────────────────────────────── */
        if (settings.actions?.kick?.dm) {
            const dmText = t(lang, 'kick.dm_msg', {
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