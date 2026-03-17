/*
 * This project was programmed by the Code Nexus team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/UvEYbFd2rj
 */

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const adminGuard = require('../utils/adminGuard.js');
const { langOf, t } = require('../utils/cmdLang.js');
const logSystem  = require('../systems/log.js');

const CV2 = 1 << 15;
const C   = { Container: 17, Text: 10, Sep: 14 };
const ACCENT = 0xf97316; // orange

const genCaseId = () => {
    const ch = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    return Array.from({ length: 8 }, () => ch[Math.floor(Math.random() * ch.length)]).join('');
};

function parseDuration(raw, lang) {
    if (!raw) return null;
    const s = raw.trim().toLowerCase();
    if (s === '0' || s === 'permanent') return { ms: null, text: lang === 'ar' ? 'دائم' : 'Permanent' };
    const m = s.match(/^(\d+)([mhdw])$/);
    if (!m) return null;
    const v = parseInt(m[1]), u = m[2];
    const ms = u === 'm' ? v * 60000 : u === 'h' ? v * 3600000 : u === 'd' ? v * 86400000 : v * 604800000;
    const units = { m: lang==='ar'?'دقيقة':'min', h: lang==='ar'?'ساعة':'hr', d: lang==='ar'?'يوم':'day', w: lang==='ar'?'أسبوع':'week' };
    return { ms, text: `${v} ${units[u]}` };
}

async function setupChannelPerms(guild, userId, jailRoleId, allowedIds) {
    const channels = await guild.channels.fetch();
    for (const [id, ch] of channels) {
        if (!ch || ch.type === ChannelType.GuildCategory) continue;
        try {
            if (allowedIds.includes(id)) {
                await ch.permissionOverwrites.edit(userId,     { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
                await ch.permissionOverwrites.edit(jailRoleId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
            } else {
                await ch.permissionOverwrites.edit(userId,     { ViewChannel: false });
                await ch.permissionOverwrites.edit(jailRoleId, { ViewChannel: false });
            }
        } catch {}
    }
}

function saveJail(userId, data) {
    const dbPath = path.join(__dirname, '../database/jailed.json');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    let db = {};
    try { db = JSON.parse(fs.readFileSync(dbPath, 'utf8').replace(/^\uFEFF/, '')); } catch {}
    db[userId] = data;
    try { fs.writeFileSync(dbPath, JSON.stringify(db, null, 2)); return true; } catch { return false; }
}

function buildCard(color, lines) {
    return {
        flags: CV2,
        components: [{ type: C.Container, accent_color: color,
            components: [{ type: C.Text, content: lines.join('\n') }] }]
    };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('jail')
        .setDescription('Jail a member')
        .addUserOption(o => o.setName('user').setDescription('Target member').setRequired(true))
        .addStringOption(o => o.setName('duration').setDescription('e.g. 1h 6h 1d 7d 0/permanent').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    textCommand: { name: 'jail', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash = ctx.isCommand?.();
        const guild   = ctx.guild;
        const lang    = langOf(guild?.id);
        if (!guild) return;

        const guard = await adminGuard.check('jail', guild.id, ctx.channel || ctx.channelId, ctx.member);
        if (!guard.ok) return adminGuard.deny(ctx, guard.reason);

        const author    = isSlash ? ctx.user : ctx.author;
        const authorMsg = isSlash ? null : ctx;

        let targetUser, rawDuration, reason;

        if (isSlash) {
            targetUser  = ctx.options.getUser('user');
            rawDuration = ctx.options.getString('duration');
            reason      = ctx.options.getString('reason');
        } else {
            if (args.length < 3) {
                const m = await ctx.channel.send(buildCard(0xef4444, [`❌  ${t(lang,'jail.usage')}: !jail <@user> <duration> <reason>`]));
                setTimeout(() => m.delete().catch(() => {}), 8000);
                return;
            }
            targetUser = ctx.mentions?.users?.first();
            if (!targetUser) {
                try { targetUser = await client.users.fetch(args[0].replace(/[<@!>]/g, '')); } catch {}
            }
            if (!targetUser) {
                const m = await ctx.channel.send(buildCard(0xef4444, [`❌  ${t(lang,'jail.not_found')}`]));
                setTimeout(() => m.delete().catch(() => {}), 8000);
                return;
            }
            rawDuration = args[1];
            reason      = args.slice(2).join(' ');
        }

        if (targetUser.id === author.id) {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'jail.self')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
        }

        const dur = parseDuration(rawDuration, lang);
        if (!dur) {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'jail.invalid_dur')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
        }

        const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
        if (!targetMember) {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'jail.not_in_server')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
        }

        /* ── load settings ── */
        const guildCmdsUtil = require('../utils/guildCmds.js');
        const jailCfg       = guildCmdsUtil.resolve(guild.id, 'jail');

        const jailRoleId = jailCfg.addRole;
        if (!jailRoleId) {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'jail.no_role_cfg')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
        }

        const jailRole = await guild.roles.fetch(jailRoleId).catch(() => null);
        if (!jailRole) {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'jail.role_not_found')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
        }

        const allowedIds = jailCfg.showRoom || [];
        if (!allowedIds.length) {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'jail.no_room_cfg')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
        }

        const originalRoles = targetMember.roles.cache
            .filter(r => r.id !== guild.roles.everyone.id)
            .map(r => r.id);

        try {
            await targetMember.roles.set([jailRoleId]);
            await setupChannelPerms(guild, targetUser.id, jailRoleId, allowedIds);
        } catch {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'jail.failed')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
        }

        const caseId  = genCaseId();
        const endTime = dur.ms ? new Date(Date.now() + dur.ms) : null;
        const date    = new Date().toLocaleString('en-US');

        const jailData = {
            caseId, action: 'JAIL', reason,
            duration: dur.text, durationMs: dur.ms,
            endTime: endTime ? endTime.toLocaleString('en-US') : 'permanent',
            moderatorId: author.id, moderator: author.username,
            timestamp: date, originalRoles, jailRoleId,
            userId: targetUser.id, username: targetUser.username
        };
        saveJail(targetUser.id, jailData);

        /* ── auto unjail ── */
        if (dur.ms) {
            setTimeout(async () => {
                try {
                    const unjailMod = require('./unjail.js');
                    await unjailMod.autoUnjail(client, guild, targetUser.id, 'Jail duration expired');
                } catch {}
            }, dur.ms);
        }

        /* ── success card ── */
        const lines = [
            `## 🚨  ${t(lang,'jail.title')}`,
            `${t(lang,'jail.label_case')}  \u2192  \`${caseId}\``,
            `${t(lang,'jail.label_target')}  \u2192  <@${targetUser.id}>`,
            `${t(lang,'jail.label_reason')}  \u2192  ${reason}`,
            `${t(lang,'jail.label_duration')}  \u2192  ${dur.text}`,
        ];
        if (endTime) lines.push(`${t(lang,'jail.label_ends')}  \u2192  <t:${Math.floor(endTime.getTime()/1000)}:R>`);
        lines.push(`${t(lang,'jail.label_mod')}  \u2192  <@${author.id}>`);
        const card = buildCard(ACCENT, lines);

        const botReply = isSlash ? await ctx.reply(card) : await ctx.channel.send(card);
        setTimeout(() => adminGuard.cleanup(guard.cfg, authorMsg, isSlash ? null : botReply), 8000);

        /* ── DM ── */
        if (jailCfg.dm !== false) {
            const dmLines = [
                `${t(lang,'jail.dm_msg')
                    .replace('{guild}', guild.name)
                    .replace('{case}', caseId)
                    .replace('{reason}', reason)
                    .replace('{duration}', dur.text)
                    .replace('{ends}', endTime ? `<t:${Math.floor(endTime.getTime()/1000)}:R>` : (lang==='ar'?'دائم':'Permanent'))
                    .replace('{mod}', author.id)
                    .replace('{date}', date)}`
            ];
            await targetUser.send(buildCard(ACCENT, dmLines)).catch(() => {});
        }

        /* ── log ── */
        if (guard.cfg?.log !== false) {
            await logSystem.logCommandUsage({
                interaction: ctx, commandName: 'jail', moderator: author,
                target: targetUser, reason: `${reason} (Duration: ${dur.text})`, action: 'JAIL'
            }).catch(() => {});
        }
    }
};


/*
 * This project was programmed by the Code Nexus team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/UvEYbFd2rj
 */