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
const ACCENT = 0x3b82f6; // blue

function buildCard(color, lines) {
    return {
        flags: CV2,
        components: [{ type: C.Container, accent_color: color,
            components: [{ type: C.Text, content: lines.join('\n') }] }]
    };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('rename')
        .setDescription('Rename a channel')
        .addStringOption(o => o.setName('name').setDescription('New name').setRequired(true))
        .addChannelOption(o => o.setName('channel').setDescription('Channel to rename (default: current)').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    textCommand: { name: 'rename', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash = ctx.isCommand?.();
        const guild   = ctx.guild;
        const lang    = langOf(guild?.id);
        if (!guild) return;

        const guard = await adminGuard.check('rename', guild.id, ctx.channel || ctx.channelId, ctx.member);
        if (!guard.ok) return adminGuard.deny(ctx, guard.reason);

        const author    = isSlash ? ctx.user : ctx.author;
        const authorMsg = isSlash ? null : ctx;

        let targetChannel, newName;

        if (isSlash) {
            newName       = ctx.options.getString('name');
            targetChannel = ctx.options.getChannel('channel') || ctx.channel;
        } else {
            if (!args.length) {
                const m = await ctx.channel.send(buildCard(0xef4444, [`❌  ${t(lang,'rename.usage')}: !rename [#channel|id] <new-name>`]));
                setTimeout(() => m.delete().catch(() => {}), 8000);
                return;
            }
            /* detect if first arg is a channel */
            const mentionedCh = ctx.mentions?.channels?.first();
            if (mentionedCh && args.length >= 2) {
                targetChannel = mentionedCh;
                newName = args.slice(1).join('-');
            } else if (/^\d{17,20}$/.test(args[0]) && args.length >= 2) {
                targetChannel = guild.channels.cache.get(args[0]) || ctx.channel;
                newName = args.slice(1).join('-');
            } else {
                targetChannel = ctx.channel;
                newName = args.join('-');
            }
        }

        if (!newName?.trim()) {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'rename.empty_name')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err);
            setTimeout(() => m.delete().catch(() => {}), 8000);
            return;
        }

        if (!targetChannel.permissionsFor(client.user)?.has(PermissionFlagsBits.ManageChannels)) {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'rename.no_perm_bot')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err);
            setTimeout(() => m.delete().catch(() => {}), 8000);
            return;
        }

        const oldName = targetChannel.name;
        try {
            await targetChannel.setName(newName.trim());
        } catch {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'rename.failed')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err);
            setTimeout(() => m.delete().catch(() => {}), 8000);
            return;
        }

        const card = buildCard(ACCENT, [
            `## ✏️  ${t(lang,'rename.title')}`,
            `${t(lang,'rename.label_old')}  \u2192  \`${oldName}\``,
            `${t(lang,'rename.label_new')}  \u2192  \`${newName.trim()}\``,
            `${t(lang,'rename.label_channel')}  \u2192  ${targetChannel}`,
            `${t(lang,'rename.label_mod')}  \u2192  <@${author.id}>`,
        ]);
        const botReply = isSlash ? await ctx.reply(card) : await ctx.channel.send(card);
        setTimeout(() => adminGuard.cleanup(guard.cfg, authorMsg, isSlash ? null : botReply), 8000);

        if (guard.cfg?.log !== false) {
            await logSystem.logCommandUsage({
                interaction: ctx, commandName: 'rename', moderator: author,
                target: { username: `#${oldName} → ${newName.trim()}`, displayAvatarURL: () => guild.iconURL() },
                reason: `Renamed #${oldName} → ${newName.trim()}`,
                action: 'RENAME'
            }).catch(() => {});
        }
    }
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */