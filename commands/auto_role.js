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
        .setName('auto_role')
        .setDescription('Manage auto roles for new members')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

    textCommand: {
        name: 'ar',
        aliases: []
    },

    async execute(client, interactionOrMessage, args) {
        const isSlash = interactionOrMessage.isCommand?.();
        
        try {
            const settingsPath = path.join(__dirname, '../settings.json');
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            
            const commandName = 'auto_role';
            const commandConfig = settings.actions[commandName];
            
            if (!commandConfig.enabled) {
                return this.sendResponse(interactionOrMessage, 'This command is currently disabled', isSlash);
            }
            
            const hasPermission = await this.checkPermissions(interactionOrMessage, commandConfig);
            if (!hasPermission) {
                return this.sendResponse(interactionOrMessage, 'You do not have permission to use this command', isSlash);
            }

            if (!isSlash) {
                return await this.handleTextCommand(interactionOrMessage, args, client, commandConfig);
            }
            
            await this.showMainMenu(interactionOrMessage, client, commandConfig);

        } catch (error) {
            console.error(`Error in auto_role:`, error);
            return this.sendResponse(interactionOrMessage, 'An error occurred', isSlash);
        }
    },

    async checkPermissions(context, commandConfig) {
        const member = context.member;
        
        if (commandConfig.rolesAllowed && commandConfig.rolesAllowed.length > 0) {
            return commandConfig.rolesAllowed.some(roleId => member.roles.cache.has(roleId));
        }
        
        return member.permissions.has(PermissionFlagsBits.ManageRoles);
    },

    async showMainMenu(interaction, client, commandConfig) {
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('autorole_humans')
                    .setLabel('👤 Members')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('autorole_bots')
                    .setLabel('🤖 Bots')
                    .setStyle(ButtonStyle.Primary)
            );

        if (commandConfig.log) {
            const moderator = interaction.user;
            await logSystem.logCommandUsage({
                interaction: interaction,
                commandName: 'auto_role',
                moderator: moderator,
                target: moderator,
                reason: 'Opened auto role menu',

                action: 'auto_role'
            });
        }

        await interaction.reply({
            content: '## ⚙️ Auto Role Management\n> Select the user type to manage auto roles for',
            components: [row],
            ephemeral: true
        });
    },

    async handleTextCommand(message, args, client, commandConfig) {
        try {
            const dbPath = path.join(__dirname, '../database/auto_role.json');
            let db = {};
            const guildId = message.guild.id;
            
            if (fs.existsSync(dbPath)) {
                try {
                    const data = fs.readFileSync(dbPath, 'utf8').replace(/^\uFEFF/, '');
                    db = JSON.parse(data);
                } catch (error) {
                    console.error('Error reading database:', error);
                }
            }
            
            if (!args || args.length === 0) {
                return await this.showTextHelp(message);
            }
            
            const action = args[0].toLowerCase();
            
            if (action === 'list') {
                return await this.showRoleList(message, db);
            }
            
            if (args.length < 3) {
                return message.reply('Usage: !ar [add/remove/list] [humans/bots] @role');
            }
            
            const type = args[1].toLowerCase();
            if (!['humans', 'bots'].includes(type)) {
                return message.reply('Type must be: humans or bots');
            }

            if (!db[guildId] || typeof db[guildId] !== 'object') {
                db[guildId] = { guildId, enabled: true, memberRoles: [], botRoles: [], inviteRoles: [] };
            }

            const guildData = db[guildId];
            if (!Array.isArray(guildData.memberRoles)) guildData.memberRoles = Array.isArray(guildData.humans) ? guildData.humans : [];
            if (!Array.isArray(guildData.botRoles)) guildData.botRoles = Array.isArray(guildData.bots) ? guildData.bots : [];

            const key = type === 'humans' ? 'memberRoles' : 'botRoles';
            
            const roleMention = message.mentions.roles.first();
            if (!roleMention) {
                return message.reply('You must mention a role');
            }
            
            if (action === 'add') {
                if (!guildData[key].includes(roleMention.id)) {
                    guildData[key].push(roleMention.id);
                    guildData[key] = Array.from(new Set(guildData[key].map(String)));
                    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
                    
                    if (commandConfig.log) {
                        await logSystem.logCommandUsage({
                            interaction: message,
                            commandName: 'auto_role',
                            moderator: message.author,
                            target: message.author,
                            reason: `Added role ${roleMention.name} for ${type}`,
                            action: 'auto_role'
                        });
                    }
                    
                    return message.reply(`Role **${roleMention.name}** added automatically for ${type}`);
                } else {
                    return message.reply(`Role **${roleMention.name}** already exists for ${type}`);
                }
            }
            
            if (action === 'remove') {
                const index = guildData[key].indexOf(roleMention.id);
                if (index !== -1) {
                    guildData[key].splice(index, 1);
                    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
                    
                    if (commandConfig.log) {
                        await logSystem.logCommandUsage({
                            interaction: message,
                            commandName: 'auto_role',
                            moderator: message.author,
                            target: message.author,
                            reason: `Removed role ${roleMention.name} from ${type}`,
                            action: 'auto_role'
                        });
                    }
                    
                    return message.reply(`Role **${roleMention.name}** removed from ${type} auto roles`);
                } else {
                    return message.reply(`Role **${roleMention.name}** not found for ${type}`);
                }
            }
            
            return message.reply('Unknown action: use add, remove, or list');
            
        } catch (error) {
            console.error('Error in handleTextCommand:', error);
            return message.reply('An error occurred');
        }
    },

    async showTextHelp(message) {
        try {
            const help = [
                '## ⚙️ Auto Roles — Help',
                '',
                '**View current roles**',
                '> `!ar list`',
                '',
                '**Add a role**',
                '> `!ar add humans @role` — for human members',
                '> `!ar add bots @role` — for bots',
                '',
                '**Remove a role**',
                '> `!ar remove humans @role`',
                '> `!ar remove bots @role`',
                '',
                '-# You can also use `/auto_role` for the interactive interface'
            ].join('\n');

            await message.reply({ content: help });
        } catch (error) {
            console.error('Error in showTextHelp:', error);
            await message.reply('An error occurred while showing help');
        }
    },

    async showRoleList(message, db) {
        try {
            const guild = message.guild;
            const guildId = guild.id;

            const data = (db && db[guildId] && typeof db[guildId] === 'object') ? db[guildId] : {};
            const humans = Array.isArray(data.memberRoles) ? data.memberRoles : (Array.isArray(data.humans) ? data.humans : []);
            const bots = Array.isArray(data.botRoles) ? data.botRoles : (Array.isArray(data.bots) ? data.bots : []);
            const inviteRoles = Array.isArray(data.inviteRoles) ? data.inviteRoles : [];

            const resolveRole = (roleId) => {
                const role = guild.roles.cache.get(roleId);
                return role ? `<@&${roleId}>` : `~~${roleId}~~`;
            };

            const humansList = humans.length > 0
                ? humans.map(resolveRole).join(', ')
                : '*No roles set*';

            const botsList = bots.length > 0
                ? bots.map(resolveRole).join(', ')
                : '*No roles set*';

            const inviteList = inviteRoles.length > 0
                ? inviteRoles.map(x => `\`${x.invite}\` → ${resolveRole(x.role)}`).join('\n')
                : '*No rules set*';

            const lines = [
                `## 📋 Auto Roles — ${guild.name}`,
                '',
                `**👤 Member Roles (${humans.length})**`,
                `> ${humansList}`,
                '',
                `**🤖 Bot Roles (${bots.length})**`,
                `> ${botsList}`,
                '',
                `**🔗 Invite Roles (${inviteRoles.length})**`,
                inviteList,
                '',
                `-# Status: ${data.enabled !== false ? '✅ Enabled' : '❌ Disabled'} • Total: ${humans.length + bots.length} roles`
            ].join('\n');

            await message.reply({ content: lines });
        } catch (error) {
            console.error('Error in showRoleList:', error);
            await message.reply('An error occurred while showing the role list');
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