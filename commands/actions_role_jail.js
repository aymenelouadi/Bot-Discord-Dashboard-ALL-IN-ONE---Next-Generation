/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const { SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');
const logSystem  = require('../systems/log.js');
const adminGuard = require('../utils/adminGuard.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('actions_role_jail')
        .setDescription('ادارة رتبة السجن')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    textCommand: {
        name: 'arj',
        aliases: []
    },

    async execute(client, interactionOrMessage, args) {
        const isSlash = interactionOrMessage.isCommand?.();
        
        try {
            const guild = interactionOrMessage.guild;
        if (!guild) return;

        const guard = await adminGuard.check('actions_role_jail', guild.id, interactionOrMessage.channel || interactionOrMessage.channelId, interactionOrMessage.member);
        if (!guard.ok) return adminGuard.deny(interactionOrMessage, guard.reason);

        const settingsPath = path.join(__dirname, '../settings.json');
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        const commandConfig = settings.actions['actions_role_jail'];

            const jailCommand = settings.actions.jail;
            if (!jailCommand) {
                return this.sendResponse(interactionOrMessage, 'أمر jail غير موجود في الإعدادات', isSlash);
            }

            if (commandConfig.log) {
                const moderator = interactionOrMessage.user || interactionOrMessage.author;
                await logSystem.logCommandUsage({
                    interaction: interactionOrMessage,
                    commandName: 'actions_role_jail',
                    moderator: moderator,
                    target: moderator,
                    reason: 'فتح قائمة ادارة رتبة السجن',
                    action: 'actions_role_jail'
                });
            }

            const addRole = jailCommand.addRole || '';
            await this.showMainMenu(interactionOrMessage, addRole, isSlash);

        } catch (error) {
            console.error(`Error in actions_role_jail:`, error);
            return this.sendResponse(interactionOrMessage, 'حدث خطأ', isSlash);
        }
    },

    async handleButton(interaction) {
        const customId = interaction.customId;
        try {
            if (customId === 'jail_role_set') {
                await this.showRoleSelector(interaction, 0);
            }
            else if (customId === 'jail_role_remove') {
                await this.handleRoleRemove(interaction);
            }
            else if (customId === 'jail_role_back' || customId === 'jail_role_cancel') {
                const settingsPath = path.join(__dirname, '../settings.json');
                const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                await this.showMainMenu(interaction, settings.actions.jail.addRole || '');
            }
            else if (customId.startsWith('jail_role_confirm_')) {
                await this.handleRoleConfirm(interaction);
            }
            else if (customId.startsWith('page_')) {
                const page = parseInt(customId.replace('page_', ''));
                await this.showRoleSelector(interaction, page);
            }
        } catch (error) {
            console.error('Error in handleButton (actions_role_jail):', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: 'حدث خطأ', ephemeral: true });
            }
        }
    },

    async handleSelectMenu(interaction) {
        if (interaction.customId === 'jail_role_select') {
            await this.showRoleConfirm(interaction, interaction.values[0]);
        }
    },


    async getMainMenuContent(context, currentRoleId) {
        const currentRole = currentRoleId ? context.guild?.roles.cache.get(currentRoleId) : null;
        const roleText = currentRole ? `${currentRole} \`${currentRoleId}\`` : '*لا توجد رتبة محددة*';

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('jail_role_set')
                    .setLabel('🔧 تعيين رتبة')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('jail_role_remove')
                    .setLabel('🗑️ ازالة الرتبة')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(!currentRoleId)
            );

        const container = new ContainerBuilder()
            .setAccentColor(0x27ae60)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent('## ⛓️ ادارة رتبة السجن')
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `الرتبة التي تعطى للأعضاء عند سجنهم\n\n🎭 **الرتبة الحالية:** ${roleText}`
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
            )
            .addActionRowComponents(row);

        return { components: [container], flags: MessageFlags.IsComponentsV2 };
    },

    async showMainMenu(context, currentRoleId, isSlash) {
        const content = await this.getMainMenuContent(context, currentRoleId);

        try {
            if (context.isButton?.() || context.isRoleSelectMenu?.() || context.isStringSelectMenu?.()) {
                await context.update(content);
            } else if (isSlash) {
                if (context.replied || context.deferred) {
                    await context.editReply(content);
                } else {
                    await context.reply({ ...content, ephemeral: true });
                }
            } else {
                await context.reply(content);
            }
        } catch (error) {
            console.error('Error in showMainMenu:', error);
        }
    },

    async showRoleSelector(interaction, page = 0) {
        const roles = interaction.guild?.roles.cache
            .filter(role => role.id !== interaction.guild.id && !role.managed)
            .sort((a, b) => b.position - a.position)
            .map(role => role);
        
        const itemsPerPage = 25;
        const totalPages = Math.ceil(roles.length / itemsPerPage);
        const startIndex = page * itemsPerPage;
        const endIndex = Math.min(startIndex + itemsPerPage, roles.length);
        const currentRoles = roles.slice(startIndex, endIndex);

        const roleSelect = new RoleSelectMenuBuilder()
            .setCustomId('jail_role_select')
            .setPlaceholder(`اختر الرتبة (صفحة ${page + 1}/${totalPages})`)
            .setMinValues(1)
            .setMaxValues(1);

        const selectRow = new ActionRowBuilder().addComponents(roleSelect);
        const navigationRow = new ActionRowBuilder();
        
        if (page > 0) {
            navigationRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`page_${page - 1}`)
                    .setLabel('السابق')
                    .setStyle(ButtonStyle.Secondary)
            );
        }
        
        if (page < totalPages - 1) {
            navigationRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`page_${page + 1}`)
                    .setLabel('التالي')
                    .setStyle(ButtonStyle.Secondary)
            );
        }

        const backButton = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('jail_role_back')
                    .setLabel('رجوع')
                    .setStyle(ButtonStyle.Secondary)
            );
        
        let rolesList = '';
        currentRoles.forEach((role, index) => {
            rolesList += `${startIndex + index + 1}. ${role} - \`${role.id}\`\n`;
        });

        const innerComponents = [selectRow];
        if (navigationRow.components.length > 0) {
            innerComponents.push(navigationRow);
        }
        innerComponents.push(backButton);

        const container = new ContainerBuilder()
            .setAccentColor(0x27ae60)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `## 🔧 تعيين رتبة السجن\n-# صفحة ${page + 1} من ${totalPages} — إجمالي الرتب: ${roles.length}`
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(rolesList || '*لا توجد رتب*')
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
            );

        for (const row of innerComponents) {
            container.addActionRowComponents(row);
        }

        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
            } else {
                await interaction.update({ components: [container], flags: MessageFlags.IsComponentsV2 });
            }
        } catch (error) {
            console.error('Error in showRoleSelector:', error);
        }
    },

    async showRoleConfirm(interaction, roleId) {
        const role = interaction.guild?.roles.cache.get(roleId);

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`jail_role_confirm_${roleId}`)
                    .setLabel('✅ تأكيد')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('jail_role_cancel')
                    .setLabel('✖️ الغاء')
                    .setStyle(ButtonStyle.Secondary)
            );

        const roleInfo = [
            `🎭 **الرتبة:** ${role ? `${role} — \`${role.name}\`` : roleId}`,
            `👥 **عدد الأعضاء:** ${role ? role.members.size : '0'}`,
            `🎨 **اللون:** ${role ? role.hexColor : '#000000'}`
        ].join('\n');

        const container = new ContainerBuilder()
            .setAccentColor(0x27ae60)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent('## ✅ تأكيد تعيين الرتبة')
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`هل أنت متأكد من تعيين الرتبة التالية؟\n\n${roleInfo}`)
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
            )
            .addActionRowComponents(row);

        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
            } else {
                await interaction.update({ components: [container], flags: MessageFlags.IsComponentsV2 });
            }
        } catch (error) {
            console.error('Error in showRoleConfirm:', error);
        }
    },

    async handleRoleConfirm(interaction) {
        const roleId = interaction.customId.replace('jail_role_confirm_', '');
        if (!roleId) {
            return interaction.update({ content: 'حدث خطأ: لم يتم تحديد رتبة', components: [] });
        }

        const settingsPath = path.join(__dirname, '../settings.json');
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

        settings.actions.jail.addRole = roleId;
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));

        const role = interaction.guild?.roles.cache.get(roleId);
        
        const commandConfig = settings.actions['actions_role_jail'];
        if (commandConfig?.log) {
            await logSystem.logCommandUsage({
                interaction: interaction,
                commandName: 'actions_role_jail',
                moderator: interaction.user,
                target: interaction.user,
                reason: `تعيين رتبة السجن: ${role ? role.name : roleId}`,
                action: 'actions_role_jail'
            });
        }

        await this.showMainMenu(interaction, roleId);
    },

    async handleRoleRemove(interaction) {
        const settingsPath = path.join(__dirname, '../settings.json');
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

        const oldRoleId = settings.actions.jail.addRole;
        const oldRole = oldRoleId ? interaction.guild?.roles.cache.get(oldRoleId) : null;

        settings.actions.jail.addRole = '';
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));

        const commandConfig = settings.actions['actions_role_jail'];
        if (commandConfig?.log) {
            await logSystem.logCommandUsage({
                interaction: interaction,
                commandName: 'actions_role_jail',
                moderator: interaction.user,
                target: interaction.user,
                reason: `ازالة رتبة السجن: ${oldRole ? oldRole.name : oldRoleId}`,
                action: 'actions_role_jail'
            });
        }

        await this.showMainMenu(interaction, '');
    },

    sendResponse(interactionOrMessage, message, isSlash) {
        if (isSlash) {
            return interactionOrMessage.reply({ content: message, ephemeral: true });
        } else {
            return interactionOrMessage.reply(message);
        }
    }
};

/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */