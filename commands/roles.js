/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const { SlashCommandBuilder } = require('discord.js');
const adminGuard = require('../utils/adminGuard.js');
const { langOf, t } = require('../utils/cmdLang.js');

const CV2 = 1 << 15;
const C   = { Container: 17, Text: 10, Sep: 14 };

module.exports = {
    data: new SlashCommandBuilder()
        .setName('roles')
        .setDescription('List all server roles'),

    textCommand: { name: 'roles', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash = ctx.isCommand?.();
        const guild   = ctx.guild;
        const lang    = langOf(guild?.id);
        if (!guild) return;

        const guard = await adminGuard.check('roles', guild.id, ctx.channel || ctx.channelId, ctx.member);
        if (!guard.ok) return adminGuard.deny(ctx, guard.reason);

        const authorMsg = isSlash ? null : ctx;

        const allRoles = await guild.roles.fetch();
        const sorted   = [...allRoles
            .filter(r => r.id !== guild.id)
            .sort((a, b) => b.position - a.position)
            .values()
        ];

        if (!sorted.length) {
            const empty = { flags: CV2, components: [{ type: C.Container, accent_color: 0x27ae60,
                components: [{ type: C.Text, content: t(lang,'roles.no_roles') }] }] };
            const m = isSlash ? await ctx.reply(empty) : await ctx.reply(empty);
            if (!isSlash) setTimeout(() => adminGuard.cleanup(guard.cfg, authorMsg, m), 10000);
            return;
        }

        const CHUNK = 25;
        const pages = [];
        for (let i = 0; i < sorted.length; i += CHUNK) pages.push(sorted.slice(i, i + CHUNK));

        const textBlocks = pages.map((chunk, idx) => {
            const header = pages.length > 1
                ? `**${t(lang,'roles.title')} — ${t(lang,'roles.page')} ${idx+1}/${pages.length}**\n\n`
                : `**${t(lang,'roles.title')}** — \`${sorted.length}\` ${t(lang,'roles.total')}\n\n`;

            const lines = chunk.map(r => {
                const admin = r.permissions.has('Administrator') ? ' ⭐' : '';
                return `\`${r.name}\`  \`${r.members.size}\`${admin}`;
            }).join('\n');

            return { type: C.Text, content: header + lines };
        });

        const components = [];
        textBlocks.forEach((block, i) => {
            components.push(block);
            if (i < textBlocks.length - 1) components.push({ type: C.Sep, divider: true, spacing: 1 });
        });

        const payload = { flags: CV2, components: [{ type: C.Container, accent_color: 0x27ae60, components }] };

        if (isSlash) {
            await ctx.reply(payload);
        } else {
            const botReply = await ctx.reply(payload);
            setTimeout(() => adminGuard.cleanup(guard.cfg, authorMsg, botReply), 15000);
        }
    }
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */