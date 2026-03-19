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

/**
 * Finds and "soft-deletes" a WARN case by caseId.
 * Adds an UNWARN entry to the same user's record to keep audit trail.
 * Returns { ok, userId, removedCase, unwarnCaseId } or { ok: false, reason }
 */
function removeWarning(caseId, moderator) {
    const dbPath = path.join(__dirname, '../database/warning.json');
    if (!fs.existsSync(dbPath)) return { ok: false, reason: 'no_db' };

    let db = {};
    try { db = JSON.parse(fs.readFileSync(dbPath, 'utf8').replace(/^\uFEFF/, '') || '{}'); } catch { return { ok: false, reason: 'parse_error' }; }

    let userId = null;
    let removedCase = null;

    for (const [id, data] of Object.entries(db)) {
        const idx = data.cases?.findIndex(c => c.caseId === caseId && c.action !== 'UNWARN');
        if (idx !== undefined && idx !== -1) {
            userId      = id;
            removedCase = data.cases[idx];
            // Remove the WARN entry
            data.cases.splice(idx, 1);
            break;
        }
    }

    if (!userId || !removedCase) return { ok: false, reason: 'not_found' };

    // Append UNWARN audit entry
    const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '../settings.json'), 'utf8'));
    const unwarnCaseId = genCaseId();
    db[userId].cases.push({
        caseId:         unwarnCaseId,
        action:         'UNWARN',
        reason:         `Removed warning: ${removedCase.reason}`,
        moderatorId:    moderator.id,
        moderator:      moderator.username,
        court:          settings.court?.name ?? '',
        timestamp:      new Date().toLocaleString('en-US'),
        originalCaseId: caseId,
    });

    try {
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
        return { ok: true, userId, removedCase, unwarnCaseId };
    } catch { return { ok: false, reason: 'write_error' }; }
}

/* ── CV2 builders ────────────────────────────────────── */
function buildSuccess(user, removedReason, originalCaseId, unwarnCaseId, moderator, lang) {
    const date = new Date().toLocaleString('en-US');
    return {
        flags: CV2,
        components: [{
            type: C.Container,
            accent_color: 0x10b981,
            components: [{
                type: C.Text,
                content: [
                    `## ${t(lang, 'unwarn.title')}`,
                    ``,
                    `👤 **${t(lang, 'unwarn.label_target')}**  ${user ? `${user.username}  (\`${user.id}\`)` : `\`${unwarnCaseId}\``}`,
                    `📝 **${t(lang, 'unwarn.label_orig_reason')}**  ${removedReason}`,
                    ``,
                    `\`\`\``,
                    `${t(lang, 'unwarn.label_orig_case')}  ${originalCaseId}`,
                    `${t(lang, 'unwarn.label_new_case')}   ${unwarnCaseId}`,
                    `\`\`\``,
                    `-# 🛡️ ${t(lang, 'unwarn.label_mod')}: ${moderator.username}  ·  ${date}`,
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
        .setName('unwarn')
        .setDescription('Remove a warning by its Case ID')
        .addStringOption(o => o.setName('case').setDescription('Case ID to remove (8 characters)').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    textCommand: { name: 'unwarn', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash = ctx.isCommand?.();
        const guildId = ctx.guild?.id;
        const chanId  = isSlash ? ctx.channelId : ctx.channel.id;
        const lang    = langOf(guildId);

        /* ── Guard ─────────────────────────────────────── */
        const g = adminGuard.check('unwarn', guildId, chanId, ctx.member ?? null);
        if (!g.ok) return adminGuard.deny(ctx, g.reason);

        /* ── Parse inputs ──────────────────────────────── */
        let caseId, moderator, guild;

        if (isSlash) {
            caseId    = ctx.options.getString('case').trim().toUpperCase();
            moderator = ctx.user;
            guild     = ctx.guild;
        } else {
            if (!args[0]) {
                return ctx.reply(`${t(lang, 'unwarn.usage')}  \`!unwarn CASEID\``).catch(() => {});
            }
            caseId    = args[0].trim().toUpperCase();
            moderator = ctx.author;
            guild     = ctx.guild;
        }

        /* ── Validate case ID format ───────────────────── */
        if (caseId.length !== 8) {
            const p = buildError(t(lang, 'unwarn.invalid_case'));
            return isSlash ? ctx.reply(p) : ctx.channel.send(p);
        }

        /* ── Remove warning ────────────────────────────── */
        const result = removeWarning(caseId, moderator);

        if (!result.ok) {
            const msg = result.reason === 'not_found'
                ? t(lang, 'unwarn.case_not_found', { id: caseId })
                : t(lang, 'unwarn.failed');
            const p = buildError(msg);
            return isSlash ? ctx.reply(p) : ctx.channel.send(p);
        }

        /* ── Fetch user ────────────────────────────────── */
        const user = await client.users.fetch(result.userId).catch(() => null);

        /* ── Log ───────────────────────────────────────── */
        if (g.cfg.log) {
            await logSystem.logCommandUsage({
                interaction: ctx, commandName: 'unwarn', moderator,
                target: user || { username: 'Unknown', displayAvatarURL: () => '' },
                reason: `Removed warning: ${result.removedCase.reason}`,
                action: 'UNWARN',
            }).catch(() => {});
        }

        /* ── Reply ─────────────────────────────────────── */
        const payload = buildSuccess(user, result.removedCase.reason, caseId, result.unwarnCaseId, moderator, lang);
        let botReply;
        if (isSlash) await ctx.reply(payload);
        else botReply = await ctx.channel.send(payload).catch(() => null);
        await adminGuard.cleanup(g.cfg, isSlash ? null : ctx, botReply);

        /* ── DM ────────────────────────────────────────── */
        const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '../settings.json'), 'utf8'));
        if (settings.actions?.unwarn?.dm && user) {
            user.send(t(lang, 'unwarn.dm_msg', {
                guild: guild.name, case: caseId, mod: moderator.id,
                date: new Date().toLocaleString('en-US'),
            })).catch(() => {});
        }
    },
};

/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */