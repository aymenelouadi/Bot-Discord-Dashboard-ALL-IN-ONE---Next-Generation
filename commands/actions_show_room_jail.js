/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const { SlashCommandBuilder, PermissionFlagsBits, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, MessageFlags } = require('discord.js');
const logSystem  = require('../systems/log.js');
const adminGuard = require('../utils/adminGuard.js');
const settingsUtil = require('../utils/settings');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('actions_show_room_jail')
        .setDescription('ادارة غرف السجن المسموح مشاهدتها'),
    textCommand: {
        name: 'asrj',
        aliases: []
    },

    async execute(client, interactionOrMessage, args) {
        const isSlash = interactionOrMessage.isCommand?.();
        
        try {
            const guild = interactionOrMessage.guild;
        if (!guild) return;

        const guard = await adminGuard.check('actions_show_room_jail', guild.id, interactionOrMessage.channel || interactionOrMessage.channelId, interactionOrMessage.member);
        if (!guard.ok) return adminGuard.deny(interactionOrMessage, guard.reason);

        const settings = settingsUtil.get();
        const commandConfig = settings.actions['actions_show_room_jail'];

            const jailCommand = settings.actions.jail;
            if (!jailCommand) {
                return this.sendResponse(interactionOrMessage, 'أمر jail غير موجود في الإعدادات', isSlash);
            }

            if (commandConfig.log) {
                const moderator = interactionOrMessage.user || interactionOrMessage.author;
                await logSystem.logCommandUsage({
                    interaction: interactionOrMessage,
                    commandName: 'actions_show_room_jail',
                    moderator: moderator,
                    target: moderator,
                    reason: 'فتح قائمة ادارة غرف السجن',
                    action: 'actions_show_room_jail'
                });
            }

            const showRooms = jailCommand.showRoom || [];
            
            await this.showMainMenu(interactionOrMessage, showRooms, isSlash);

        } catch (error) {
            console.error(`Error in actions_show_room_jail:`, error);
            return this.sendResponse(interactionOrMessage, 'حدث خطأ', isSlash);
        }
    },


    async showMainMenu(context, showRooms, isSlash) {
        const roomsText = showRooms.length > 0
            ? showRooms.map((roomId, i) => {
                const room = context.guild?.channels.cache.get(roomId);
                return `${i + 1}. ${room ? `#${room.name}` : 'غير معروف'} (\`${roomId}\`)`;
              }).join('\n')
            : '*لا توجد غرف محددة*';

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('jail_rooms_add')
                    .setLabel('➕ اضافة غرف')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('jail_rooms_remove')
                    .setLabel('➖ ازالة غرف')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(showRooms.length === 0),
                new ButtonBuilder()
                    .setCustomId('jail_rooms_clear')
                    .setLabel('🗑️ مسح الكل')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(showRooms.length === 0)
            );

        const container = new ContainerBuilder()
            .setAccentColor(0x27ae60)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent('## 🔒 ادارة غرف السجن')
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `يمكن للمسجونين رؤية الغرف المحددة فقط\n\n**📋 الغرف الحالية (${showRooms.length}):**\n${roomsText}`
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
            )
            .addActionRowComponents(row);

        const cv2Flags = MessageFlags.IsComponentsV2;
        const cv2EphFlags = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;

        if (context.isButton?.() || context.isChannelSelectMenu?.()) {
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

    async showChannelSelector(interaction, action) {
        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId(`jail_rooms_${action}_select`)
            .setPlaceholder(action === 'add' ? 'اختر الغرف المراد اضافتها' : 'اختر الغرف المراد ازالتها')
            .setMinValues(1)
            .setMaxValues(25)
            .setChannelTypes([ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory, ChannelType.GuildAnnouncement]);

        const row = new ActionRowBuilder().addComponents(channelSelect);

        const backButton = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('jail_rooms_back')
                    .setLabel('رجوع')
                    .setStyle(ButtonStyle.Secondary)
            );

        const settings = settingsUtil.get();
        const currentRooms = settings.actions.jail.showRoom || [];

        let embedDescription = '';
        if (action === 'add') {
            embedDescription = 'اختر الغرف التي تريد اضافتها للقائمة المسموح مشاهدتها للمسجونين';
        } else {
            embedDescription = 'اختر الغرف التي تريد ازالتها من القائمة';
            
            if (currentRooms.length > 0) {
                const roomsList = currentRooms.map(roomId => {
                    const room = interaction.guild?.channels.cache.get(roomId);
                    return `• ${room ? room.name : 'غير معروف'} (${roomId})`;
                }).join('\n');
                embedDescription += `\n\nالغرف الحالية:\n${roomsList}`;
            }
        }

        const container = new ContainerBuilder()
            .setAccentColor(0x27ae60)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`## ${action === 'add' ? '➕ اضافة غرف' : '➖ ازالة غرف'}`)
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(embedDescription)
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
            )
            .addActionRowComponents(row)
            .addActionRowComponents(backButton);

        await interaction.update({ components: [container], flags: MessageFlags.IsComponentsV2 });
    },

    async updateShowRooms(interaction, selectedChannels, action) {
        const settings = settingsUtil.get();

        if (!settings.actions.jail.showRoom) {
            settings.actions.jail.showRoom = [];
        }

        if (action === 'add') {
            const newRooms = selectedChannels.filter(id => !settings.actions.jail.showRoom.includes(id));
            settings.actions.jail.showRoom.push(...newRooms);
            
            settingsUtil.save(settings);
            
            const addedRooms = newRooms.map(id => {
                const room = interaction.guild?.channels.cache.get(id);
                return room ? room.name : id;
            }).join(', ');
            
            return {
                success: true,
                message: `تم اضافة الغرف بنجاح: ${addedRooms}`,
                count: newRooms.length
            };
        } else {
            const removedRooms = selectedChannels.filter(id => settings.actions.jail.showRoom.includes(id));
            settings.actions.jail.showRoom = settings.actions.jail.showRoom.filter(id => !selectedChannels.includes(id));
            
            settingsUtil.save(settings);
            
            const removedRoomsNames = removedRooms.map(id => {
                const room = interaction.guild?.channels.cache.get(id);
                return room ? room.name : id;
            }).join(', ');
            
            return {
                success: true,
                message: `تم ازالة الغرف بنجاح: ${removedRoomsNames}`,
                count: removedRooms.length
            };
        }
    },

    async clearAllRooms(interaction) {
        const settings = settingsUtil.get();

        const oldCount = settings.actions.jail.showRoom?.length || 0;
        settings.actions.jail.showRoom = [];

        settingsUtil.save(settings);

        return {
            success: true,
            message: `تم مسح جميع الغرف (${oldCount} غرفة)`,
            count: oldCount
        };
    },

    async handleButton(interaction) {
        const customId = interaction.customId;
        const commandConfig = settingsUtil.get().actions['actions_show_room_jail'];

        if (customId === 'jail_rooms_add') {
            await this.showChannelSelector(interaction, 'add');
        }
        else if (customId === 'jail_rooms_remove') {
            await this.showChannelSelector(interaction, 'remove');
        }
        else if (customId === 'jail_rooms_clear') {
            const result = await this.clearAllRooms(interaction);
            
            if (commandConfig?.log) {
                await logSystem.logCommandUsage({
                    interaction: interaction,
                    commandName: 'actions_show_room_jail',
                    moderator: interaction.user,
                    target: interaction.user,
                    reason: `مسح جميع غرف السجن`,
                    action: 'actions_show_room_jail'
                });
            }
            
            await this.showMainMenu(interaction, []);
        }
        else if (customId === 'jail_rooms_back') {
            const settings = settingsUtil.get();
            await this.showMainMenu(interaction, settings.actions.jail.showRoom || []);
        }
    },

    async handleChannelSelect(interaction) {
        if (!interaction.isChannelSelectMenu()) return;

        const customId = interaction.customId;
        
        if (customId.startsWith('jail_rooms_')) {
            const action = customId.split('_')[2];
            const selectedChannels = interaction.values;

            const result = await this.updateShowRooms(interaction, selectedChannels, action);

            const commandConfig = settingsUtil.get().actions['actions_show_room_jail'];
            
            if (commandConfig?.log) {
                await logSystem.logCommandUsage({
                    interaction: interaction,
                    commandName: 'actions_show_room_jail',
                    moderator: interaction.user,
                    target: interaction.user,
                    reason: `${action === 'add' ? 'اضافة' : 'ازالة'} غرف للسجن`,
                    action: 'actions_show_room_jail'
                });
            }

            const settings = settingsUtil.get();
            await this.showMainMenu(interaction, settings.actions.jail.showRoom || []);
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