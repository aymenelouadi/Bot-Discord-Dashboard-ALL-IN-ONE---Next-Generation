/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

﻿const { SlashCommandBuilder } = require('discord.js');
const guard = require('../utils/cmdGuard');

/* Components V2 */
const CV2 = 1 << 15;
const C   = { Container: 17, Text: 10, Sep: 14, Section: 9, Thumbnail: 11, MediaGallery: 12 };

module.exports = {
    data: new SlashCommandBuilder()
        .setName('avatar')
        .setDescription('Show a user avatar')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(false)),

    textCommand: { name: 'avatar', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash   = ctx.isCommand?.();
        const guildId   = ctx.guild?.id;
        const channelId = isSlash ? ctx.channelId : ctx.channel.id;

        const g = guard.check('avatar', guildId, channelId, ctx.member ?? null);
        if (!g.ok) return guard.deny(ctx, g.reason);

        /* Resolve target user */
        let target;
        if (isSlash) {
            target = ctx.options.getUser('user') || ctx.user;
        } else {
            target = ctx.mentions?.users?.first()
                || (args[0] ? await client.users.fetch(args[0]).catch(() => null) : null)
                || ctx.author;
        }

        const url = target.displayAvatarURL({ extension: 'png', size: 1024, forceStatic: false });

        /* Components V2: Section (text + thumbnail) + gallery for full view */
        const payload = {
            flags: CV2,
            components: [{
                type: C.Container,
                accent_color: 0x7c3aed,
                components: [
                    {
                        type: C.Section,
                        components: [{
                            type: C.Text,
                            content: `### 🖼️  ${target.username}\n-# [Open full size](${url})`,
                        }],
                        accessory: {
                            type: C.Thumbnail,
                            media: { url },
                            description: `${target.username}'s avatar`,
                        },
                    },
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