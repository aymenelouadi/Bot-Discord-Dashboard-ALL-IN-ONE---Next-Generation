/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const fs = require('fs');
const path = require('path');
const logSystem = require('../systems/log.js');

const generateCaseId = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
};

const saveToDatabase = (userId, userData, caseData) => {
    const dbPath = path.join(__dirname, '../database/records.json');
    
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }
    
    let database = {};
    if (fs.existsSync(dbPath)) {
        try {
            const fileContent = fs.readFileSync(dbPath, 'utf8').replace(/^\uFEFF/, '');
            if (fileContent.trim()) {
                database = JSON.parse(fileContent);
            }
        } catch (error) {
            console.error('Error reading database:', error);
            database = {};
        }
    }
    
    if (!database[userId]) {
        database[userId] = {
            username: userData.username,
            tag: userData.tag,
            cases: []
        };
    } else {
        database[userId].username = userData.username;
        database[userId].tag = userData.tag;
    }
    
    database[userId].cases.push(caseData);
    
    try {
        fs.writeFileSync(dbPath, JSON.stringify(database, null, 2));
        return true;
    } catch (error) {
        console.error('Error saving to database:', error);
        return false;
    }
};

const removeJailFromDatabase = (userId) => {
    const dbPath = path.join(__dirname, '../database/jailed.json');
    
    if (!fs.existsSync(dbPath)) {
        return { success: false, error: 'Database not found' };
    }
    
    try {
        const fileContent = fs.readFileSync(dbPath, 'utf8');
        const database = JSON.parse(fileContent);
        
        if (!database[userId]) {
            return { success: false, error: 'User not found in database' };
        }
        
        const jailData = database[userId];
        delete database[userId];
        
        fs.writeFileSync(dbPath, JSON.stringify(database, null, 2));
        return { success: true, jailData };
    } catch (error) {
        console.error('Error removing from database:', error);
        return { success: false, error: error.message };
    }
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
    const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '../settings.json'), 'utf8'));
    
    const jailResult = removeJailFromDatabase(userId);
    if (!jailResult.success) {
        return { success: false, error: jailResult.error };
    }
    
    const jailData = jailResult.jailData;
    const jailRoleId = settings.actions.jail.addRole;
    
    try {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member) {
            await member.roles.remove(jailRoleId);
            
            if (jailData.originalRoles && jailData.originalRoles.length > 0) {
                await member.roles.add(jailData.originalRoles);
            }
            
            await restoreChannelPermissions(guild, userId);
        }
        
        const caseId = generateCaseId();
        const date = new Date().toLocaleString('en-US');
        
        const caseData = {
            caseId: caseId,
            action: 'UNJAIL_AUTO',
            reason: reason,
            moderatorId: client.user.id,
            moderator: client.user.username,
            court: settings.court.name,
            timestamp: date,
            originalJailCaseId: jailData.caseId
        };
        
        const userData = {
            username: jailData.username || 'Unknown',
            tag: jailData.tag || 'Unknown#0000'
        };
        
        if (settings.actions.unjail && settings.actions.unjail.saveRecord) {
            saveToDatabase(userId, userData, caseData);
        }
        
        return { success: true, jailData, caseData };
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
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    
    textCommand: {
        name: 'unjail',
        aliases: []
    },
    
    async execute(client, interactionOrMessage, args) {
        const isSlash = interactionOrMessage.isCommand?.();
        let user, reason, moderator, guild;
        
        try {
            const settingsPath = path.join(__dirname, '../settings.json');
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            
            const commandName = 'unjail';
            const commandConfig = settings.actions[commandName];
            
            if (!commandConfig.enabled) {
                return this.sendResponse(interactionOrMessage, 'هذا الأمر معطل حاليا', isSlash);
            }
            
            if (isSlash) {
                user = interactionOrMessage.options.getUser('user');
                reason = interactionOrMessage.options.getString('reason');
                moderator = interactionOrMessage.user;
                guild = interactionOrMessage.guild;
                
                const member = await guild.members.fetch(moderator.id).catch(() => null);
                const hasPermission = await this.checkPermissions(interactionOrMessage, commandConfig);
                if (!member || !hasPermission) {
                    return this.sendResponse(interactionOrMessage, 'لا تملك الصلاحية لاستخدام هذا الأمر', isSlash);
                }
            } else {
                const message = interactionOrMessage;
                if (args.length < 2) {
                    return message.reply('الاستخدام الصحيح: !unjail @المستخدم السبب');
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
                    return message.reply('لم يتم العثور على المستخدم');
                }
                
                reason = args.slice(1).join(' ');
                moderator = message.author;
                guild = message.guild;
                
                const member = await guild.members.fetch(moderator.id).catch(() => null);
                const hasPermission = await this.checkPermissions(interactionOrMessage, commandConfig);
                if (!member || !hasPermission) {
                    return message.reply('لا تملك الصلاحية لاستخدام هذا الأمر');
                }
            }
            
            const targetMember = await guild.members.fetch(user.id).catch(() => null);
            if (!targetMember) {
                return this.sendResponse(interactionOrMessage, 'المستخدم ليس في السيرفر', isSlash);
            }
            
            const jailResult = removeJailFromDatabase(user.id);
            if (!jailResult.success) {
                return this.sendResponse(interactionOrMessage, 'هذا المستخدم ليس مسجونا', isSlash);
            }
            
            const jailData = jailResult.jailData;
            const jailRoleId = settings.actions.jail.addRole;
            
            if (!targetMember.roles.cache.has(jailRoleId)) {
                return this.sendResponse(interactionOrMessage, 'هذا المستخدم ليس لديه رتبة السجن', isSlash);
            }
            
            const action = 'UNJAIL';
            const courtName = settings.court.name;
            const date = new Date().toLocaleString('en-US');
            const caseId = generateCaseId();
            
            try {
                await targetMember.roles.remove(jailRoleId);
                
                if (jailData.originalRoles && jailData.originalRoles.length > 0) {
                    await targetMember.roles.add(jailData.originalRoles);
                }
                
                await restoreChannelPermissions(guild, user.id);
                
            } catch (error) {
                console.error('Error unjailing user:', error);
                let errorMessage = 'فشل في اطلاق سراح المستخدم';
                
                if (error.code === 50013) {
                    errorMessage = 'ليس لدي صلاحية ادارة الرتب او القنوات';
                } else if (error.code === 50001) {
                    errorMessage = 'ليس لدي صلاحية الوصول الى هذا المستخدم';
                } else if (error.message.includes('permissions')) {
                    errorMessage = 'تأكد من ان البوت لديه صلاحية Manage Roles و Manage Channels';
                }
                
                return this.sendResponse(interactionOrMessage, errorMessage, isSlash);
            }
            
            const caseData = {
                caseId: caseId,
                action: action,
                reason: reason,
                moderatorId: moderator.id,
                moderator: moderator.username,
                court: courtName,
                timestamp: date,
                originalJailCaseId: jailData.caseId
            };
            
            const userData = {
                username: user.username,
                tag: user.tag
            };
            
            let saveSuccess = true;
            if (settings.actions.unjail && settings.actions.unjail.saveRecord) {
                saveSuccess = saveToDatabase(user.id, userData, caseData);
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
            
            let replyMessage = `تم اطلاق سراح <@${user.id}> (Case ID: \`${caseId}\`)\n`;
            replyMessage += `السبب: ${reason}\n`;
            replyMessage += `سجن سابق: \`${jailData.caseId}\`\n`;
            replyMessage += `تم استعادة: ${jailData.originalRoles?.length || 0} رتبة`;
            
            if (!saveSuccess) {
                replyMessage += '\nحدث خطأ في حفظ السجل في قاعدة البيانات';
            }
            
            await this.sendResponse(interactionOrMessage, replyMessage, isSlash, false);
            
            if (settings.actions.unjail && settings.actions.unjail.dm) {
                try {
                    await user.send(`تم اطلاق سراحك من السجن في ${guild.name}\nCase ID: \`${caseId}\`\nالسبب: ${reason}\nبواسطة: <@${moderator.id}>\nالتاريخ: ${date}`);
                } catch (error) {
                    console.log('Could not send DM to user');
                }
            }
            
        } catch (error) {
            console.error(`Error in unjail:`, error);
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