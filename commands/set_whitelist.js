/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const adminGuard = require('../utils/adminGuard.js');
const { langOf, t } = require('../utils/cmdLang.js');
const logSystem  = require('../systems/log.js');

const CV2 = 1 << 15;
const C   = { Container: 17, Text: 10, Sep: 14 };
const ACCENT = 0xf59e0b; // amber

function buildCard(color, lines) {
    return { flags: CV2, components: [{ type: C.Container, accent_color: color,
        components: [{ type: C.Text, content: lines.join('\n') }] }] };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('set_whitelist')
        .setDescription('Manage the server protection whitelist')
        .addStringOption(o => o.setName('action').setDescription('Add or remove').setRequired(true)
            .addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }))
        .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    textCommand: { name: 'sw', aliases: ['set_whitelist'] },

    async execute(client, ctx, args) {
        const isSlash = ctx.isCommand?.();
        const guild   = ctx.guild;
        const lang    = langOf(guild?.id);
        if (!guild) return;

        const guard = await adminGuard.check('set_whitelist', guild.id, ctx.channel || ctx.channelId, ctx.member);
        if (!guard.ok) return adminGuard.deny(ctx, guard.reason);

        const author    = isSlash ? ctx.user : ctx.author;
        const authorMsg = isSlash ? null : ctx;

        let action, role;
        if (isSlash) {
            action = ctx.options.getString('action');
            role   = ctx.options.getRole('role');
        } else {
            if (args.length < 2) {
                const m = await ctx.channel.send(buildCard(0xef4444, [`❌  ${t(lang,'set_whitelist.usage')}: !sw <add|remove> <@role>`]));
                setTimeout(() => m.delete().catch(() => {}), 8000); return;
            }
            action = args[0].toLowerCase();
            role   = ctx.mentions?.roles?.first();
            if (!role || !['add','remove'].includes(action)) {
                const m = await ctx.channel.send(buildCard(0xef4444, [`❌  ${t(lang,'set_whitelist.usage')}: !sw <add|remove> <@role>`]));
                setTimeout(() => m.delete().catch(() => {}), 8000); return;
            }
        }

        const settingsPath = path.join(__dirname, '../settings.json');
        let settings;
        try {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            if (!Array.isArray(settings.protection.whitelist_roles)) settings.protection.whitelist_roles = [];
        } catch {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'set_whitelist.failed')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
        }

        const list = settings.protection.whitelist_roles;
        const alreadyIn = list.includes(role.id);

        if (action === 'add') {
            if (alreadyIn) {
                const err = buildCard(0xef4444, [`❌  ${t(lang,'set_whitelist.already_in')}`]);
                if (isSlash) return ctx.reply({ ...err, ephemeral: true });
                const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
            }
            list.push(role.id);
        } else {
            if (!alreadyIn) {
                const err = buildCard(0xef4444, [`❌  ${t(lang,'set_whitelist.not_in')}`]);
                if (isSlash) return ctx.reply({ ...err, ephemeral: true });
                const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
            }
            list.splice(list.indexOf(role.id), 1);
        }

        try {
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
        } catch {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'set_whitelist.failed')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
        }

        const added = action === 'add';
        const card = buildCard(ACCENT, [
            `## 🛡️  ${t(lang,'set_whitelist.title')}`,
            `${t(lang,'set_whitelist.label_action')}  \u2192  ${added ? t(lang,'set_whitelist.added') : t(lang,'set_whitelist.removed')}`,
            `${t(lang,'set_whitelist.label_role')}   \u2192  <@&${role.id}>`,
            `${t(lang,'set_whitelist.label_total')}  \u2192  ${list.length}`,
            `${t(lang,'set_whitelist.label_mod')}    \u2192  <@${author.id}>`,
        ]);
        const botReply = isSlash
            ? await ctx.reply({ ...card, ephemeral: true })
            : await ctx.channel.send(card);
        if (!isSlash) setTimeout(() => adminGuard.cleanup(guard.cfg, authorMsg, botReply), 8000);

        if (guard.cfg?.log !== false) {
            await logSystem.logCommandUsage({
                interaction: ctx, commandName: 'set_whitelist', moderator: author,
                target: author,
                reason: `${added ? 'Added' : 'Removed'} @${role.name} ${added ? 'to' : 'from'} whitelist`,
                action: 'SET_WHITELIST'
            }).catch(() => {});
        }
    }
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */