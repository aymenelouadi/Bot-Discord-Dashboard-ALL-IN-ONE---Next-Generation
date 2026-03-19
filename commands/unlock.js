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
const ACCENT = 0x22c55e; // green

function buildCard(color, lines) {
    return {
        flags: CV2,
        components: [{ type: C.Container, accent_color: color,
            components: [{ type: C.Text, content: lines.join('\n') }] }]
    };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unlock')
        .setDescription('Unlock a text channel')
        .addChannelOption(o => o.setName('channel').setDescription('Channel to unlock').setRequired(true).addChannelTypes(ChannelType.GuildText))
        .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    textCommand: { name: 'unlock', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash = ctx.isCommand?.();
        const guild   = ctx.guild;
        const lang    = langOf(guild?.id);
        if (!guild) return;

        const guard = await adminGuard.check('unlock', guild.id, ctx.channel || ctx.channelId, ctx.member);
        if (!guard.ok) return adminGuard.deny(ctx, guard.reason);

        const author    = isSlash ? ctx.user : ctx.author;
        const authorMsg = isSlash ? null : ctx;

        let targetChannel, reason;
        if (isSlash) {
            targetChannel = ctx.options.getChannel('channel');
            reason        = ctx.options.getString('reason') || t(lang, 'unlock.no_reason');
        } else {
            if (!args.length) {
                const m = await ctx.channel.send(buildCard(0xef4444, [`❌  ${t(lang,'unlock.usage')}: !unlock <#channel|id> [reason]`]));
                setTimeout(() => m.delete().catch(() => {}), 8000);
                return;
            }
            targetChannel = ctx.mentions?.channels?.first()
                || guild.channels.cache.get(args[0].replace(/[<#>]/g, ''));
            if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
                const m = await ctx.channel.send(buildCard(0xef4444, [`❌  ${t(lang,'unlock.not_found')}`]));
                setTimeout(() => m.delete().catch(() => {}), 8000);
                return;
            }
            reason = args.slice(1).join(' ') || t(lang, 'unlock.no_reason');
        }

        if (!targetChannel.permissionsFor(client.user)?.has(PermissionFlagsBits.ManageChannels)) {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'unlock.no_perm_bot')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err);
            setTimeout(() => m.delete().catch(() => {}), 8000);
            return;
        }

        try {
            /* reset to inherit (null), not forcing true */
            await targetChannel.permissionOverwrites.edit(guild.roles.everyone, {
                SendMessages: null, AddReactions: null,
                CreatePublicThreads: null, CreatePrivateThreads: null,
                SendMessagesInThreads: null
            });
        } catch {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'unlock.failed')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err);
            setTimeout(() => m.delete().catch(() => {}), 8000);
            return;
        }

        /* notice inside the unlocked channel */
        await targetChannel.send(buildCard(ACCENT, [
            `## 🔓  ${t(lang,'unlock.notice_title')}`,
            `${t(lang,'unlock.label_reason')}  \u2192  ${reason}`,
            `${t(lang,'unlock.label_mod')}  \u2192  <@${author.id}>`
        ])).catch(() => {});

        /* success card for the moderator */
        const card = buildCard(ACCENT, [
            `## 🔓  ${t(lang,'unlock.title')}`,
            `${t(lang,'unlock.label_channel')}  \u2192  ${targetChannel}`,
            `${t(lang,'unlock.label_reason')}  \u2192  ${reason}`,
            `${t(lang,'unlock.label_mod')}  \u2192  <@${author.id}>`
        ]);
        const botReply = isSlash ? await ctx.reply(card) : await ctx.channel.send(card);
        setTimeout(() => adminGuard.cleanup(guard.cfg, authorMsg, isSlash ? null : botReply), 8000);

        if (guard.cfg?.log !== false) {
            await logSystem.logCommandUsage({
                interaction: ctx, commandName: 'unlock', moderator: author,
                target: { username: `#${targetChannel.name}`, displayAvatarURL: () => guild.iconURL() },
                reason, action: 'UNLOCK'
            }).catch(() => {});
        }
    }
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */