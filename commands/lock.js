/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const adminGuard = require('../utils/adminGuard.js');
const { langOf, t } = require('../utils/cmdLang.js');
const logSystem  = require('../systems/log.js');

const CV2 = 1 << 15;
const C   = { Container: 17, Text: 10, Sep: 14 };
const ACCENT = 0xef4444; // red

function buildCard(color, lines) {
    return {
        flags: CV2,
        components: [{ type: C.Container, accent_color: color,
            components: [{ type: C.Text, content: lines.join('\n') }] }]
    };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('lock')
        .setDescription('Lock a text channel')
        .addChannelOption(o => o.setName('channel').setDescription('Channel to lock').setRequired(true).addChannelTypes(ChannelType.GuildText))
        .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    textCommand: { name: 'lock', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash = ctx.isCommand?.();
        const guild   = ctx.guild;
        const lang    = langOf(guild?.id);
        if (!guild) return;

        const guard = await adminGuard.check('lock', guild.id, ctx.channel || ctx.channelId, ctx.member);
        if (!guard.ok) return adminGuard.deny(ctx, guard.reason);

        const author    = isSlash ? ctx.user : ctx.author;
        const authorMsg = isSlash ? null : ctx;

        let targetChannel, reason;
        if (isSlash) {
            targetChannel = ctx.options.getChannel('channel');
            reason        = ctx.options.getString('reason') || t(lang, 'lock.no_reason');
        } else {
            if (!args.length) {
                const m = await ctx.channel.send(buildCard(0xef4444, [`❌  ${t(lang,'lock.usage')}: !lock <#channel|id> [reason]`]));
                setTimeout(() => m.delete().catch(() => {}), 8000);
                return;
            }
            targetChannel = ctx.mentions?.channels?.first()
                || guild.channels.cache.get(args[0].replace(/[<#>]/g, ''));
            if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
                const m = await ctx.channel.send(buildCard(0xef4444, [`❌  ${t(lang,'lock.not_found')}`]));
                setTimeout(() => m.delete().catch(() => {}), 8000);
                return;
            }
            reason = args.slice(1).join(' ') || t(lang, 'lock.no_reason');
        }

        if (!targetChannel.permissionsFor(client.user)?.has(PermissionFlagsBits.ManageChannels)) {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'lock.no_perm_bot')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err);
            setTimeout(() => m.delete().catch(() => {}), 8000);
            return;
        }

        try {
            await targetChannel.permissionOverwrites.edit(guild.roles.everyone, {
                SendMessages: false, AddReactions: false,
                CreatePublicThreads: false, CreatePrivateThreads: false,
                SendMessagesInThreads: false
            });
        } catch {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'lock.failed')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err);
            setTimeout(() => m.delete().catch(() => {}), 8000);
            return;
        }

        /* notice inside the locked channel */
        await targetChannel.send(buildCard(ACCENT, [
            `## 🔒  ${t(lang,'lock.notice_title')}`,
            `${t(lang,'lock.label_reason')}  \u2192  ${reason}`,
            `${t(lang,'lock.label_mod')}  \u2192  <@${author.id}>`
        ])).catch(() => {});

        /* success card for the moderator */
        const card = buildCard(ACCENT, [
            `## 🔒  ${t(lang,'lock.title')}`,
            `${t(lang,'lock.label_channel')}  \u2192  ${targetChannel}`,
            `${t(lang,'lock.label_reason')}  \u2192  ${reason}`,
            `${t(lang,'lock.label_mod')}  \u2192  <@${author.id}>`
        ]);
        const botReply = isSlash ? await ctx.reply(card) : await ctx.channel.send(card);
        setTimeout(() => adminGuard.cleanup(guard.cfg, authorMsg, isSlash ? null : botReply), 8000);

        if (guard.cfg?.log !== false) {
            await logSystem.logCommandUsage({
                interaction: ctx, commandName: 'lock', moderator: author,
                target: { username: `#${targetChannel.name}`, displayAvatarURL: () => guild.iconURL() },
                reason, action: 'LOCK'
            }).catch(() => {});
        }
    }
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */