/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const path       = require('path');
const adminGuard = require('../utils/adminGuard.js');
const { langOf, t } = require('../utils/cmdLang.js');
const logSystem  = require('../systems/log.js');

const CV2 = 1 << 15;
const C   = { Container: 17, Text: 10, Sep: 14 };
const ACCENT = 0x6366f1; // indigo

function buildCard(color, lines) {
    return { flags: CV2, components: [{ type: C.Container, accent_color: color,
        components: [{ type: C.Text, content: lines.join('\n') }] }] };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('set_prefix')
        .setDescription('Change the bot command prefix')
        .addStringOption(o => o.setName('prefix').setDescription('New prefix (max 3 chars)').setRequired(true).setMaxLength(3))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    textCommand: { name: 'prefix', aliases: ['set_prefix'] },

    async execute(client, ctx, args) {
        const isSlash = ctx.isCommand?.();
        const guild   = ctx.guild;
        const lang    = langOf(guild?.id);
        if (!guild) return;

        const guard = await adminGuard.check('set_prefix', guild.id, ctx.channel || ctx.channelId, ctx.member);
        if (!guard.ok) return adminGuard.deny(ctx, guard.reason);

        const author    = isSlash ? ctx.user : ctx.author;
        const authorMsg = isSlash ? null : ctx;

        let prefix;
        if (isSlash) {
            prefix = ctx.options.getString('prefix');
        } else {
            if (!args.length) {
                const m = await ctx.channel.send(buildCard(0xef4444, [`❌  ${t(lang,'set_prefix.usage')}: !prefix <new-prefix>`]));
                setTimeout(() => m.delete().catch(() => {}), 8000);
                return;
            }
            prefix = args[0];
        }

        if (!prefix || prefix.length > 3) {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'set_prefix.too_long')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
        }

        /* persist */
        const settingsPath = require('path').join(__dirname, '../settings.json');
        let settings;
        try {
            settings = JSON.parse(require('fs').readFileSync(settingsPath, 'utf8'));
            settings.system.PREFIX = prefix;
            require('fs').writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
        } catch {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'set_prefix.failed')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
        }

        const card = buildCard(ACCENT, [
            `## ⚙️  ${t(lang,'set_prefix.title')}`,
            `${t(lang,'set_prefix.label_new')}  \u2192  \`${prefix}\``,
            `${t(lang,'set_prefix.label_mod')}  \u2192  <@${author.id}>`,
        ]);
        const botReply = isSlash
            ? await ctx.reply({ ...card, ephemeral: true })
            : await ctx.channel.send(card);
        if (!isSlash) setTimeout(() => adminGuard.cleanup(guard.cfg, authorMsg, botReply), 8000);

        if (guard.cfg?.log !== false) {
            await logSystem.logCommandUsage({
                interaction: ctx, commandName: 'set_prefix', moderator: author,
                target: author, reason: `Prefix changed to \`${prefix}\``, action: 'SET_PREFIX'
            }).catch(() => {});
        }
    }
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */