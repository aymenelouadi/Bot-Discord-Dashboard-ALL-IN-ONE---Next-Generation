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
        .setName('court_set_log')
        .setDescription('تغيير قناة السجلات')
        .addChannelOption(o => o.setName('channel').setDescription('قناة السجلات').setRequired(true)
            .addChannelTypes(ChannelType.GuildText)),
    textCommand: { name: 'cslog', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash = ctx.isCommand?.();
        const guild   = ctx.guild;
        const lang    = langOf(guild?.id);
        if (!guild) return;

        const guard = await adminGuard.check('court_set_log', guild.id, ctx.channel || ctx.channelId, ctx.member);
        if (!guard.ok) return adminGuard.deny(ctx, guard.reason);

        const author    = isSlash ? ctx.user : ctx.author;
        const authorMsg = isSlash ? null : ctx;

        let channel;
        if (isSlash) {
            channel = ctx.options.getChannel('channel');
        } else {
            channel = ctx.mentions?.channels?.first();
            if (!channel) {
                const m = await ctx.channel.send(buildCard(0xef4444, [`❌  ${t(lang,'court_set_log.usage')}: !cslog <#channel>`]));
                setTimeout(() => m.delete().catch(() => {}), 8000); return;
            }
        }

        try {
            const settings = settingsUtil.get();
            settings.court.logChannel = channel.id;
            settingsUtil.save(settings);
        } catch {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'court_set_log.failed')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
        }

        const card = buildCard(ACCENT, [
            `## ⚖️  ${t(lang,'court_set_log.title')}`,
            `${t(lang,'court_set_log.label_channel')}  →  <#${channel.id}>`,
            `${t(lang,'court_set_log.label_mod')}  →  <@${author.id}>`,
        ]);
        const botReply = isSlash ? await ctx.reply({ ...card, ephemeral: true }) : await ctx.channel.send(card);
        if (!isSlash) setTimeout(() => adminGuard.cleanup(guard.cfg, authorMsg, botReply), 8000);

        if (guard.cfg?.log !== false) {
            await logSystem.logCommandUsage({ interaction: ctx, commandName: 'court_set_log',
                moderator: author, target: author, reason: `Log channel → #${channel.name}`, action: 'COURT_SET_LOG' }).catch(() => {});
        }
    }
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */