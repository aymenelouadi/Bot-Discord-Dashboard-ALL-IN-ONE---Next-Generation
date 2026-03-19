/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const adminGuard = require('../utils/adminGuard.js');
const { langOf, t } = require('../utils/cmdLang.js');
const logSystem  = require('../systems/log.js');

const CV2 = 1 << 15;
const C   = { Container: 17, Text: 10, Sep: 14 };
const ACCENT = 0x8b5cf6; // violet

function buildCard(color, lines) {
    return {
        flags: CV2,
        components: [{ type: C.Container, accent_color: color,
            components: [{ type: C.Text, content: lines.join('\n') }] }]
    };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('say')
        .setDescription('Send a message as the bot')
        .addStringOption(o => o.setName('message').setDescription('Message to send').setRequired(true))
        .addChannelOption(o => o.setName('channel').setDescription('Target channel (default: current)').setRequired(false)),

    textCommand: { name: 'say', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash = ctx.isCommand?.();
        const guild   = ctx.guild;
        const lang    = langOf(guild?.id);
        if (!guild) return;

        const guard = await adminGuard.check('say', guild.id, ctx.channel || ctx.channelId, ctx.member);
        if (!guard.ok) return adminGuard.deny(ctx, guard.reason);

        const author    = isSlash ? ctx.user : ctx.author;
        const authorMsg = isSlash ? null : ctx;

        let targetChannel, message;

        if (isSlash) {
            message       = ctx.options.getString('message');
            targetChannel = ctx.options.getChannel('channel') || ctx.channel;
        } else {
            if (!args.length) {
                const m = await ctx.channel.send(buildCard(0xef4444, [`❌  ${t(lang,'say.usage')}: !say [#channel] <message>`]));
                setTimeout(() => m.delete().catch(() => {}), 8000);
                return;
            }
            const first = args[0];
            const mentionedCh = ctx.mentions?.channels?.first();
            if (mentionedCh) {
                targetChannel = mentionedCh;
                message = args.slice(1).join(' ');
            } else if (/^<#\d+>$/.test(first)) {
                const id = first.replace(/[<#>]/g, '');
                targetChannel = guild.channels.cache.get(id) || ctx.channel;
                message = args.slice(1).join(' ');
            } else {
                targetChannel = ctx.channel;
                message = args.join(' ');
            }
        }

        if (!targetChannel) {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'say.not_found')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err);
            setTimeout(() => m.delete().catch(() => {}), 8000);
            return;
        }

        if (!message?.trim()) {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'say.empty')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err);
            setTimeout(() => m.delete().catch(() => {}), 8000);
            return;
        }

        try {
            await targetChannel.send(message);
        } catch {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'say.failed')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err);
            setTimeout(() => m.delete().catch(() => {}), 8000);
            return;
        }

        const card = buildCard(ACCENT, [
            `## 📢  ${t(lang,'say.title')}`,
            `${t(lang,'say.label_channel')}  \u2192  ${targetChannel}`,
            `${t(lang,'say.label_mod')}  \u2192  <@${author.id}>`,
        ]);
        if (isSlash) {
            await ctx.reply({ ...card, ephemeral: true });
        } else {
            const botReply = await ctx.channel.send(card);
            setTimeout(() => adminGuard.cleanup(guard.cfg, authorMsg, botReply), 8000);
        }

        if (guard.cfg?.log !== false) {
            await logSystem.logCommandUsage({
                interaction: ctx, commandName: 'say', moderator: author,
                target: { username: `#${targetChannel.name}`, displayAvatarURL: () => guild.iconURL() },
                reason: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
                action: 'SAY'
            }).catch(() => {});
        }
    }
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */