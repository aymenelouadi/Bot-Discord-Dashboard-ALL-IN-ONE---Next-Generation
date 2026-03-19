/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

﻿const { SlashCommandBuilder } = require('discord.js');
const guard       = require('../utils/cmdGuard');
const cmdLang     = require('../utils/cmdLang');
const guildSystem = require('../utils/guildSystem');

/* -- Components V2 -- */
const CV2 = 1 << 15;
const C   = { Container: 17, Text: 10, Sep: 14, Section: 9, Thumbnail: 11 };

const BADGE_ICONS = {
    Staff:                 '\ud83d\udc68\u200d\ud83d\udcbc',
    Partner:               '\ud83e\udd1d',
    Hypesquad:             '\ud83c\udfe0',
    BugHunterLevel1:       '\ud83d\udc1b',
    BugHunterLevel2:       '\ud83d\udc1b\u2b50',
    HypeSquadOnlineHouse1: '\ud83d\udfe0',
    HypeSquadOnlineHouse2: '\ud83d\udfe3',
    HypeSquadOnlineHouse3: '\ud83d\udfe1',
    PremiumEarlySupporter: '\u2b50',
    ActiveDeveloper:       '\ud83d\udc68\u200d\ud83d\udcbb',
    VerifiedBot:           '\u2705',
};

function ts(date) {
    if (!date) return 'Unknown';
    return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('user')
        .setDescription('Show user information')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(false)),

    textCommand: { name: 'user', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash   = ctx.isCommand?.();
        const guildId   = ctx.guild?.id;
        const channelId = isSlash ? ctx.channelId : ctx.channel.id;

        const g = guard.check('user', guildId, channelId, ctx.member ?? null);
        if (!g.ok) return guard.deny(ctx, g.reason);

        const lang = guildSystem.resolve(guildId).COMMANDS.lang || 'en';
        const t    = (k) => cmdLang.t(lang, k);

        /* Resolve target */
        let targetUser, targetMember;
        if (isSlash) {
            targetUser   = ctx.options.getUser('user') || ctx.user;
            targetMember = ctx.options.getMember('user') || ctx.member;
        } else {
            targetUser   = ctx.mentions?.users?.first()
                || (args[0] ? await client.users.fetch(args[0]).catch(() => null) : null)
                || ctx.author;
            targetMember = await ctx.guild?.members.fetch(targetUser.id).catch(() => null);
        }

        /* Fetch full profile for badges */
        const fullUser  = await client.users.fetch(targetUser.id, { force: true }).catch(() => targetUser);
        const avatarUrl = targetUser.displayAvatarURL({ extension: 'png', size: 256, forceStatic: false });

        /* Roles — use r.name to avoid pinging */
        const roleArr    = targetMember?.roles?.cache
            .filter(r => r.id !== guildId)
            .sort((a, b) => b.position - a.position)
            .map(r => `\`${r.name}\``)
            .slice(0, 8) || [];
        const extraRoles = (targetMember?.roles?.cache?.size ?? 1) - 1 - roleArr.length;
        const rolesStr   = roleArr.length
            ? roleArr.join(' ') + (extraRoles > 0 ? ` +${extraRoles}` : '')
            : t('user.no_roles');

        /* Badges */
        const badges = (fullUser.flags?.toArray() || [])
            .map(f => BADGE_ICONS[f]).filter(Boolean).join(' ');

        const accentColor = targetMember?.displayColor || 0x27ae60;
        const joined      = targetMember?.joinedAt ? ts(targetMember.joinedAt) : 'Unknown';
        const created     = ts(new Date(targetUser.createdTimestamp));
        const boosting    = targetMember?.premiumSince ? ts(targetMember.premiumSince) : t('user.not_boosting');

        const lines = [
            `## ${targetUser.username}${badges ? '  ' + badges : ''}`,
            ``,
            `**ID:** \`${targetUser.id}\``,
            `**${t('user.joined')}:** ${joined}`,
            `**${t('user.created')}:** ${created}`,
            `**${t('user.boosting')}:** ${boosting}`,
            ``,
            `**${t('user.roles_label')}:** ${rolesStr}`,
        ].join('\n');

        const payload = {
            flags: CV2,
            components: [{
                type: C.Container,
                accent_color: accentColor,
                components: [{
                    type: C.Section,
                    components: [{ type: C.Text, content: lines }],
                    accessory: {
                        type: C.Thumbnail,
                        media: { url: avatarUrl },
                        description: targetUser.username,
                    },
                }],
            }],
        };

        if (isSlash) {
            await ctx.reply(payload);
        } else {
            const reply = await ctx.reply(payload);
            await guard.cleanup(g.cfg, ctx, reply);
        }
    },
};

/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */