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
const C   = { Container: 17, Text: 10, Section: 9, Thumbnail: 11, MediaGallery: 12 };

module.exports = {
    data: new SlashCommandBuilder()
        .setName('logo')
        .setDescription('Show the server icon'),

    textCommand: { name: 'lg', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash   = ctx.isCommand?.();
        const guildId   = ctx.guild?.id;
        const channelId = isSlash ? ctx.channelId : ctx.channel.id;

        const g = guard.check('logo_server', guildId, channelId, ctx.member ?? null);
        if (!g.ok) return guard.deny(ctx, g.reason);

        const lang = guildSystem.resolve(guildId).COMMANDS.lang || 'en';
        const t    = (k) => cmdLang.t(lang, k);

        const guild = ctx.guild;

        if (!guild?.icon) {
            const payload = {
                flags: CV2,
                components: [{
                    type: C.Container, accent_color: 0x5865f2,
                    components: [{ type: C.Text, content: `## \ud83d\udcf7  ${t('logo_server.title')}\n\n${t('logo_server.no_logo')}` }],
                }],
            };
            return isSlash ? ctx.reply(payload) : ctx.reply(payload);
        }

        const fullUrl = guild.iconURL({ extension: 'png', size: 4096, forceStatic: false });

        const payload = {
            flags: CV2,
            components: [{
                type: C.Container,
                accent_color: 0x5865f2,
                components: [
                    { type: C.Text, content: `## \ud83d\udcf7  ${t('logo_server.title')}\n-# ${guild.name}` },
                    { type: C.MediaGallery, items: [{ media: { url: fullUrl }, description: guild.name }] },
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