/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const adminGuard   = require('../utils/adminGuard.js');
const { langOf, t } = require('../utils/cmdLang.js');
const logSystem    = require('../systems/log.js');
const settingsUtil = require('../utils/settings');
const db           = require('../systems/schemas');

const CV2 = 1 << 15;
const C   = { Container: 17, Text: 10, Sep: 14 };
const ACCENT = 0x22c55e; // green

function buildCard(color, lines) {
    return { flags: CV2, components: [{ type: C.Container, accent_color: color,
        components: [{ type: C.Text, content: lines.join('\n') }] }] };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unban_all')
        .setDescription('Lift all active bans on this server'),
    textCommand: { name: 'unban_all', aliases: ['unbanall'] },

    async execute(client, ctx, args) {
        const isSlash = ctx.isCommand?.();
        const guild   = ctx.guild;
        const lang    = langOf(guild?.id);
        if (!guild) return;

        const guard = await adminGuard.check('unban_all', guild.id, ctx.channel || ctx.channelId, ctx.member);
        if (!guard.ok) return adminGuard.deny(ctx, guard.reason);

        const author    = isSlash ? ctx.user : ctx.author;
        const authorMsg = isSlash ? null : ctx;

        /* bot must have BanMembers */
        if (!guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'unban_all.no_perm_bot')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
        }

        /* defer since this can take time */
        if (isSlash) await ctx.deferReply();
        else {
            var progressMsg = await ctx.channel.send(buildCard(ACCENT, [`⏳  ${t(lang,'unban_all.processing')}`]));
        }

        let bans;
        try {
            bans = await guild.bans.fetch();
        } catch {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'unban_all.fetch_failed')}`]);
            if (isSlash) return ctx.editReply(err);
            await progressMsg.edit(err); return;
        }

        if (!bans.size) {
            const empty = buildCard(ACCENT, [`## ✅  ${t(lang,'unban_all.title')}`, t(lang,'unban_all.no_bans')]);
            if (isSlash) return ctx.editReply(empty);
            await progressMsg.edit(empty);
            setTimeout(() => adminGuard.cleanup(guard.cfg, authorMsg, progressMsg), 8000);
            return;
        }

        let success = 0, failed = 0;
        for (const [id, banEntry] of bans) {
            try {
                await guild.members.unban(id, `Mass unban by ${author.tag}`);
                success++;
            } catch { failed++; }
        }

        const card = buildCard(ACCENT, [
            `## ✅  ${t(lang,'unban_all.title')}`,
            `${t(lang,'unban_all.label_unbanned')}  \u2192  ${success}`,
            ...(failed ? [`${t(lang,'unban_all.label_failed')}  \u2192  ${failed}`] : []),
            `${t(lang,'unban_all.label_mod')}  \u2192  <@${author.id}>`,
        ]);

        if (isSlash) {
            await ctx.editReply(card);
        } else {
            await progressMsg.edit(card);
            setTimeout(() => adminGuard.cleanup(guard.cfg, authorMsg, progressMsg), 10000);
        }

        const settings = settingsUtil.get();
        if (settings.actions?.ban?.saveRecord) {
            await db.Ban.endAll(guild.id).catch(() => {});
        }

        if (guard.cfg?.log !== false) {
            await logSystem.logCommandUsage({
                interaction: ctx, commandName: 'unban_all', moderator: author,
                target: { username: `${success} users`, displayAvatarURL: () => guild.iconURL() },
                reason: `Mass unban: ${success} unbanned, ${failed} failed`, action: 'UNBAN_ALL'
            }).catch(() => {});
        }
    }
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */