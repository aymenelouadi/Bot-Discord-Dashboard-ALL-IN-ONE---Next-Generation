/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const { SlashCommandBuilder, PermissionFlagsBits, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuOptionBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, MessageFlags } = require('discord.js');
const logSystem  = require('../systems/log.js');
const adminGuard = require('../utils/adminGuard.js');
const settingsUtil = require('../utils/settings');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('actions_color')
        .setDescription('تغيير لون الأوامر (Hex Code)'),

    textCommand: {
        name: 'ac',
        aliases: []
    },

    async execute(client, interactionOrMessage, args) {
        const isSlash = interactionOrMessage.isCommand?.();
        
        try {
            const guild = interactionOrMessage.guild;
        if (!guild) return;

        const guard = await adminGuard.check('actions_color', guild.id, interactionOrMessage.channel || interactionOrMessage.channelId, interactionOrMessage.member);
        if (!guard.ok) return adminGuard.deny(interactionOrMessage, guard.reason);

        const settings = settingsUtil.get();
        const commandConfig = settings.actions['actions_color'];
            
            if (commandConfig.log) {
                const moderator = interactionOrMessage.user || interactionOrMessage.author;
                await logSystem.logCommandUsage({
                    interaction: interactionOrMessage,
                    commandName: 'actions_color',
                    moderator: moderator,
                    target: moderator,
                    reason: 'فتح قائمة تغيير الوان الأوامر',
                    action: 'actions_color'
                });
            }

            const commands = Object.entries(settings.actions)
                .filter(([key]) => key !== 'actions_color')
                .map(([key, cmd]) => ({
                    id: key,
                    name: cmd.label || key,
                    emoji: cmd.emoji || '',
                    color: cmd.color || '#27ae60'
                }));

            await this.showCommandMenu(interactionOrMessage, commands, 0, isSlash);

        } catch (error) {
            console.error(`Error in actions_color:`, error);
            return this.sendResponse(interactionOrMessage, 'حدث خطأ', isSlash);
        }
    },


    async showCommandMenu(context, commands, page = 0, isSlash) {
        const perPage = 25;
        const start = page * perPage;
        const end = start + perPage;
        const paginatedCommands = commands.slice(start, end);
        const totalPages = Math.ceil(commands.length / perPage);

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`color_select_${page}`)
            .setPlaceholder('اختر الأمر لتغيير لونه')
            .setMinValues(1)
            .setMaxValues(1);

        paginatedCommands.forEach(cmd => {
            const option = new StringSelectMenuOptionBuilder()
                .setLabel(cmd.name)
                .setValue(cmd.id)
                .setDescription(`اللون الحالي: ${cmd.color}`);
            
            if (cmd.emoji) {
                option.setEmoji(cmd.emoji);
            }
            
            selectMenu.addOptions(option);
        });

        const row1 = new ActionRowBuilder().addComponents(selectMenu);
        const components = [row1];

        if (commands.length > perPage) {
            const row2 = new ActionRowBuilder();
            
            if (page > 0) {
                row2.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`color_prev_${page}`)
                        .setLabel('السابق')
                        .setStyle(ButtonStyle.Secondary)
                );
            }
            
            if (page < totalPages - 1) {
                row2.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`color_next_${page}`)
                        .setLabel('التالي')
                        .setStyle(ButtonStyle.Secondary)
                );
            }
            
            if (row2.components.length > 0) {
                components.push(row2);
            }
        }

        const container = new ContainerBuilder()
            .setAccentColor(0x5865F2)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent('## 🎨 التحكم في ألوان الأوامر')
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `اختر الأمر لتغيير لونه\nيجب إدخال اللون بصيغة Hex مثل **#27ae60**\n\n📋 **إجمالي الأوامر:** ${commands.length}`
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
            );

        for (const row of components) {
            container.addActionRowComponents(row);
        }

        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`-# صفحة ${page + 1} من ${totalPages}`)
        );

        const cv2Flags = MessageFlags.IsComponentsV2;
        const cv2EphFlags = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;

        try {
            if (context.isButton?.() || context.isStringSelectMenu?.()) {
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
        } catch (error) {
            console.error('Error in showCommandMenu:', error);
        }
    },

    async showColorModal(interaction, commandId) {
        const settings = settingsUtil.get();
        const command = settings.actions[commandId];
        const currentColor = command.color || '#27ae60';

        const modal = new ModalBuilder()
            .setCustomId(`color_modal_${commandId}`)
            .setTitle(`تغيير لون ${command.label || commandId}`);

        const colorInput = new TextInputBuilder()
            .setCustomId('color_input')
            .setLabel('اللون الجديد (Hex Code)')
            .setStyle(TextInputStyle.Short)
            .setValue(currentColor)
            .setPlaceholder('#27ae60')
            .setRequired(true)
            .setMinLength(7)
            .setMaxLength(7);

        const actionRow = new ActionRowBuilder().addComponents(colorInput);
        modal.addComponents(actionRow);

        await interaction.showModal(modal);
    },

    async updateCommandColor(commandId, newColor) {
        const settings = settingsUtil.get();

        settings.actions[commandId].color = newColor;

        settingsUtil.save(settings);
        return settings.actions[commandId];
    },

    isValidHexColor(color) {
        return /^#[0-9A-F]{6}$/i.test(color);
    },

    async handleButton(interaction) {
        const customId = interaction.customId;
        
        if (customId.startsWith('color_prev_')) {
            const page = parseInt(customId.split('_')[2]);
            const settings = settingsUtil.get();
            const commands = Object.entries(settings.actions)
                .filter(([key]) => key !== 'actions_color')
                .map(([key, cmd]) => ({
                    id: key,
                    name: cmd.label || key,
                    emoji: cmd.emoji || '',
                    color: cmd.color || '#27ae60'
                }));
            await this.showCommandMenu(interaction, commands, page - 1, true);
        }
        
        else if (customId.startsWith('color_next_')) {
            const page = parseInt(customId.split('_')[2]);
            const settings = settingsUtil.get();
            const commands = Object.entries(settings.actions)
                .filter(([key]) => key !== 'actions_color')
                .map(([key, cmd]) => ({
                    id: key,
                    name: cmd.label || key,
                    emoji: cmd.emoji || '',
                    color: cmd.color || '#27ae60'
                }));
            await this.showCommandMenu(interaction, commands, page + 1, true);
        }
    },

    async handleSelectMenu(interaction) {
        const customId = interaction.customId;
        
        if (customId.startsWith('color_select_')) {
            const commandId = interaction.values[0];
            await this.showColorModal(interaction, commandId);
        }
    },

    async handleModal(interaction) {
        const customId = interaction.customId;
        
        if (customId.startsWith('color_modal_')) {
            const commandId = customId.replace('color_modal_', '');
            const newColor = interaction.fields.getTextInputValue('color_input');
            
            if (!this.isValidHexColor(newColor)) {
                return interaction.reply({
                    content: 'اللون يجب أن يكون بصيغة Hex صحيحة مثل #27ae60',
                    ephemeral: true
                });
            }
            
            await this.updateCommandColor(commandId, newColor);
            
            const settings = settingsUtil.get();
            const command = settings.actions[commandId];
            
            const commandConfig = settings.actions['actions_color'];
            if (commandConfig.log) {
                await logSystem.logCommandUsage({
                    interaction: interaction,
                    commandName: 'actions_color',
                    moderator: interaction.user,
                    target: interaction.user,
                    reason: `تغيير لون الأمر ${command.label || commandId} إلى ${newColor}`,
                    action: 'actions_color'
                });
            }
            
            await interaction.reply({
                content: `✅ تم تغيير لون الأمر **${command.label || commandId}** إلى ${newColor}`,
                ephemeral: true
            });
        }
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