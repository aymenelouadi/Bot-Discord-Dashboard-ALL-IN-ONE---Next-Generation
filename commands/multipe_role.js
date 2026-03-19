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
const ACCENT = 0x6366f1; // indigo

function buildCard(color, lines) {
    return { flags: CV2, components: [{ type: C.Container, accent_color: color,
        components: [{ type: C.Text, content: lines.join('\n') }] }] };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('multipe_role')
        .setDescription('Add or remove a role from all members / bots')
        .addStringOption(o => o.setName('type').setDescription('Scope').setRequired(true)
            .addChoices({ name: 'Humans', value: 'humans' }, { name: 'Bots', value: 'bots' }, { name: 'Everyone', value: 'all' }))
        .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true))
        .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true)
            .addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

    textCommand: { name: 'mr', aliases: ['multipe_role'] },

    async execute(client, ctx, args) {
        const isSlash = ctx.isCommand?.();
        const guild   = ctx.guild;
        const lang    = langOf(guild?.id);
        if (!guild) return;

        const guard = await adminGuard.check('multipe_role', guild.id, ctx.channel || ctx.channelId, ctx.member);
        if (!guard.ok) return adminGuard.deny(ctx, guard.reason);

        const author    = isSlash ? ctx.user : ctx.author;
        const authorMsg = isSlash ? null : ctx;

        let type, targetRole, action;

        if (isSlash) {
            type       = ctx.options.getString('type');
            targetRole = ctx.options.getRole('role');
            action     = ctx.options.getString('action');
        } else {
            if (args.length < 3) {
                const m = await ctx.channel.send(buildCard(0xef4444, [`❌  ${t(lang,'multipe_role.usage')}: !mr <humans|bots|all> <@role> <add|remove>`]));
                setTimeout(() => m.delete().catch(() => {}), 8000); return;
            }
            type   = args[0].toLowerCase();
            action = args[args.length - 1].toLowerCase();
            targetRole = ctx.mentions?.roles?.first();
            if (!targetRole || !['humans','bots','all'].includes(type) || !['add','remove'].includes(action)) {
                const m = await ctx.channel.send(buildCard(0xef4444, [`❌  ${t(lang,'multipe_role.usage')}: !mr <humans|bots|all> <@role> <add|remove>`]));
                setTimeout(() => m.delete().catch(() => {}), 8000); return;
            }
        }

        const botMember = await guild.members.fetchMe();
        if (targetRole.position >= botMember.roles.highest.position) {
            const err = buildCard(0xef4444, [`❌  ${t(lang,'multipe_role.role_too_high')}`]);
            if (isSlash) return ctx.reply({ ...err, ephemeral: true });
            const m = await ctx.channel.send(err); setTimeout(() => m.delete().catch(() => {}), 8000); return;
        }

        /* defer — this can take a while */
        if (isSlash) await ctx.deferReply();
        else {
            var progressMsg = await ctx.channel.send(buildCard(ACCENT, [`⏳  ${t(lang,'multipe_role.processing')}`]));
        }

        await guild.members.fetch();

        let members = guild.members.cache;
        if (type === 'humans') members = members.filter(m => !m.user.bot);
        else if (type === 'bots') members = members.filter(m => m.user.bot);

        let success = 0, failed = 0;
        for (const member of members.values()) {
            try {
                const has = member.roles.cache.has(targetRole.id);
                if (action === 'add' && !has)   { await member.roles.add(targetRole);    success++; }
                if (action === 'remove' && has)  { await member.roles.remove(targetRole); success++; }
            } catch { failed++; }
        }

        const scopeLabel = lang === 'ar'
            ? (type==='humans'?'البشر':type==='bots'?'البوتات':'الجميع')
            : (type==='humans'?'humans':type==='bots'?'bots':'everyone');
        const actionLabel = lang === 'ar' ? (action==='add'?'إضافة':'إزالة') : (action==='add'?'Added':'Removed');

        const card = buildCard(ACCENT, [
            `## 🔧  ${t(lang,'multipe_role.title')}`,
            `${t(lang,'multipe_role.label_role')}    \u2192  <@&${targetRole.id}>`,
            `${t(lang,'multipe_role.label_action')}  \u2192  ${actionLabel}`,
            `${t(lang,'multipe_role.label_scope')}   \u2192  ${scopeLabel}`,
            `${t(lang,'multipe_role.label_success')} \u2192  ${success}`,
            ...(failed ? [`${t(lang,'multipe_role.label_failed')}  \u2192  ${failed}`] : []),
            `${t(lang,'multipe_role.label_mod')}   \u2192  <@${author.id}>`,
        ]);

        if (isSlash) {
            await ctx.editReply(card);
        } else {
            await progressMsg.edit(card);
            setTimeout(() => adminGuard.cleanup(guard.cfg, authorMsg, progressMsg), 8000);
        }

        if (guard.cfg?.log !== false) {
            await logSystem.logCommandUsage({
                interaction: ctx, commandName: 'multipe_role', moderator: author,
                target: { username: `@${targetRole.name} → ${scopeLabel}`, displayAvatarURL: () => guild.iconURL() },
                reason: `${actionLabel} @${targetRole.name} for ${scopeLabel} (${success}/${success+failed})`,
                action: 'MULTIPE_ROLE'
            }).catch(() => {});
        }
    }
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */