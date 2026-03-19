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
const C   = { Container: 17, Text: 10, MediaGallery: 12 };

module.exports = {
    data: new SlashCommandBuilder()
        .setName('banner')
        .setDescription('Show the server banner'),

    textCommand: { name: 'bn', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash   = ctx.isCommand?.();
        const guildId   = ctx.guild?.id;
        const channelId = isSlash ? ctx.channelId : ctx.channel.id;

        const g = guard.check('banner_server', guildId, channelId, ctx.member ?? null);
        if (!g.ok) return guard.deny(ctx, g.reason);

        const lang = guildSystem.resolve(guildId).COMMANDS.lang || 'en';
        const t    = (k) => cmdLang.t(lang, k);

        const guild = await client.guilds.fetch(guildId);

        if (!guild.banner) {
            const payload = {
                flags: CV2,
                components: [{
                    type: C.Container, accent_color: 0x5865f2,
                    components: [{ type: C.Text, content: `## \ud83d\uddbc\ufe0f  ${t('banner_server.title')}\n\n${t('banner_server.no_banner')}` }],
                }],
            };
            return isSlash ? ctx.reply(payload) : ctx.reply(payload);
        }

        const bannerUrl = guild.bannerURL({ extension: 'png', size: 4096 });

        const payload = {
            flags: CV2,
            components: [{
                type: C.Container,
                accent_color: 0x5865f2,
                components: [
                    { type: C.Text, content: `## \ud83d\uddbc\ufe0f  ${t('banner_server.title')}\n-# ${guild.name}` },
                    { type: C.MediaGallery, items: [{ media: { url: bannerUrl }, description: guild.name }] },
                ],
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