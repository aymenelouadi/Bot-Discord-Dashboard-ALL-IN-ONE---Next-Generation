/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const { SlashCommandBuilder, PermissionFlagsBits, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuOptionBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');
const logSystem  = require('../systems/log.js');
const adminGuard = require('../utils/adminGuard.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('actions_label')
        .setDescription('تغيير تسمية الاوامر')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    textCommand: {
        name: 'al',
        aliases: []
    },

    async execute(client, interactionOrMessage, args) {
        const isSlash = interactionOrMessage.isCommand?.();
        
        try {
            const guild = interactionOrMessage.guild;
        if (!guild) return;

        const guard = await adminGuard.check('actions_label', guild.id, interactionOrMessage.channel || interactionOrMessage.channelId, interactionOrMessage.member);
        if (!guard.ok) return adminGuard.deny(interactionOrMessage, guard.reason);

        const settingsPath = path.join(__dirname, '../settings.json');
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        const commandConfig = settings.actions['actions_label'];

            const commands = Object.entries(settings.actions)
                .filter(([key]) => key !== 'actions_label')
                .map(([key, cmd]) => ({
                    id: key,
                    name: cmd.label || key,
                    emoji: cmd.emoji || '',
                    label: cmd.label || key,
                    color: cmd.color || '#5865F2'
                }));

            if (commandConfig.log) {
                const moderator = interactionOrMessage.user || interactionOrMessage.author;
                await logSystem.logCommandUsage({
                    interaction: interactionOrMessage,
                    commandName: 'actions_label',
                    moderator: moderator,
                    target: moderator,
                    reason: 'فتح قائمة تغيير التسميات',
                    action: 'actions_label'
                });
            }

            await this.showCommandMenu(interactionOrMessage, commands, 0, isSlash);

        } catch (error) {
            console.error(`Error in actions_label:`, error);
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
            .setCustomId(`label_select_${page}`)
            .setPlaceholder('اختر الأمر لتغيير تسميته')
            .setMinValues(1)
            .setMaxValues(1);

        paginatedCommands.forEach(cmd => {
            const option = new StringSelectMenuOptionBuilder()
                .setLabel(cmd.name)
                .setValue(cmd.id)
                .setDescription(`التسمية الحالية: ${cmd.label}`);
            
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
                        .setCustomId(`label_prev_${page}`)
                        .setLabel('السابق')
                        .setStyle(ButtonStyle.Secondary)
                );
            }
            
            if (page < totalPages - 1) {
                row2.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`label_next_${page}`)
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
                new TextDisplayBuilder().setContent('## 🏷️ التحكم في تسمية الأوامر')
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `اختر الأمر لتغيير تسميته\n\n📋 **إجمالي الأوامر:** ${commands.length}`
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
                if (context.replied) {
                    await context.followUp({ components: [container], flags: cv2EphFlags });
                } else if (context.deferred) {
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

    async showLabelModal(interaction, commandId) {
        const settingsPath = path.join(__dirname, '../settings.json');
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        const command = settings.actions[commandId];
        const currentLabel = command.label || commandId;

        const modal = new ModalBuilder()
            .setCustomId(`label_modal_${commandId}`)
            .setTitle(`تغيير تسمية ${commandId}`);

        const labelInput = new TextInputBuilder()
            .setCustomId('label_input')
            .setLabel('التسمية الجديدة')
            .setStyle(TextInputStyle.Short)
            .setValue(currentLabel)
            .setPlaceholder('أدخل التسمية الجديدة')
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(10);

        const actionRow = new ActionRowBuilder().addComponents(labelInput);
        modal.addComponents(actionRow);

        await interaction.showModal(modal);
    },

    async updateCommandLabel(commandId, newLabel) {
        const settingsPath = path.join(__dirname, '../settings.json');
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

        settings.actions[commandId].label = newLabel;

        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
        return settings.actions[commandId];
    },

    isValidLabel(label) {
        return /^[a-zA-Z\u0600-\u06FF]+$/.test(label);
    },

    async handleButton(interaction) {
        const customId = interaction.customId;
        
        if (customId.startsWith('label_prev_')) {
            const page = parseInt(customId.split('_')[2]);
            const settingsPath = path.join(__dirname, '../settings.json');
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            const commands = Object.entries(settings.actions)
                .filter(([key]) => key !== 'actions_label')
                .map(([key, cmd]) => ({
                    id: key,
                    name: cmd.label || key,
                    emoji: cmd.emoji || '',
                    label: cmd.label || key
                }));
            await this.showCommandMenu(interaction, commands, page - 1, true);
        }
        
        else if (customId.startsWith('label_next_')) {
            const page = parseInt(customId.split('_')[2]);
            const settingsPath = path.join(__dirname, '../settings.json');
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            const commands = Object.entries(settings.actions)
                .filter(([key]) => key !== 'actions_label')
                .map(([key, cmd]) => ({
                    id: key,
                    name: cmd.label || key,
                    emoji: cmd.emoji || '',
                    label: cmd.label || key
                }));
            await this.showCommandMenu(interaction, commands, page + 1, true);
        }
    },

    async handleSelectMenu(interaction) {
        const customId = interaction.customId;
        
        if (customId.startsWith('label_select_')) {
            const commandId = interaction.values[0];
            await this.showLabelModal(interaction, commandId);
        }
    },

    async handleModal(interaction) {
        const customId = interaction.customId;
        
        if (customId.startsWith('label_modal_')) {
            const commandId = customId.replace('label_modal_', '');
            const newLabel = interaction.fields.getTextInputValue('label_input');
            
            if (!this.isValidLabel(newLabel)) {
                return interaction.reply({
                    content: 'التسمية يجب ان تحتوي فقط على حروف',
                    ephemeral: true
                });
            }
            
            await this.updateCommandLabel(commandId, newLabel);
            
            const settingsPath = path.join(__dirname, '../settings.json');
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            const command = settings.actions[commandId];
            const commandConfig = settings.actions['actions_label'];
            
            if (commandConfig.log) {
                await logSystem.logCommandUsage({
                    interaction: interaction,
                    commandName: 'actions_label',
                    moderator: interaction.user,
                    target: interaction.user,
                    reason: `تغيير تسمية ${commandId} الى ${newLabel}`,
                    action: 'actions_label'
                });
            }
            
            await interaction.reply({
                content: `تم تغيير تسمية الأمر ${commandId} الى ${newLabel} بنجاح`,
                ephemeral: true
            });
            
            const commands = Object.entries(settings.actions)
                .filter(([key]) => key !== 'actions_label')
                .map(([key, cmd]) => ({
                    id: key,
                    name: cmd.label || key,
                    emoji: cmd.emoji || '',
                    label: cmd.label || key
                }));
            await this.showCommandMenu(interaction, commands, 0, true);
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