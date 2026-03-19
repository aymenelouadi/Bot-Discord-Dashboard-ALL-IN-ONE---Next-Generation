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

const VERIF       = { 0: 'None', 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Very High' };
const BOOST_LEVEL = {
    0: 'None',
    1: 'Level 1 \u2728',
    2: 'Level 2 \ud83d\udcab',
    3: 'Level 3 \ud83c\udf1f',
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('server')
        .setDescription('Show server information'),

    textCommand: { name: 'server', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash   = ctx.isCommand?.();
        const guildId   = ctx.guild?.id;
        const channelId = isSlash ? ctx.channelId : ctx.channel.id;

        const g = guard.check('server', guildId, channelId, ctx.member ?? null);
        if (!g.ok) return guard.deny(ctx, g.reason);

        const lang = guildSystem.resolve(guildId).COMMANDS.lang || 'en';
        const t    = (k) => cmdLang.t(lang, k);

        const guild = ctx.guild;
        await guild.members.fetch().catch(() => {});

        const owner   = await guild.fetchOwner().catch(() => null);
        const ch      = guild.channels.cache;
        const textCh  = ch.filter(c => c.type === 0).size;
        const voiceCh = ch.filter(c => c.type === 2).size;
        const cats    = ch.filter(c => c.type === 4).size;

        const online  = guild.members.cache.filter(m =>
            m.presence?.status && m.presence.status !== 'offline'
        ).size;
        const inVoice = guild.members.cache.filter(m =>
            m.voice.channel && !m.user.bot
        ).size;

        const boosts     = guild.premiumSubscriptionCount || 0;
        const boostLevel = BOOST_LEVEL[guild.premiumTier] || 'None';
        const roleCount  = guild.roles.cache.size - 1;
        const emojiCount = guild.emojis.cache.size;
        const created    = `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`;
        const iconUrl    = guild.iconURL({ extension: 'png', size: 256 }) || '';

        const bull = '\u2022';
        const lines = [
            `## ${guild.name}`,
            ``,
            `**ID:** \`${guild.id}\``,
            `**${t('server.owner')}:** ${owner ? `<@${owner.id}>` : 'Unknown'}`,
            `**${t('server.created')}:** ${created}`,
            `**${t('server.verification')}:** ${VERIF[guild.verificationLevel] || 'Unknown'}`,
            ``,
            `\ud83d\udc65 **${t('server.members')}:** \`${guild.memberCount}\`  ${bull}  \ud83d\udfe2 ${t('server.online')}: \`${online}\`  ${bull}  \ud83d\udd0a ${t('server.in_voice')}: \`${inVoice}\``,
            `\ud83d\udcac **${t('server.channels')}:** Text \`${textCh}\`  ${bull}  Voice \`${voiceCh}\`  ${bull}  Categories \`${cats}\``,
            `\ud83c\udff7\ufe0f **${t('server.roles')}:** \`${roleCount}\`  ${bull}  \ud83d\ude04 Emojis: \`${emojiCount}\``,
            `\ud83d\udc8e **${t('server.boosts')}:** \`${boosts}\`  (${boostLevel})`,
        ].join('\n');

        const innerComponents = iconUrl
            ? [{
                type: C.Section,
                components: [{ type: C.Text, content: lines }],
                accessory: {
                    type: C.Thumbnail,
                    media: { url: iconUrl },
                    description: guild.name,
                },
            }]
            : [{ type: C.Text, content: lines }];

        const payload = {
            flags: CV2,
            components: [{
                type: C.Container,
                accent_color: 0x5865f2,
                components: innerComponents,
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