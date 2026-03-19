/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

﻿const { SlashCommandBuilder } = require('discord.js');
const guard        = require('../utils/cmdGuard');
const cmdLang      = require('../utils/cmdLang');
const guildSystem  = require('../utils/guildSystem');
const settingsUtil = require('../utils/settings');
const guildCmds    = require('../utils/guildCmds');

const CV2 = 1 << 15;
const C   = { Container: 17, Text: 10, Sep: 14 };

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show all bot commands'),

    textCommand: { name: 'help', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash   = ctx.isCommand?.();
        const guildId   = ctx.guild?.id;
        const channelId = isSlash ? ctx.channelId : ctx.channel.id;

        const g = guard.check('help', guildId, channelId, ctx.member ?? null);
        if (!g.ok) return guard.deny(ctx, g.reason);

        const lang   = guildSystem.resolve(guildId).COMMANDS.lang || 'en';
        const t      = (k) => cmdLang.t(lang, k);
        const cfg    = settingsUtil.get();
        const prefix = guildSystem.resolve(guildId).PREFIX || cfg.system?.PREFIX || '!';

        const publicCmds = [];
        const adminCmds  = [];

        for (const cmd of client.commands.values()) {
            const actionCfg = cfg.actions?.[cmd._actionKey] || cfg.actions?.[cmd.data.name] || {};
            const guildCfg  = guildId ? guildCmds.resolve(guildId, cmd._actionKey) : {};
            const isEnabled = guildCfg.enabled ?? (actionCfg.enabled !== false);
            const label     = actionCfg.label || cmd.data.name;
            const dot       = isEnabled ? '\u2705' : '\u274c';
            const line      = `${dot} \`/${cmd.data.name}\`  \u2022  \`${prefix}${label}\`\n-# ${cmd.data.description}`;
            if (actionCfg.public) publicCmds.push(line);
            else adminCmds.push(line);
        }

        const totalCount = publicCmds.length + adminCmds.length;

        // Split into chunks of max 4000 chars for CV2 Text components
        function chunkLines(lines) {
            const chunks = [];
            let current = '';
            for (const line of lines) {
                const add = current ? '\n\n' + line : line;
                if (current.length + add.length > 4000) {
                    chunks.push(current);
                    current = line;
                } else {
                    current += add;
                }
            }
            if (current) chunks.push(current);
            return chunks;
        }

        const blocks = [
            {
                type: C.Text,
                content: `## \u2699\ufe0f  ${t('help.title')}\n-# ${t('help.count')}: \`${totalCount}\``,
            }
        ];

        if (publicCmds.length) {
            blocks.push({ type: C.Sep, divider: true, spacing: 1 });
            const chunks = chunkLines(publicCmds);
            chunks.forEach((chunk, i) => {
                blocks.push({
                    type: C.Text,
                    content: i === 0
                        ? `**\ud83c\udf10  ${t('help.public')}  (${publicCmds.length})**\n\n${chunk}`
                        : chunk,
                });
            });
        }

        if (adminCmds.length) {
            blocks.push({ type: C.Sep, divider: true, spacing: 1 });
            const chunks = chunkLines(adminCmds);
            chunks.forEach((chunk, i) => {
                blocks.push({
                    type: C.Text,
                    content: i === 0
                        ? `**\ud83d\udd12  ${t('help.admin')}  (${adminCmds.length})**\n\n${chunk}`
                        : chunk,
                });
            });
        }

        const payload = {
            flags: CV2,
            components: [{
                type: C.Container,
                accent_color: 0x27ae60,
                components: blocks,
            }],
        };

        if (isSlash) {
            await ctx.reply({ ...payload, flags: CV2 | 64 });
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