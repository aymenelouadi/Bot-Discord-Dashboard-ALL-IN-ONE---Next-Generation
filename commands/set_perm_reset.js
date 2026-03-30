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

const CV2 = 1 << 15;
const C   = { Container: 17, Text: 10, Sep: 14 };
const ACCENT = 0x22c55e; // green

function buildCard(color, lines) {
    return { flags: CV2, components: [{ type: C.Container, accent_color: color,
        components: [{ type: C.Text, content: lines.join('\n') }] }] };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('set_perm_reset')
        .setDescription('Reset all command role restrictions'),
    textCommand: { name: 'setpermreset', aliases: ['set_perm_reset'] },

    async execute(client, ctx, args) {
        const isSlash = ctx.isCommand?.();
        const guild   = ctx.guild;
        const lang    = langOf(guild?.id);
        if (!guild) return;

        const guard = await adminGuard.check('set_perm_reset', guild.id, ctx.channel || ctx.channelId, ctx.member);
        if (!guard.ok) return adminGuard.deny(ctx, guard.reason);

        const author    = isSlash ? ctx.user : ctx.author;
        const authorMsg = isSlash ? null : ctx;

        let settings, count = 0;
        try {
            settings = settingsUtil.get();
            for (const [key, cmd] of Object.entries(settings.actions)) {        
                if (cmd.admin === true && Array.isArray(cmd.rolesAllowed)) {    
                    settings.actions[key].rolesAllowed = [];
                    count++;
                }
            }
            settingsUtil.save(settings);
        } catch {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'set_perm_reset.failed')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
        }

        const card = buildCard(ACCENT, [
            `## ♻️  ${t(lang,'set_perm_reset.title')}`,
            `${t(lang,'set_perm_reset.label_count')}  \u2192  ${count}`,
            `${t(lang,'set_perm_reset.label_mod')}  \u2192  <@${author.id}>`,
            `*${t(lang,'set_perm_reset.note')}*`,
        ]);
        const botReply = isSlash
            ? await ctx.reply({ ...card, ephemeral: true })
            : await ctx.channel.send(card);
        if (!isSlash) setTimeout(() => adminGuard.cleanup(guard.cfg, authorMsg, botReply), 8000);

        if (guard.cfg?.log !== false) {
            await logSystem.logCommandUsage({
                interaction: ctx, commandName: 'set_perm_reset', moderator: author,
                target: author, reason: `Reset role restrictions on ${count} commands`, action: 'SET_PERM_RESET'
            }).catch(() => {});
        }
    }
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */