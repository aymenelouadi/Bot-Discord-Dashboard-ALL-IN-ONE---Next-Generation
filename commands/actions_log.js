/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const { SlashCommandBuilder, PermissionFlagsBits, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuOptionBuilder, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, MessageFlags } = require('discord.js');
const logSystem  = require('../systems/log.js');
const adminGuard = require('../utils/adminGuard.js');
const settingsUtil = require('../utils/settings');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('actions_log')
        .setDescription('تفعيل او تعطيل تسجيل الاوامر'),
    textCommand: {
        name: 'alog',
        aliases: []
    },

    async execute(client, interactionOrMessage, args) {
        const isSlash = interactionOrMessage.isCommand?.();
        
        try {
            const guild = interactionOrMessage.guild;
        if (!guild) return;

        const guard = await adminGuard.check('actions_log', guild.id, interactionOrMessage.channel || interactionOrMessage.channelId, interactionOrMessage.member);
        if (!guard.ok) return adminGuard.deny(interactionOrMessage, guard.reason);

        const settings = settingsUtil.get();
        const commandConfig = settings.actions['actions_log'];

            const commands = Object.entries(settings.actions)
                .filter(([key, cmd]) => key !== 'actions_log' && cmd.hasOwnProperty('log'))
                .map(([key, cmd]) => ({
                    id: key,
                    name: cmd.label || key,
                    emoji: cmd.emoji || '',
                    log: cmd.log || false,
                    color: cmd.color || '#5865F2'
                }));

            if (commandConfig.log) {
                const moderator = interactionOrMessage.user || interactionOrMessage.author;
                await logSystem.logCommandUsage({
                    interaction: interactionOrMessage,
                    commandName: 'actions_log',
                    moderator: moderator,
                    target: moderator,
                    reason: 'فتح قائمة تسجيل الاوامر',
                    action: 'actions_log'
                });
            }

            await this.showCommandMenu(interactionOrMessage, commands, 0, isSlash);

        } catch (error) {
            console.error(`Error in actions_log:`, error);
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
            .setCustomId(`log_select_${page}`)
            .setPlaceholder('اختر الأمر لتغيير حالة التسجيل')
            .setMinValues(1)
            .setMaxValues(1);

        paginatedCommands.forEach(cmd => {
            const option = new StringSelectMenuOptionBuilder()
                .setLabel(`${cmd.name} ${cmd.log ? '📝' : '🚫'}`)
                .setValue(cmd.id)
                .setDescription(`التسجيل: ${cmd.log ? 'مفعل' : 'معطل'}`);
            
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
                        .setCustomId(`log_prev_${page}`)
                        .setLabel('السابق')
                        .setStyle(ButtonStyle.Secondary)
                );
            }
            
            row2.addComponents(
                new ButtonBuilder()
                    .setCustomId(`log_page_${page}`)
                    .setLabel(`${page + 1}/${totalPages}`)
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(true)
            );
            
            if (page < totalPages - 1) {
                row2.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`log_next_${page}`)
                        .setLabel('التالي')
                        .setStyle(ButtonStyle.Secondary)
                );
            }
            
            components.push(row2);
        }

        const enabledCount = commands.filter(c => c.log).length;
        const disabledCount = commands.filter(c => !c.log).length;

        const container = new ContainerBuilder()
            .setAccentColor(0x5865F2)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent('## 📋 التحكم في تسجيل الأوامر')
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `✅ **مفعل:** ${enabledCount}　　❌ **معطل:** ${disabledCount}　　📊 **الإجمالي:** ${commands.length}`
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
    },

    async showCommandActions(interaction, commandId, statusMessage = null) {
        const settings = settingsUtil.get();
        
        const command = settings.actions[commandId];
        if (!command) {
            return interaction.update({ content: 'الأمر غير موجود', components: [] });
        }
        const currentStatus = command.log || false;

        const accentHex = (command.color || '#5865F2').replace('#', '');
        const accentColor = parseInt(accentHex, 16);

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`log_enable_${commandId}`)
                    .setLabel('✅ تفعيل التسجيل')
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(currentStatus === true),
                new ButtonBuilder()
                    .setCustomId(`log_disable_${commandId}`)
                    .setLabel('❌ تعطيل التسجيل')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(currentStatus === false),
                new ButtonBuilder()
                    .setCustomId(`log_back`)
                    .setLabel('↩️ رجوع')
                    .setStyle(ButtonStyle.Secondary)
            );

        const statusLine = currentStatus ? '✅ **الحالة:** مفعل' : '❌ **الحالة:** معطل';
        const descLines = statusMessage ? `${statusMessage}\n\n${statusLine}` : statusLine;

        const container = new ContainerBuilder()
            .setAccentColor(isNaN(accentColor) ? 0x5865F2 : accentColor)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`## ${command.label || commandId}`)
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(descLines)
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
            )
            .addActionRowComponents(row);

        await interaction.update({ components: [container], flags: MessageFlags.IsComponentsV2 });
    },

    async updateCommandLog(commandId, newStatus) {
        const settings = settingsUtil.get();

        settings.actions[commandId].log = newStatus;

        settingsUtil.save(settings);
        return settings.actions[commandId];
    },

    async handleButton(interaction) {
        const customId = interaction.customId;
        
        if (customId.startsWith('log_prev_')) {
            const page = parseInt(customId.split('_')[2]);
            const settings = settingsUtil.get();
            const commands = Object.entries(settings.actions)
                .filter(([key, cmd]) => key !== 'actions_log' && cmd.hasOwnProperty('log'))
                .map(([key, cmd]) => ({
                    id: key,
                    name: cmd.label || key,
                    emoji: cmd.emoji || '',
                    log: cmd.log || false
                }));
            await this.showCommandMenu(interaction, commands, page - 1, true);
        }
        
        else if (customId.startsWith('log_next_')) {
            const page = parseInt(customId.split('_')[2]);
            const settings = settingsUtil.get();
            const commands = Object.entries(settings.actions)
                .filter(([key, cmd]) => key !== 'actions_log' && cmd.hasOwnProperty('log'))
                .map(([key, cmd]) => ({
                    id: key,
                    name: cmd.label || key,
                    emoji: cmd.emoji || '',
                    log: cmd.log || false
                }));
            await this.showCommandMenu(interaction, commands, page + 1, true);
        }
        
        else if (customId === 'log_back') {
            const settings = settingsUtil.get();
            const commands = Object.entries(settings.actions)
                .filter(([key, cmd]) => key !== 'actions_log' && cmd.hasOwnProperty('log'))
                .map(([key, cmd]) => ({
                    id: key,
                    name: cmd.label || key,
                    emoji: cmd.emoji || '',
                    log: cmd.log || false
                }));
            await this.showCommandMenu(interaction, commands, 0, true);
        }
        
        else if (customId.startsWith('log_enable_')) {
            const commandId = customId.replace('log_enable_', '');
            await this.updateCommandLog(commandId, true);
            
            const settings = settingsUtil.get();
            const command = settings.actions[commandId];
            const commandConfig = settings.actions['actions_log'];
            
            if (commandConfig && commandConfig.log) {
                await logSystem.logCommandUsage({
                    interaction: interaction,
                    commandName: 'actions_log',
                    moderator: interaction.user,
                    target: interaction.user,
                    reason: `تفعيل التسجيل للأمر ${command.label || commandId}`,
                    action: 'actions_log'
                });
            }
            
            await this.showCommandActions(interaction, commandId, `✅ تم تفعيل التسجيل للأمر **${command.label || commandId}**`);
        }
        
        else if (customId.startsWith('log_disable_')) {
            const commandId = customId.replace('log_disable_', '');
            await this.updateCommandLog(commandId, false);
            
            const settings = settingsUtil.get();
            const command = settings.actions[commandId];
            const commandConfig = settings.actions['actions_log'];
            
            if (commandConfig && commandConfig.log) {
                await logSystem.logCommandUsage({
                    interaction: interaction,
                    commandName: 'actions_log',
                    moderator: interaction.user,
                    target: interaction.user,
                    reason: `تعطيل التسجيل للأمر ${command.label || commandId}`,
                    action: 'actions_log'
                });
            }
            
            await this.showCommandActions(interaction, commandId, `❌ تم تعطيل التسجيل للأمر **${command.label || commandId}**`);
        }
    },

    async handleSelectMenu(interaction) {
        const customId = interaction.customId;
        
        if (customId.startsWith('log_select_')) {
            const commandId = interaction.values[0];
            await this.showCommandActions(interaction, commandId);
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