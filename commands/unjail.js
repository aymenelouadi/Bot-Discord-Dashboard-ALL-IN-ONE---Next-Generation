/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const db      = require('../systems/schemas');
const logSystem    = require('../systems/log.js');
const settingsUtil = require('../utils/settings');

const generateCaseId = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
};

const restoreChannelPermissions = async (guild, userId) => {
    const channels = await guild.channels.fetch();
    
    for (const [channelId, channel] of channels) {
        try {
            if (channel.type === ChannelType.GuildCategory) continue;
            
            const overwrites = channel.permissionOverwrites.cache.get(userId);
            if (overwrites) {
                await overwrites.delete();
            }
        } catch (error) {
            console.error(`Error restoring permissions for channel ${channelId}:`, error);
        }
    }
};

const autoUnjail = async (client, guild, userId, reason) => {
    const settings = settingsUtil.get();

    const jailRecord = await db.Jail.findOneAndUpdate(
        { guildId: guild.id, userId, active: true },
        { $set: { active: false } },
        { new: false }
    ).lean().catch(() => null);

    if (!jailRecord) {
        return { success: false, error: 'User not found in jail database' };
    }

    const jailRoleId = settings.actions?.jail?.addRole;

    try {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member) {
            if (jailRoleId) await member.roles.remove(jailRoleId).catch(() => {});

            if (jailRecord.savedRoles && jailRecord.savedRoles.length > 0) {
                await member.roles.add(jailRecord.savedRoles).catch(() => {});
            }

            await restoreChannelPermissions(guild, userId);
        }

        return { success: true, jailData: jailRecord };
    } catch (error) {
        console.error('Error auto unjailing:', error);
        return { success: false, error: error.message };
    }
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unjail')
        .setDescription('اطلاق سراح مستخدم')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('المستخدم المراد اطلاق سراحه')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('سبب الاطلاق')
                .setRequired(true)),
    textCommand: {
        name: 'unjail',
        aliases: []
    },
    
    async execute(client, interactionOrMessage, args) {
        const isSlash = interactionOrMessage.isCommand?.();
        let user, reason, moderator, guild;
        
        try {
            const settings     = settingsUtil.get();
            const commandConfig = settings.actions?.unjail;

            if (commandConfig && !commandConfig.enabled) {
                return this.sendResponse(interactionOrMessage, 'هذا الأمر معطل حاليا', isSlash);
            }
            
            if (isSlash) {
                user = interactionOrMessage.options.getUser('user');
                reason = interactionOrMessage.options.getString('reason');
                moderator = interactionOrMessage.user;
                guild = interactionOrMessage.guild;

                const hasPermission = await this.checkPermissions(interactionOrMessage, commandConfig);
                if (!hasPermission) {
                    return this.sendResponse(interactionOrMessage, 'لا تملك الصلاحية لاستخدام هذا الأمر', isSlash);
                }
            } else {
                const message = interactionOrMessage;
                if (args.length < 2) {
                    return message.reply('الاستخدام الصحيح: !unjail @المستخدم السبب');
                }
                
                user = message.mentions.users.first();
                if (!user) {
                    try { user = await client.users.fetch(args[0].replace(/[<@!>]/g, '')); } catch { user = null; }
                }
                
                if (!user) {
                    return message.reply('لم يتم العثور على المستخدم');
                }
                
                reason = args.slice(1).join(' ');
                moderator = message.author;
                guild = message.guild;

                const hasPermission = await this.checkPermissions(interactionOrMessage, commandConfig);
                if (!hasPermission) {
                    return message.reply('لا تملك الصلاحية لاستخدام هذا الأمر');
                }
            }
            
            const targetMember = await guild.members.fetch(user.id).catch(() => null);
            if (!targetMember) {
                return this.sendResponse(interactionOrMessage, 'المستخدم ليس في السيرفر', isSlash);
            }

            // Fetch active jail record from MongoDB
            const jailRecord = await db.Jail.findOneAndUpdate(
                { guildId: guild.id, userId: user.id, active: true },
                { $set: { active: false } },
                { new: false }
            ).lean().catch(() => null);

            if (!jailRecord) {
                return this.sendResponse(interactionOrMessage, 'هذا المستخدم ليس مسجونا', isSlash);
            }

            const jailRoleId = settings.actions?.jail?.addRole ?? jailRecord.jailRoleId;

            if (jailRoleId && !targetMember.roles.cache.has(jailRoleId)) {
                return this.sendResponse(interactionOrMessage, 'هذا المستخدم ليس لديه رتبة السجن', isSlash);
            }
            
            const date = new Date().toLocaleString('en-US');
            const caseId = generateCaseId();
            
            try {
                if (jailRoleId) await targetMember.roles.remove(jailRoleId).catch(() => {});
                
                if (jailRecord.savedRoles && jailRecord.savedRoles.length > 0) {
                    await targetMember.roles.add(jailRecord.savedRoles).catch(() => {});
                }
                
                await restoreChannelPermissions(guild, user.id);
                
            } catch (error) {
                console.error('Error unjailing user:', error);
                let errorMessage = 'فشل في اطلاق سراح المستخدم';
                if (error.code === 50013) errorMessage = 'ليس لدي صلاحية ادارة الرتب او القنوات';
                else if (error.code === 50001) errorMessage = 'ليس لدي صلاحية الوصول الى هذا المستخدم';
                return this.sendResponse(interactionOrMessage, errorMessage, isSlash);
            }
            
            if (commandConfig?.log) {
                await logSystem.logCommandUsage({
                    interaction: interactionOrMessage,
                    commandName: 'unjail',
                    moderator,
                    target: user,
                    reason,
                    action: 'UNJAIL'
                }).catch(() => {});
            }
            
            let replyMessage = `تم اطلاق سراح <@${user.id}> (Case ID: \`${caseId}\`)\n`;
            replyMessage += `السبب: ${reason}\n`;
            replyMessage += `سجن سابق: \`${jailRecord.caseId}\`\n`;
            replyMessage += `تم استعادة: ${jailRecord.savedRoles?.length || 0} رتبة`;
            
            await this.sendResponse(interactionOrMessage, replyMessage, isSlash, false);
            
            if (commandConfig?.dm) {
                try {
                    await user.send(`تم اطلاق سراحك من السجن في ${guild.name}\nCase ID: \`${caseId}\`\nالسبب: ${reason}\nبواسطة: <@${moderator.id}>\nالتاريخ: ${date}`);
                } catch { /* DM blocked */ }
            }
            
        } catch (error) {
            console.error('Error in unjail:', error);
            return this.sendResponse(interactionOrMessage, 'حدث خطأ', isSlash);
        }
    },

    async checkPermissions(context, commandConfig) {
        const member = context.member;
        
        if (commandConfig.rolesAllowed && commandConfig.rolesAllowed.length > 0) {
            return commandConfig.rolesAllowed.some(roleId => member.roles.cache.has(roleId));
        }
        
        return member.permissions.has(PermissionFlagsBits.Administrator);
    },

    sendResponse(interactionOrMessage, message, isSlash, ephemeral = true) {
        if (isSlash) {
            return interactionOrMessage.reply({ content: message, ephemeral: ephemeral });
        } else {
            return interactionOrMessage.reply(message);
        }
    },
    
    autoUnjail
};

/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */