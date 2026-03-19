/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const logSystem = require('../systems/log.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('add_role')
        .setDescription('اضافة رتبة لمستخدم')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('المستخدم لاضافة الرتبة له')
                .setRequired(true)
        )
        .addRoleOption(option =>
            option.setName('role')
                .setDescription('الرتبة لاضافتها')
                .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

    textCommand: {
        name: 'ad',
        aliases: []
    },

    async execute(client, interactionOrMessage, args) {
        const isSlash = interactionOrMessage.isCommand?.();
        const guild = interactionOrMessage.guild;

        if (!guild) {
            return this.sendResponse(interactionOrMessage, 'هذا الأمر يعمل فقط في السيرفرات', isSlash);
        }

        try {
            const settingsPath = path.join(__dirname, '../settings.json');
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            
            const commandName = 'add_role';
            const commandConfig = settings.actions[commandName];
            
            if (!commandConfig.enabled) {
                return this.sendResponse(interactionOrMessage, 'هذا الأمر معطل حاليا', isSlash);
            }
            
            const hasPermission = await this.checkPermissions(interactionOrMessage, commandConfig);
            if (!hasPermission) {
                return this.sendResponse(interactionOrMessage, 'لا تملك الصلاحية لاستخدام هذا الأمر', isSlash);
            }

            let targetUser, targetRole;

            if (isSlash) {
                targetUser = interactionOrMessage.options.getUser('user');
                targetRole = interactionOrMessage.options.getRole('role');
            } else {
                if (args.length < 2) {
                    return this.sendResponse(interactionOrMessage, 'الاستخدام: !ad @المستخدم @الرتبة', isSlash);
                }

                const mention = interactionOrMessage.mentions.users.first();
                const roleMention = interactionOrMessage.mentions.roles.first();

                if (!mention || !roleMention) {
                    return this.sendResponse(interactionOrMessage, 'يجب ذكر المستخدم والرتبة', isSlash);
                }

                targetUser = mention;
                targetRole = roleMention;
            }

            const member = await guild.members.fetch(targetUser.id).catch(() => null);
            if (!member) {
                return this.sendResponse(interactionOrMessage, 'المستخدم غير موجود في السيرفر', isSlash);
            }

            const botMember = await guild.members.fetch(client.user.id);
            const botHighestRole = botMember.roles.highest;
            
            if (targetRole.position >= botHighestRole.position) {
                return this.sendResponse(interactionOrMessage, `لا يمكنني اضافة هذه الرتبة لانها اعلى او تساوي اعلى رتبة لدي (${botHighestRole.name})`, isSlash);
            }

            if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
                return this.sendResponse(interactionOrMessage, 'ليس لدي صلاحية ادارة الرتب', isSlash);
            }

            if (member.roles.cache.has(targetRole.id)) {
                return this.sendResponse(interactionOrMessage, `${targetUser.username} لديه بالفعل رتبة ${targetRole.name}`, isSlash);
            }

            await member.roles.add(targetRole);

            if (commandConfig.log) {
                const moderator = interactionOrMessage.user || interactionOrMessage.author;
                const reason = `اضافة رتبة ${targetRole.name}`;
                
                await logSystem.logCommandUsage({
                    interaction: interactionOrMessage,
                    commandName: commandName,
                    moderator: moderator,
                    target: targetUser,
                    reason: reason,
                    action: 'add_role'
                });
            }

            const response = `تم اضافة رتبة ${targetRole.name} لـ ${targetUser.username}`;
            return this.sendResponse(interactionOrMessage, response, isSlash);

        } catch (error) {
            console.error(`Error in add_role:`, error);
            
            if (error.code === 50013) {
                return this.sendResponse(interactionOrMessage, 'ليس لدي صلاحية ادارة الرتب او الرتبة اعلى من رتبتي', isSlash);
            }
            
            return this.sendResponse(interactionOrMessage, 'حدث خطأ أثناء اضافة الرتبة', isSlash);
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