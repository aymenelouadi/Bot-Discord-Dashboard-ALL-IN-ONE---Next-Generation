/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const {
    SlashCommandBuilder, PermissionFlagsBits,
    ActionRowBuilder, ContainerBuilder, TextDisplayBuilder,
    SeparatorBuilder, SeparatorSpacingSize, MessageFlags,
    StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
    ButtonBuilder, ButtonStyle
} = require('discord.js');
const fs   = require('fs');
const path = require('path');
const adminGuard = require('../utils/adminGuard.js');
const { langOf, t } = require('../utils/cmdLang.js');
const logSystem  = require('../systems/log.js');
const settingsUtil = require('../utils/settings');

function errCard(lines) {
    const c = new ContainerBuilder().setAccentColor(0xef4444)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
    return { flags: MessageFlags.IsComponentsV2, components: [c] };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('set_perm')
        .setDescription('Manage command permissions'),
    textCommand: { name: 'setperm', aliases: ['set_perm'] },

    async execute(client, ctx, args) {
        const isSlash = ctx.isCommand?.();
        const guild   = ctx.guild;
        const lang    = langOf(guild?.id);
        if (!guild) return;

        const guard = await adminGuard.check('set_perm', guild.id, ctx.channel || ctx.channelId, ctx.member);
        if (!guard.ok) return adminGuard.deny(ctx, guard.reason);

        const settings = settingsUtil.get();

        const adminCommands = Object.entries(settings.actions)
            .filter(([_, cmd]) => cmd.admin === true)
            .map(([key, cmd]) => ({
                id: key, name: cmd.label || key,
                emoji: cmd.emoji || '', roles: cmd.rolesAllowed || []
            }));

        if (!adminCommands.length) {
            const err = errCard([`❌  ${t(lang,'set_perm.no_commands')}`]);
            return isSlash ? ctx.reply({ ...err, ephemeral: true }) : ctx.channel.send(err);
        }

        await this.showCommandMenu(ctx, adminCommands, 0, isSlash);

        if (guard.cfg?.log !== false) {
            const author = isSlash ? ctx.user : ctx.author;
            await logSystem.logCommandUsage({
                interaction: ctx, commandName: 'set_perm', moderator: author,
                target: author, reason: 'Opened permission manager', action: 'SET_PERM'
            }).catch(() => {});
        }
    },

    async showCommandMenu(context, commands, page = 0, isSlash) {
        const PER = 25;
        const start = page * PER;
        const paginated = commands.slice(start, start + PER);
        const totalPages = Math.ceil(commands.length / PER);

        const select = new StringSelectMenuBuilder()
            .setCustomId(`perm_select_${page}`)
            .setPlaceholder('Select a command to edit its roles')
            .setMinValues(1).setMaxValues(1);

        paginated.forEach(cmd => {
            const opt = new StringSelectMenuOptionBuilder()
                .setLabel(cmd.name).setValue(cmd.id)
                .setDescription(`Allowed roles: ${cmd.roles.length || 'everyone'}`);
            if (cmd.emoji) opt.setEmoji(cmd.emoji);
            select.addOptions(opt);
        });

        const rows = [new ActionRowBuilder().addComponents(select)];

        if (commands.length > PER) {
            const navRow = new ActionRowBuilder();
            if (page > 0) navRow.addComponents(
                new ButtonBuilder().setCustomId(`perm_prev_${page}`).setLabel('◀').setStyle(ButtonStyle.Secondary)
            );
            navRow.addComponents(
                new ButtonBuilder().setCustomId(`perm_page_${page}`).setLabel(`${page+1}/${totalPages}`).setStyle(ButtonStyle.Success).setDisabled(true)
            );
            if (page < totalPages - 1) navRow.addComponents(
                new ButtonBuilder().setCustomId(`perm_next_${page}`).setLabel('▶').setStyle(ButtonStyle.Secondary)
            );
            rows.push(navRow);
        }

        const container = new ContainerBuilder()
            .setAccentColor(0x5865f2)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent('## 🛡️ Command Permission Manager')
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `اختر الأمر لإدارة الرتب المسموحة باستخدامه\n\n📋 **عدد الأوامر:** ${commands.length}`
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
            );

        for (const row of rows) {
            container.addActionRowComponents(row);
        }

        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`-# صفحة ${page+1} من ${totalPages}`)
        );

        const cv2Flags = MessageFlags.IsComponentsV2;
        const cv2EphFlags = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;

        if (context.isButton?.() || context.isStringSelectMenu?.()) {
            await context.update({ components: [container], flags: cv2Flags });
        } else if (isSlash) {
            if (context.replied || context.deferred) await context.editReply({ components: [container], flags: cv2Flags });
            else await context.reply({ components: [container], flags: cv2EphFlags });
        } else {
            await context.reply({ components: [container], flags: cv2Flags });
        }
    },

    async showRoleActions(interaction, commandId) {
        const settings = settingsUtil.get();
        const command = settings.actions[commandId];
        const currentRoles = command.rolesAllowed || [];

        const rolesText = currentRoles.length
            ? currentRoles.map(id => `<@&${id}>`).join(', ')
            : 'الجميع (لا يوجد تقييد)';

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`perm_add_${commandId}`).setLabel('➕ إضافة رتبة').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`perm_remove_${commandId}`).setLabel('➖ إزالة رتبة').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`perm_back_${commandId}`).setLabel('↩️ رجوع').setStyle(ButtonStyle.Secondary)
        );

        const container = new ContainerBuilder()
            .setAccentColor(0x5865f2)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`## ${command.label || commandId}`)
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`🎭 **الرتب المسموح لها:**\n${rolesText}`)
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
            )
            .addActionRowComponents(row);

        await interaction.update({ components: [container], flags: MessageFlags.IsComponentsV2 });
    },

    async showRoleSelection(interaction, commandId, action) {
        const guild = interaction.guild;
        const settings = settingsUtil.get();
        const currentRoles = settings.actions[commandId].rolesAllowed || [];

        const allRoles = guild.roles.cache.filter(r => r.id !== guild.id).sort((a, b) => b.position - a.position);
        const available = action === 'remove'
            ? [...allRoles.filter(r => currentRoles.includes(r.id)).values()]
            : [...allRoles.filter(r => !currentRoles.includes(r.id)).values()];

        if (!available.length) {
            await interaction.reply({
                content: action === 'remove' ? 'No roles to remove.' : 'All roles already added.',
                ephemeral: true
            });
            return;
        }
        await this.showPaginatedRoleMenu(interaction, commandId, action, available, 0);
    },

    async showPaginatedRoleMenu(interaction, commandId, action, rolesList, page = 0) {
        const PER = 25;
        const paginated = rolesList.slice(page * PER, (page + 1) * PER);
        const totalPages = Math.ceil(rolesList.length / PER);

        const select = new StringSelectMenuBuilder()
            .setCustomId(`perm_role_${commandId}_${action}_${page}`)
            .setPlaceholder(action === 'add' ? 'Select role to add' : 'Select role to remove')
            .setMinValues(1).setMaxValues(1);

        paginated.forEach(role => select.addOptions(
            new StringSelectMenuOptionBuilder().setLabel(role.name).setValue(role.id).setDescription(`@${role.name}`)
        ));

        const rows = [new ActionRowBuilder().addComponents(select)];

        if (rolesList.length > PER) {
            const navRow = new ActionRowBuilder();
            if (page > 0) navRow.addComponents(
                new ButtonBuilder().setCustomId(`perm_role_page_${commandId}_${action}_prev_${page}`).setLabel('◀').setStyle(ButtonStyle.Secondary)
            );
            navRow.addComponents(
                new ButtonBuilder().setCustomId(`perm_role_page_${commandId}_${action}_current`).setLabel(`${page+1}/${totalPages}`).setStyle(ButtonStyle.Success).setDisabled(true)
            );
            if (page < totalPages - 1) navRow.addComponents(
                new ButtonBuilder().setCustomId(`perm_role_page_${commandId}_${action}_next_${page}`).setLabel('▶').setStyle(ButtonStyle.Secondary)
            );
            rows.push(navRow);
        }

        rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`perm_back_${commandId}`).setLabel('← Back').setStyle(ButtonStyle.Secondary)
        ));

        const container = new ContainerBuilder()
            .setAccentColor(0x5865f2)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `## ${action === 'add' ? '➕ إضافة رتبة' : '➖ إزالة رتبة'}\n-# صفحة ${page+1} من ${totalPages}`
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
            );

        for (const row of rows) {
            container.addActionRowComponents(row);
        }

        await interaction.update({ components: [container], flags: MessageFlags.IsComponentsV2 });
    },

    async updateCommandRoles(commandId, roleId, action) {
        const settings = settingsUtil.get();
        if (!settings.actions[commandId].rolesAllowed) settings.actions[commandId].rolesAllowed = [];
        if (action === 'add') {
            if (!settings.actions[commandId].rolesAllowed.includes(roleId))
                settings.actions[commandId].rolesAllowed.push(roleId);
        } else {
            settings.actions[commandId].rolesAllowed = settings.actions[commandId].rolesAllowed.filter(id => id !== roleId);
        }
        settingsUtil.save(settings);
        return settings.actions[commandId].rolesAllowed;
    },

    async handleButton(interaction) {
        const id = interaction.customId;

        const getAdminCmds = () => {
            const settings = settingsUtil.get();
            return Object.entries(settings.actions)
                .filter(([_, cmd]) => cmd.admin === true)
                .map(([key, cmd]) => ({ id: key, name: cmd.label || key, emoji: cmd.emoji || '', roles: cmd.rolesAllowed || [] }));
        };

        if (id.startsWith('perm_prev_')) {
            const page = parseInt(id.split('_')[2]);
            await this.showCommandMenu(interaction, getAdminCmds(), page - 1, true);
        } else if (id.startsWith('perm_next_')) {
            const page = parseInt(id.split('_')[2]);
            await this.showCommandMenu(interaction, getAdminCmds(), page + 1, true);
        } else if (id.startsWith('perm_back_')) {
            await this.showCommandMenu(interaction, getAdminCmds(), 0, true);
        } else if (id.startsWith('perm_add_')) {
            const commandId = id.slice('perm_add_'.length);
            await this.showRoleSelection(interaction, commandId, 'add');
        } else if (id.startsWith('perm_remove_')) {
            const commandId = id.slice('perm_remove_'.length);
            await this.showRoleSelection(interaction, commandId, 'remove');
        } else if (id.startsWith('perm_role_page_')) {
            const parts = id.split('_');
            // perm_role_page_{commandId}_{action}_{dir}_{page}
            const commandId = parts[3];
            const action    = parts[4];
            const dir       = parts[5];
            const page      = parseInt(parts[6]);
            const settings  = settingsUtil.get();
            const currentRoles = settings.actions[commandId].rolesAllowed || [];
            const allRoles = interaction.guild.roles.cache.filter(r => r.id !== interaction.guild.id).sort((a, b) => b.position - a.position);
            const available = action === 'remove'
                ? [...allRoles.filter(r => currentRoles.includes(r.id)).values()]
                : [...allRoles.filter(r => !currentRoles.includes(r.id)).values()];
            const newPage = dir === 'prev' ? page - 1 : page + 1;
            await this.showPaginatedRoleMenu(interaction, commandId, action, available, newPage);
        }
    },

    async handleSelectMenu(interaction) {
        const id = interaction.customId;

        if (id.startsWith('perm_select_')) {
            const commandId = interaction.values[0];
            await this.showRoleActions(interaction, commandId);
        } else if (id.startsWith('perm_role_')) {
            // perm_role_{commandId}_{action}_{page}
            const parts = id.split('_');
            const commandId = parts[2];
            const action    = parts[3];
            const roleId    = interaction.values[0];
            await this.updateCommandRoles(commandId, roleId, action);
            const role = interaction.guild.roles.cache.get(roleId);
            const actionText = action === 'add' ? 'Added' : 'Removed';
            await interaction.reply({ content: `✅  ${actionText} role **${role?.name ?? roleId}** successfully.`, ephemeral: true });
            await this.showRoleActions(interaction, commandId);
        }
    }
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */