/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const adminGuard   = require('../utils/adminGuard.js');
const { langOf, t } = require('../utils/cmdLang.js');
const logSystem    = require('../systems/log.js');
const settingsUtil = require('../utils/settings');

const CV2 = 1 << 15;
const C   = { Container: 17, Text: 10, Sep: 14 };
const ACCENT = 0xffd700;

function buildCard(color, lines) {
    return { flags: CV2, components: [{ type: C.Container, accent_color: color,
        components: [{ type: C.Text, content: lines.join('\n') }] }] };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('court_set_color')
        .setDescription('تغيير لون المحكمة')
        .addStringOption(o => o.setName('color').setDescription('لون Hex مثال: #FFD700').setRequired(true)),
    textCommand: { name: 'cscolor', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash = ctx.isCommand?.();
        const guild   = ctx.guild;
        const lang    = langOf(guild?.id);
        if (!guild) return;

        const guard = await adminGuard.check('court_set_color', guild.id, ctx.channel || ctx.channelId, ctx.member);
        if (!guard.ok) return adminGuard.deny(ctx, guard.reason);

        const author    = isSlash ? ctx.user : ctx.author;
        const authorMsg = isSlash ? null : ctx;

        let color;
        if (isSlash) {
            color = ctx.options.getString('color');
        } else {
            if (!args.length) {
                const m = await ctx.channel.send(buildCard(0xef4444, [`❌  ${t(lang,'court_set_color.usage')}: !cscolor #FFD700`]));
                setTimeout(() => m.delete().catch(() => {}), 8000); return;
            }
            color = args[0];
        }

        if (!/^#([A-Fa-f0-9]{6})$/.test(color)) {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'court_set_color.invalid')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
        }

        try {
            const settings = settingsUtil.get();
            settings.court.color = color;
            settingsUtil.save(settings);
        } catch {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'court_set_color.failed')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
        }

        const card = buildCard(ACCENT, [
            `## ⚖️  ${t(lang,'court_set_color.title')}`,
            `${t(lang,'court_set_color.label_color')}  →  ${color}`,
            `${t(lang,'court_set_color.label_mod')}  →  <@${author.id}>`,
        ]);
        const botReply = isSlash ? await ctx.reply({ ...card, ephemeral: true }) : await ctx.channel.send(card);
        if (!isSlash) setTimeout(() => adminGuard.cleanup(guard.cfg, authorMsg, botReply), 8000);

        if (guard.cfg?.log !== false) {
            await logSystem.logCommandUsage({ interaction: ctx, commandName: 'court_set_color',
                moderator: author, target: author, reason: `Color → ${color}`, action: 'COURT_SET_COLOR' }).catch(() => {});
        }
    }
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */