/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const { SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, SectionBuilder, TextDisplayBuilder, ThumbnailBuilder, SeparatorBuilder, SeparatorSpacingSize, MessageFlags } = require('discord.js');
const logSystem    = require('../systems/log.js');
const settingsUtil = require('../utils/settings');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('come')
        .setDescription('استدعاء مستخدم الى الخاص')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('المستخدم المراد استدعاؤه')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('سبب الاستدعاء - اختياري')
                .setRequired(false)),
    
    textCommand: {
        name: 'come',
        aliases: []
    },
    
    async execute(client, interactionOrMessage, args) {
        const isSlash = interactionOrMessage.isCommand?.();
        let user, reason, moderator, guild, messageId, channelId;
        
        try {
            const settings = settingsUtil.get();
            
            const commandName = 'come';
            const commandConfig = settings.actions[commandName];
            
            if (!commandConfig.enabled) {
                return this.sendResponse(interactionOrMessage, 'هذا الأمر معطل حاليا', isSlash);
            }
            
            if (isSlash) {
                user = interactionOrMessage.options.getUser('user');
                reason = interactionOrMessage.options.getString('reason') || 'لم يتم تحديد سبب';
                moderator = interactionOrMessage.user;
                guild = interactionOrMessage.guild;
                
                const member = await guild.members.fetch(moderator.id).catch(() => null);
                const hasPermission = await this.checkPermissions(interactionOrMessage, commandConfig);
                if (!member || !hasPermission) {
                    return this.sendResponse(interactionOrMessage, 'لا تملك الصلاحية لاستخدام هذا الأمر', isSlash);
                }
            } else {
                const message = interactionOrMessage;
                if (args.length < 1) {
                    return message.channel.send('الاستخدام الصحيح: !come @المخدم [السبب]')
                        .then(msg => setTimeout(() => msg.delete().catch(() => {}), 10000))
                        .catch(() => {});
                }
                
                const userMention = args[0];
                user = message.mentions.users.first();
                if (!user) {
                    try {
                        user = await client.users.fetch(userMention.replace(/[<@!>]/g, ''));
                    } catch {
                        user = null;
                    }
                }
                
                if (!user) {
                    return message.channel.send('لم يتم العثور على المستخدم')
                        .then(msg => setTimeout(() => msg.delete().catch(() => {}), 10000))
                        .catch(() => {});
                }
                
                reason = args.slice(1).join(' ') || 'لم يتم تحديد سبب';
                moderator = message.author;
                guild = message.guild;
                messageId = message.id;
                channelId = message.channel.id;
                
                const member = await guild.members.fetch(moderator.id).catch(() => null);
                const hasPermission = await this.checkPermissions(interactionOrMessage, commandConfig);
                if (!member || !hasPermission) {
                    return message.channel.send('لا تملك الصلاحية لاستخدام هذا الأمر')
                        .then(msg => setTimeout(() => msg.delete().catch(() => {}), 10000))
                        .catch(() => {});
                }
            }
            
            const action = 'COME';
            const courtName = settings.court.name;
            const date = new Date().toLocaleString('en-US');
            
            try {
                const accentHex = (settings.actions.come.color || '#5865F2').replace('#', '');
                const accentColor = parseInt(accentHex, 16);
                const guildIcon = guild.iconURL({ dynamic: true }) || client.user.displayAvatarURL({ dynamic: true });

                const section = new SectionBuilder()
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            `## ⚠️ استدعاء من الإدارة\n` +
                            `لقد تم استدعاؤك من قبل إدارة **${guild.name}**`
                        )
                    )
                    .setThumbnailAccessory(
                        new ThumbnailBuilder().setURL(guildIcon)
                    );

                const bodyText = [
                    `👤 **المسؤول:** ${moderator.tag}`,
                    `🏛️ **المحكمة:** ${courtName}`,
                    `📝 **السبب:** ${reason}`,
                    `🕐 **التاريخ:** ${date}`
                ].join('\n');

                const container = new ContainerBuilder()
                    .setAccentColor(isNaN(accentColor) ? 0x5865F2 : accentColor)
                    .addSectionComponents(section)
                    .addSeparatorComponents(
                        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
                    )
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(bodyText)
                    )
                    .addSeparatorComponents(
                        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
                    )
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(`-# Court System • ${courtName}`)
                    );

                let messageLink = '';
                if (!isSlash && messageId && channelId && guild.id) {
                    messageLink = `https://discord.com/channels/${guild.id}/${channelId}/${messageId}`;

                    const row = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setURL(messageLink)
                                .setLabel('رابط الرسالة')
                                .setStyle(ButtonStyle.Link)
                        );
                    container.addActionRowComponents(row);
                }

                await user.send({
                    components: [container],
                    flags: MessageFlags.IsComponentsV2
                });
                
            } catch (error) {
                console.error('Error sending DM to user:', error);
                let errorMessage = 'فشل في ارسال رسالة خاصة للمستخدم';
                
                if (error.code === 50007) {
                    errorMessage = 'هذا المستخدم مغلق الرسائل الخاصة';
                } else if (error.code === 50013) {
                    errorMessage = 'ليس لدي صلاحية ارسال رسائل خاصة';
                } else if (error.message.includes('Cannot send messages to this user')) {
                    errorMessage = 'هذا المستخدم غير مقبول للرسائل الخاصة';
                }
                
                if (isSlash) {
                    return this.sendResponse(interactionOrMessage, errorMessage, isSlash);
                } else {
                    return interactionOrMessage.channel.send(errorMessage)
                        .then(msg => setTimeout(() => msg.delete().catch(() => {}), 10000))
                        .catch(() => {});
                }
            }
            
            if (commandConfig.log) {
                await logSystem.logCommandUsage({
                    interaction: interactionOrMessage,
                    commandName: commandName,
                    moderator: moderator,
                    target: user,
                    reason: reason,
                    action: action
                });
            }
            
            let replyMessage = `تم ارسال استدعاء الى ${user.tag}\n`;
            replyMessage += `السبب: ${reason}`;
            
            if (!isSlash && messageId && channelId && guild.id) {
                const messageLink = `https://discord.com/channels/${guild.id}/${channelId}/${messageId}`;
                replyMessage += `\nالرابط: ${messageLink}`;
            }
            
            if (isSlash) {
                const reply = await interactionOrMessage.reply({ 
                    content: replyMessage,
                    ephemeral: false 
                });
                
                setTimeout(async () => {
                    try {
                        await interactionOrMessage.deleteReply();
                    } catch (error) {
                        console.error('Error deleting come confirmation:', error);
                    }
                }, 10000);
            } else {
                const sentMessage = await interactionOrMessage.channel.send(replyMessage);
                
                setTimeout(async () => {
                    try {
                        await sentMessage.delete();
                    } catch (error) {
                        console.error('Error deleting come confirmation:', error);
                    }
                }, 10000);
            }
            
        } catch (error) {
            console.error(`Error in come:`, error);
            if (isSlash) {
                return this.sendResponse(interactionOrMessage, 'حدث خطأ', isSlash);
            } else {
                return interactionOrMessage.channel.send('حدث خطأ')
                    .then(msg => setTimeout(() => msg.delete().catch(() => {}), 10000))
                    .catch(() => {});
            }
        }
    },

    async checkPermissions(context, commandConfig) {
        const member = context.member;
        
        if (commandConfig.rolesAllowed && commandConfig.rolesAllowed.length > 0) {
            return commandConfig.rolesAllowed.some(roleId => member.roles.cache.has(roleId));
        }
        
        return member.permissions.has(PermissionFlagsBits.Administrator);
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