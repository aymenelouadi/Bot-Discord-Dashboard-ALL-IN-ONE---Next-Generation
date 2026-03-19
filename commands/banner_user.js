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
const C   = { Container: 17, Text: 10, MediaGallery: 12, Section: 9, Thumbnail: 11 };

module.exports = {
    data: new SlashCommandBuilder()
        .setName('userbanner')
        .setDescription('Show a user banner')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(false)),

    textCommand: { name: 'bu', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash   = ctx.isCommand?.();
        const guildId   = ctx.guild?.id;
        const channelId = isSlash ? ctx.channelId : ctx.channel.id;

        const g = guard.check('banner_user', guildId, channelId, ctx.member ?? null);
        if (!g.ok) return guard.deny(ctx, g.reason);

        const lang = guildSystem.resolve(guildId).COMMANDS.lang || 'en';
        const t    = (k) => cmdLang.t(lang, k);

        /* Resolve target */
        let targetUser;
        if (isSlash) {
            targetUser = ctx.options.getUser('user') || ctx.user;
        } else {
            targetUser = ctx.mentions?.users?.first()
                || (args[0] ? await client.users.fetch(args[0]).catch(() => null) : null)
                || ctx.author;
        }

        const user       = await client.users.fetch(targetUser.id, { force: true });
        const accentInt  = user.hexAccentColor ? parseInt(user.hexAccentColor.replace('#', ''), 16) : 0x5865f2;
        const avatarUrl  = user.displayAvatarURL({ extension: 'png', size: 256 });

        if (!user.banner) {
            const payload = {
                flags: CV2,
                components: [{
                    type: C.Container, accent_color: accentInt,
                    components: [{
                        type: C.Section,
                        components: [{ type: C.Text, content: `## \ud83d\uddbc\ufe0f  ${t('banner_user.title')}\n\n${t('banner_user.no_banner')}\n-# ${user.username}` }],
                        accessory: { type: C.Thumbnail, media: { url: avatarUrl }, description: user.username },
                    }],
                }],
            };
            return isSlash ? ctx.reply(payload) : ctx.reply(payload);
        }

        const ext       = user.banner.startsWith('a_') ? 'gif' : 'png';
        const bannerUrl = `https://cdn.discordapp.com/banners/${user.id}/${user.banner}.${ext}?size=4096`;

        const payload = {
            flags: CV2,
            components: [{
                type: C.Container,
                accent_color: accentInt,
                components: [
                    { type: C.Text, content: `## \ud83d\uddbc\ufe0f  ${t('banner_user.title')}\n-# ${user.username}` },
                    { type: C.MediaGallery, items: [{ media: { url: bannerUrl }, description: user.username }] },
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