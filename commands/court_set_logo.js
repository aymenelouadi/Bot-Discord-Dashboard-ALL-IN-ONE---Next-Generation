/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const fs         = require('fs');
const path       = require('path');
const adminGuard = require('../utils/adminGuard.js');
const { langOf, t } = require('../utils/cmdLang.js');
const logSystem  = require('../systems/log.js');

const CV2 = 1 << 15;
const C   = { Container: 17, Text: 10, Sep: 14 };
const ACCENT = 0xffd700;

function buildCard(color, lines) {
    return { flags: CV2, components: [{ type: C.Container, accent_color: color,
        components: [{ type: C.Text, content: lines.join('\n') }] }] };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('court_set_logo')
        .setDescription('تغيير شعار المحكمة')
        .addStringOption(o => o.setName('url').setDescription('رابط الصورة').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    textCommand: { name: 'cslogo', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash = ctx.isCommand?.();
        const guild   = ctx.guild;
        const lang    = langOf(guild?.id);
        if (!guild) return;

        const guard = await adminGuard.check('court_set_logo', guild.id, ctx.channel || ctx.channelId, ctx.member);
        if (!guard.ok) return adminGuard.deny(ctx, guard.reason);

        const author    = isSlash ? ctx.user : ctx.author;
        const authorMsg = isSlash ? null : ctx;

        let url;
        if (isSlash) {
            url = ctx.options.getString('url');
        } else {
            if (!args.length) {
                const m = await ctx.channel.send(buildCard(0xef4444, [`❌  ${t(lang,'court_set_logo.usage')}: !cslogo <url>`]));
                setTimeout(() => m.delete().catch(() => {}), 8000); return;
            }
            url = args[0];
        }

        if (!/^https?:\/\/[^\s]+$/i.test(url)) {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'court_set_logo.invalid_url')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
        }

        const settingsPath = path.join(__dirname, '../settings.json');
        try {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            settings.court.logo = url;
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
        } catch {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'court_set_logo.failed')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
        }

        const card = buildCard(ACCENT, [
            `## ⚖️  ${t(lang,'court_set_logo.title')}`,
            `${t(lang,'court_set_logo.label_url')}  →  ${url}`,
            `${t(lang,'court_set_logo.label_mod')}  →  <@${author.id}>`,
        ]);
        const botReply = isSlash ? await ctx.reply({ ...card, ephemeral: true }) : await ctx.channel.send(card);
        if (!isSlash) setTimeout(() => adminGuard.cleanup(guard.cfg, authorMsg, botReply), 8000);

        if (guard.cfg?.log !== false) {
            await logSystem.logCommandUsage({ interaction: ctx, commandName: 'court_set_logo',
                moderator: author, target: author, reason: 'Logo updated', action: 'COURT_SET_LOGO' }).catch(() => {});
        }
    }
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */