/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const path       = require('path');
const adminGuard = require('../utils/adminGuard.js');
const { langOf, t } = require('../utils/cmdLang.js');
const logSystem  = require('../systems/log.js');

const CV2 = 1 << 15;
const C   = { Container: 17, Text: 10, Sep: 14 };
const ACCENT = 0xa78bfa; // violet-400

function parseTime(raw) {
    if (!raw) return null;
    const m = raw.trim().match(/^(\d+)(s|m|h|d|mo)$/i);
    if (!m) return null;
    const v = parseInt(m[1]), u = m[2].toLowerCase();
    return u === 's' ? v * 1000
         : u === 'm' ? v * 60000
         : u === 'h' ? v * 3600000
         : u === 'd' ? v * 86400000
         : /* mo */    v * 2592000000;
}

function fmtTime(raw, lang) {
    const m = raw.trim().match(/^(\d+)(s|m|h|d|mo)$/i);
    if (!m) return raw;
    const v = m[1], u = m[2].toLowerCase();
    if (lang === 'ar') {
        return u === 's' ? `${v} ثانية` : u === 'm' ? `${v} دقيقة`
             : u === 'h' ? `${v} ساعة` : u === 'd' ? `${v} يوم`
             : `${v} شهر`;
    }
    return u === 's' ? `${v}s` : u === 'm' ? `${v}m`
         : u === 'h' ? `${v}h` : u === 'd' ? `${v}d` : `${v}mo`;
}

function buildCard(color, lines) {
    return { flags: CV2, components: [{ type: C.Container, accent_color: color,
        components: [{ type: C.Text, content: lines.join('\n') }] }] };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('temp_role')
        .setDescription('Give a member a temporary role')
        .addUserOption(o => o.setName('user').setDescription('Target member').setRequired(true))
        .addRoleOption(o => o.setName('role').setDescription('Role to assign').setRequired(true))
        .addStringOption(o => o.setName('time').setDescription('e.g. 30s 5m 2h 1d 1mo').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

    textCommand: { name: 'tr', aliases: ['temp_role'] },

    async execute(client, ctx, args) {
        const isSlash = ctx.isCommand?.();
        const guild   = ctx.guild;
        const lang    = langOf(guild?.id);
        if (!guild) return;

        const guard = await adminGuard.check('temp_role', guild.id, ctx.channel || ctx.channelId, ctx.member);
        if (!guard.ok) return adminGuard.deny(ctx, guard.reason);

        const author    = isSlash ? ctx.user : ctx.author;
        const authorMsg = isSlash ? null : ctx;

        let targetUser, targetRole, rawTime;

        if (isSlash) {
            targetUser = ctx.options.getUser('user');
            targetRole = ctx.options.getRole('role');
            rawTime    = ctx.options.getString('time');
        } else {
            if (args.length < 3) {
                const m = await ctx.channel.send(buildCard(0xef4444, [`❌  ${t(lang,'temp_role.usage')}: !tr <@user> <@role> <time>`]));
                setTimeout(() => m.delete().catch(() => {}), 8000); return;
            }
            targetUser = ctx.mentions?.users?.first();
            targetRole = ctx.mentions?.roles?.first();
            if (!targetUser || !targetRole) {
                const m = await ctx.channel.send(buildCard(0xef4444, [`❌  ${t(lang,'temp_role.mention_required')}`]));
                setTimeout(() => m.delete().catch(() => {}), 8000); return;
            }
            rawTime = args[2];
        }

        const timeMs = parseTime(rawTime);
        if (!timeMs) {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'temp_role.invalid_time')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
        }

        const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
        if (!targetMember) {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'temp_role.not_in_server')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
        }

        const botMember = await guild.members.fetchMe();
        if (targetRole.position >= botMember.roles.highest.position) {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'temp_role.role_too_high')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
        }

        if (targetMember.roles.cache.has(targetRole.id)) {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'temp_role.already_has')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
        }

        await targetMember.roles.add(targetRole);

        /* persist to db */
        const dbPath = require('path').join(__dirname, '../database/temp_role.json');
        let db = {};
        try { db = JSON.parse(require('fs').readFileSync(dbPath, 'utf8')); } catch {}
        const key = `${guild.id}_${targetUser.id}_${targetRole.id}`;
        db[key] = {
            guildId: guild.id, userId: targetUser.id, roleId: targetRole.id,
            roleName: targetRole.name, expireAt: Date.now() + timeMs,
            givenBy: author.id, givenAt: Date.now()
        };
        require('fs').writeFileSync(dbPath, JSON.stringify(db, null, 2));

        /* auto-remove after timeout */
        setTimeout(async () => {
            try {
                const m = await guild.members.fetch(targetUser.id);
                if (m && m.roles.cache.has(targetRole.id)) await m.roles.remove(targetRole);
                let dbs = {};
                try { dbs = JSON.parse(require('fs').readFileSync(dbPath, 'utf8')); } catch {}
                delete dbs[key];
                require('fs').writeFileSync(dbPath, JSON.stringify(dbs, null, 2));
            } catch {}
        }, timeMs);

        const timeText = fmtTime(rawTime, lang);
        const expireTs = Math.floor((Date.now() + timeMs) / 1000);

        const card = buildCard(ACCENT, [
            `## ⏳  ${t(lang,'temp_role.title')}`,
            `${t(lang,'temp_role.label_target')}  \u2192  <@${targetUser.id}>`,
            `${t(lang,'temp_role.label_role')}    \u2192  <@&${targetRole.id}>`,
            `${t(lang,'temp_role.label_duration')}  \u2192  ${timeText}`,
            `${t(lang,'temp_role.label_ends')}  \u2192  <t:${expireTs}:R>`,
            `${t(lang,'temp_role.label_mod')}  \u2192  <@${author.id}>`,
        ]);
        const botReply = isSlash ? await ctx.reply(card) : await ctx.channel.send(card);
        setTimeout(() => adminGuard.cleanup(guard.cfg, authorMsg, isSlash ? null : botReply), 8000);

        /* DM */
        await targetUser.send(buildCard(ACCENT, [
            t(lang,'temp_role.dm_msg')
                .replace('{guild}', guild.name).replace('{role}', targetRole.name)
                .replace('{duration}', timeText).replace('{ends}', `<t:${expireTs}:R>`)
                .replace('{mod}', author.id)
        ])).catch(() => {});

        if (guard.cfg?.log !== false) {
            await logSystem.logCommandUsage({
                interaction: ctx, commandName: 'temp_role', moderator: author,
                target: targetUser, reason: `Temp role ${targetRole.name} for ${timeText}`, action: 'TEMP_ROLE'
            }).catch(() => {});
        }
    }
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */