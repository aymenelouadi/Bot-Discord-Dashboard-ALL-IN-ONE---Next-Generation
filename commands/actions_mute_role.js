/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const { SlashCommandBuilder, PermissionFlagsBits, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, MessageFlags } = require('discord.js');
const logSystem  = require('../systems/log.js');
const adminGuard = require('../utils/adminGuard.js');
const settingsUtil = require('../utils/settings');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('actions_role_mute')
        .setDescription('ادارة رتبة الميوت'),
    textCommand: {
        name: 'arm',
        aliases: []
    },

    async execute(client, interactionOrMessage, args) {
        const isSlash = interactionOrMessage.isCommand?.();
        
        try {
            const guild = interactionOrMessage.guild;
        if (!guild) return;

        const guard = await adminGuard.check('actions_role_mute', guild.id, interactionOrMessage.channel || interactionOrMessage.channelId, interactionOrMessage.member);
        if (!guard.ok) return adminGuard.deny(interactionOrMessage, guard.reason);

        const settings = settingsUtil.get();
        const commandConfig = settings.actions['actions_role_mute'];

            const muteCommand = settings.actions.mute;
            if (!muteCommand) {
                return this.sendResponse(interactionOrMessage, 'أمر mute غير موجود في الإعدادات', isSlash);
            }

            if (commandConfig.log) {
                const moderator = interactionOrMessage.user || interactionOrMessage.author;
                await logSystem.logCommandUsage({
                    interaction: interactionOrMessage,
                    commandName: 'actions_mute_role',
                    moderator: moderator,
                    target: moderator,
                    reason: 'فتح قائمة ادارة رتبة الميوت',
                    action: 'actions_mute_role'
                });
            }

            const muteRole = muteCommand.muteRole || '';
            
            await this.showMainMenu(interactionOrMessage, muteRole, isSlash);

        } catch (error) {
            console.error(`Error in actions_role_mute:`, error);
            return this.sendResponse(interactionOrMessage, 'حدث خطأ', isSlash);
        }
    },


    async showMainMenu(context, currentRoleId, isSlash) {
        const currentRole = currentRoleId ? context.guild?.roles.cache.get(currentRoleId) : null;
        const roleText = currentRole ? `${currentRole} \`${currentRoleId}\`` : '*لا توجد رتبة محددة*';

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('mute_role_set')
                    .setLabel('🔧 تعيين رتبة')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('mute_role_remove')
                    .setLabel('🗑️ ازالة الرتبة')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(!currentRoleId)
            );

        const container = new ContainerBuilder()
            .setAccentColor(0xe74c3c)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent('## 🔇 ادارة رتبة الميوت')
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `الرتبة التي تعطى للأعضاء عند كتمهم\n\n🎭 **الرتبة الحالية:** ${roleText}`
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
            )
            .addActionRowComponents(row);

        const cv2Flags = MessageFlags.IsComponentsV2;
        const cv2EphFlags = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;

        if (context.isButton?.() || context.isRoleSelectMenu?.()) {
            await context.update({ components: [container], flags: cv2Flags });
        } else if (isSlash) {
            if (context.replied || context.deferred) {
                await context.editReply({ components: [container], flags: cv2Flags });
            } else {
                await context.reply({ components: [container], flags: cv2EphFlags });
            }
        } else {
            await context.reply({ components: [container], flags: cv2Flags });
        }
    },

    async showRoleSelector(interaction) {
        const roleSelect = new RoleSelectMenuBuilder()
            .setCustomId('mute_role_select')
            .setPlaceholder('اختر الرتبة المراد تعيينها للميوت')
            .setMinValues(1)
            .setMaxValues(1);

        const row = new ActionRowBuilder().addComponents(roleSelect);

        const backButton = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('mute_role_back')
                    .setLabel('رجوع')
                    .setStyle(ButtonStyle.Secondary)
            );

        const container = new ContainerBuilder()
            .setAccentColor(0xe74c3c)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent('## 🔧 تعيين رتبة الميوت')
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent('اختر الرتبة التي ستعطى للأعضاء عند كتمهم')
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
            )
            .addActionRowComponents(row)
            .addActionRowComponents(backButton);

        await interaction.update({ components: [container], flags: MessageFlags.IsComponentsV2 });
    },

    async updateMuteRole(interaction, roleId) {
        const settings = settingsUtil.get();

        settings.actions.mute.muteRole = roleId;

        settingsUtil.save(settings);

        const role = interaction.guild?.roles.cache.get(roleId);
        return {
            success: true,
            message: `تم تعيين رتبة الميوت الى: ${role ? role.name : roleId}`,
            role: role
        };
    },

    async removeMuteRole(interaction) {
        const settings = settingsUtil.get();

        const oldRoleId = settings.actions.mute.muteRole;
        settings.actions.mute.muteRole = '';

        settingsUtil.save(settings);

        const oldRole = oldRoleId ? interaction.guild?.roles.cache.get(oldRoleId) : null;
        return {
            success: true,
            message: oldRole ? `تم ازالة رتبة الميوت: ${oldRole.name}` : 'تم ازالة رتبة الميوت',
            role: oldRole
        };
    },

    async handleButton(interaction) {
        const customId = interaction.customId;
        const commandConfig = settingsUtil.get().actions['actions_role_mute'];

        if (customId === 'mute_role_set') {
            await this.showRoleSelector(interaction);
        }
        else if (customId === 'mute_role_remove') {
            const result = await this.removeMuteRole(interaction);
            
            if (commandConfig?.log) {
                await logSystem.logCommandUsage({
                    interaction: interaction,
                    commandName: 'actions_role_mute',
                    moderator: interaction.user,
                    target: interaction.user,
                    reason: `ازالة رتبة الميوت`,
                    action: 'actions_role_mute'
                });
            }
            
            await this.showMainMenu(interaction, '');
        }
        else if (customId === 'mute_role_back') {
            const settings = settingsUtil.get();
            await this.showMainMenu(interaction, settings.actions.mute.muteRole || '');
        }
    },

    async handleRoleSelect(interaction) {
        if (!interaction.isRoleSelectMenu()) return;

        const roleId = interaction.values[0];
        const result = await this.updateMuteRole(interaction, roleId);

        const commandConfig = settingsUtil.get().actions['actions_role_mute'];
        
        if (commandConfig?.log) {
            await logSystem.logCommandUsage({
                interaction: interaction,
                commandName: 'actions_role_mute',
                moderator: interaction.user,
                target: interaction.user,
                reason: `تعيين رتبة الميوت`,
                action: 'actions_role_mute'
            });
        }

        const settings = settingsUtil.get();
        await this.showMainMenu(interaction, settings.actions.mute.muteRole || '');
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