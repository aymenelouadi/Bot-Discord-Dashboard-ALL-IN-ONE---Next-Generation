/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const fs = require('fs');
const path = require('path');
const { PermissionFlagsBits } = require('discord.js');

module.exports = {
    name: 'auto-role-system',

    execute(client) {
        console.log('Loading auto-role system...');

        this.client = client;
        this.dbPath = path.join(__dirname, '../database/auto_role.json');
        this.invitesCache = new Map(); // guildId => Map(code => uses)

        this.loadDatabase();

        client.once('ready', async () => {
            for (const guild of client.guilds.cache.values()) {
                await this.cacheGuildInvites(guild);
            }
        });

        client.on('guildCreate', async (guild) => {
            await this.cacheGuildInvites(guild);
        });

        client.on('inviteCreate', (invite) => {
            const guildId = invite.guild?.id;
            if (!guildId || !invite.code) return;
            const cached = this.invitesCache.get(guildId) || new Map();
            cached.set(invite.code, invite.uses || 0);
            this.invitesCache.set(guildId, cached);
        });

        client.on('inviteDelete', (invite) => {
            const guildId = invite.guild?.id;
            if (!guildId || !invite.code) return;
            const cached = this.invitesCache.get(guildId);
            if (!cached) return;
            cached.delete(invite.code);
            this.invitesCache.set(guildId, cached);
        });

        client.on('interactionCreate', async (interaction) => {
            if (interaction.isButton() && interaction.customId.startsWith('autorole_')) {
                console.log(`Button pressed: ${interaction.customId}`);
                await this.handleButtonInteraction(interaction);
            }

            if (interaction.isStringSelectMenu() && interaction.customId.startsWith('autorole_select_')) {
                console.log(`Select menu used: ${interaction.customId}`);
                await this.handleSelectMenu(interaction);
            }
        });

        client.on('guildMemberAdd', async (member) => {
            console.log(`New member joined: ${member.user.tag} (${member.user.bot ? 'bot' : 'human'})`);
            await this.assignAutoRoles(member);
        });

        console.log('Auto-role system loaded successfully');
    },

    loadDatabase() {
        try {
            console.log(`Loading database from: ${this.dbPath}`);

            if (!fs.existsSync(this.dbPath)) {
                console.log('Creating new database...');
                fs.writeFileSync(this.dbPath, JSON.stringify({}, null, 2));
                this.db = {};
            } else {
                const data = fs.readFileSync(this.dbPath, 'utf8').replace(/^\uFEFF/, '');
                this.db = JSON.parse(data);

                console.log(`Database loaded: ${Object.keys(this.db).length} guilds`);
            }

            if (typeof this.db !== 'object' || Array.isArray(this.db)) this.db = {};
            this.migrateLegacySchema();

        } catch (error) {
            console.error('Error loading database:', error);
            this.db = {};
        }
    },

    migrateLegacySchema() {
        let changed = false;

        for (const guildId of Object.keys(this.db)) {
            const raw = this.db[guildId];
            const normalized = this.normalizeGuildData(guildId, raw);
            if (JSON.stringify(raw) !== JSON.stringify(normalized)) {
                this.db[guildId] = normalized;
                changed = true;
            }
        }

        if (changed) this.saveDatabase();
    },

    normalizeGuildData(guildId, data) {
        const obj = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
        const memberRoles = Array.isArray(obj.memberRoles)
            ? obj.memberRoles
            : (Array.isArray(obj.humans) ? obj.humans : []);
        const botRoles = Array.isArray(obj.botRoles)
            ? obj.botRoles
            : (Array.isArray(obj.bots) ? obj.bots : []);
        const inviteRoles = Array.isArray(obj.inviteRoles)
            ? obj.inviteRoles
            : [];

        return {
            guildId: String(guildId),
            enabled: obj.enabled !== false,
            memberRoles: Array.from(new Set(memberRoles.map(String).filter(Boolean))),
            botRoles: Array.from(new Set(botRoles.map(String).filter(Boolean))),
            inviteRoles: inviteRoles
                .filter(x => x && typeof x === 'object')
                .map(x => ({ invite: String(x.invite || '').trim(), role: String(x.role || '').trim() }))
                .filter(x => x.invite && x.role)
        };
    },

    getGuildData(guildId) {
        if (!this.db[guildId]) {
            this.db[guildId] = this.normalizeGuildData(guildId, {});
        } else {
            this.db[guildId] = this.normalizeGuildData(guildId, this.db[guildId]);
        }
        return this.db[guildId];
    },

    saveDatabase() {
        try {
            fs.writeFileSync(this.dbPath, JSON.stringify(this.db, null, 2));
            console.log('Database saved');
            return true;
        } catch (error) {
            console.error('Error saving database:', error);
            return false;
        }
    },

    async cacheGuildInvites(guild) {
        try {
            if (!guild || !guild.members?.me) return;
            if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageGuild)) return;

            const invites = await guild.invites.fetch();
            const map = new Map();
            invites.forEach(inv => map.set(inv.code, inv.uses || 0));
            this.invitesCache.set(guild.id, map);
        } catch (error) {
            console.log(`[auto-role] Could not cache invites for guild ${guild?.id}: ${error.message}`);
        }
    },

    async resolveUsedInvite(guild) {
        try {
            if (!guild || !guild.members?.me) return null;
            if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageGuild)) return null;

            const previous = this.invitesCache.get(guild.id) || new Map();
            const currentInvites = await guild.invites.fetch();
            const current = new Map();
            currentInvites.forEach(inv => current.set(inv.code, inv.uses || 0));

            let usedCode = null;
            let deltaMax = 0;

            for (const [code, uses] of current.entries()) {
                const oldUses = previous.get(code) || 0;
                const delta = uses - oldUses;
                if (delta > deltaMax) {
                    deltaMax = delta;
                    usedCode = code;
                }
            }

            this.invitesCache.set(guild.id, current);
            return usedCode;
        } catch (error) {
            console.log(`[auto-role] Could not resolve used invite in guild ${guild?.id}: ${error.message}`);
            return null;
        }
    },

    async handleButtonInteraction(interaction) {
        try {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
                return await interaction.reply({
                    content: 'You need `Manage Roles` permission',
                    ephemeral: true
                });
            }

            const customId = interaction.customId;
            console.log(`Processing button: ${customId}`);

            if (customId === 'autorole_humans') {
                await this.showRoleActions(interaction, 'humans');
            }
            else if (customId === 'autorole_bots') {
                await this.showRoleActions(interaction, 'bots');
            }
            else if (customId === 'autorole_back') {
                await this.showMainMenu(interaction);
            }
            else if (customId.startsWith('autorole_') && customId.includes('_add')) {
                const type = customId.split('_')[1];
                await this.showRoleSelection(interaction, type, 'add');
            }
            else if (customId.startsWith('autorole_') && customId.includes('_remove')) {
                const type = customId.split('_')[1];
                await this.showRoleSelection(interaction, type, 'remove');
            }
        } catch (error) {
            console.error('Error in handleButtonInteraction:', error);
            await interaction.reply({ content: 'An error occurred', ephemeral: true });
        }
    },

    async handleSelectMenu(interaction) {
        try {
            const customId = interaction.customId;
            const [,, type, action] = customId.split('_');
            const roleId = interaction.values[0];
            const guildId = interaction.guildId;

            console.log(`Processing select menu: type=${type}, action=${action}, roleId=${roleId}`);

            const guild = interaction.guild;
            const role = guild.roles.cache.get(roleId);

            if (!role) {
                return await interaction.update({
                    content: 'Role not found',
                    embeds: [], components: [] 
                });
            }

            this.loadDatabase();

            const guildData = this.getGuildData(guildId);
            const typeKey = type === 'bots' ? 'botRoles' : 'memberRoles';

            let statusMessage;

            if (action === 'add') {
                if (!guildData[typeKey].includes(roleId)) {
                    guildData[typeKey].push(roleId);
                    guildData[typeKey] = Array.from(new Set(guildData[typeKey]));
                    this.saveDatabase();
                    console.log(`Added: ${role.name} to ${type}`);
                    statusMessage = `✅ Role **${role.name}** added for ${type}`;
                } else {
                    console.log(`Role already exists: ${role.name} in ${type}`);
                    statusMessage = `⚠️ Role **${role.name}** already exists for ${type}`;
                }
            } else if (action === 'remove') {
                const index = guildData[typeKey].indexOf(roleId);
                if (index !== -1) {
                    guildData[typeKey].splice(index, 1);
                    this.saveDatabase();
                    console.log(`Removed: ${role.name} from ${type}`);
                    statusMessage = `❌ Role **${role.name}** removed from ${type}`;
                } else {
                    console.log(`Role not found: ${role.name} in ${type}`);
                    statusMessage = `⚠️ Role **${role.name}** not found for ${type}`;
                }
            }

            await this.showRoleActions(interaction, type, statusMessage);

        } catch (error) {
            console.error('Error in handleSelectMenu:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: 'An error occurred', ephemeral: true });
            }
        }
    },

    async showMainMenu(interaction) {
        try {
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

            await interaction.update({
                content: '## ⚙️ Auto Role Management\n> Select the user type to manage auto roles for',
                embeds: [],
                components: [row]
            });
        } catch (error) {
            console.error('Error in showMainMenu:', error);
        }
    },

    async showRoleActions(interaction, type, statusMessage = null) {
        try {
            const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

            const typeLabel = type === 'humans' ? '👤 Members' : '🤖 Bots';
            const header = statusMessage
                ? `${statusMessage}\n\n## ${typeLabel}\n> Select an action`
                : `## ${typeLabel}\n> Select an action`;

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`autorole_${type}_add`)
                        .setLabel('➕ Add Role')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`autorole_${type}_remove`)
                        .setLabel('➖ Remove Role')
                        .setStyle(ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId('autorole_back')
                        .setLabel('← Back')
                        .setStyle(ButtonStyle.Secondary)
                );

            await interaction.update({ content: header, embeds: [], components: [row] });
        } catch (error) {
            console.error('Error in showRoleActions:', error);
        }
    },

    async showRoleSelection(interaction, type, action) {
        try {
            const { StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

            const guild = interaction.guild;
            const roles = guild.roles.cache
                .filter(role => role.id !== guild.id)
                .sort((a, b) => b.position - a.position)
                .first(25);

            if (roles.length === 0) {
                return await interaction.update({
                    content: '⚠️ No roles found in this server',
                    embeds: [],
                    components: []
                });
            }

            const actionLabel = action === 'add' ? '➕ Add' : '➖ Remove';
            const typeLabel = type === 'humans' ? '👤 Members' : '🤖 Bots';
            const placeholder = action === 'add' ? 'Select a role to add' : 'Select a role to remove';

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`autorole_select_${type}_${action}`)
                .setPlaceholder(placeholder)
                .setMinValues(1)
                .setMaxValues(1);

            roles.forEach(role => {
                selectMenu.addOptions(
                    new StringSelectMenuOptionBuilder()
                        .setLabel(role.name)
                        .setValue(role.id)
                        .setDescription(`ID: ${role.id}`)
                );
            });

            const row1 = new ActionRowBuilder().addComponents(selectMenu);
            const row2 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`autorole_${type}`)
                        .setLabel('← Back')
                        .setStyle(ButtonStyle.Secondary)
                );

            await interaction.update({
                content: `## ${actionLabel} Role — ${typeLabel}\n> Select a role from the list`,
                embeds: [],
                components: [row1, row2]
            });
        } catch (error) {
            console.error('Error in showRoleSelection:', error);
        }
    },

    async addRolesSafely(member, roleIds) {
        if (!Array.isArray(roleIds) || roleIds.length === 0) return 0;

        const guild = member.guild;
        const botMember = await guild.members.fetch(this.client.user.id).catch(() => null);
        if (!botMember) {
            console.log('Bot not found in server');
            return 0;
        }

        const botHighestRole = botMember.roles.highest;
        let rolesAdded = 0;

        for (const roleId of roleIds) {
            try {
                const role = guild.roles.cache.get(roleId);
                if (!role) continue;
                if (role.position >= botHighestRole.position) continue;
                if (member.roles.cache.has(role.id)) continue;

                await member.roles.add(role);
                rolesAdded++;
            } catch (error) {
                console.error(`Error adding role ${roleId}:`, error.message);
            }
        }

        return rolesAdded;
    },

    async assignAutoRoles(member) {
        try {
            console.log(`Attempting to assign auto roles to ${member.user.tag}`);

            this.loadDatabase();

            const guild = member.guild;
            const guildId = guild.id;

            const guildData = this.getGuildData(guildId);
            if (!guildData.enabled) {
                console.log(`Auto-role disabled in guild ${guildId}`);
                return;
            }

            const isBot = member.user.bot;
            const baseRoles = isBot ? guildData.botRoles : guildData.memberRoles;
            const roleSet = new Set(baseRoles);

            if (!isBot && guildData.inviteRoles.length > 0) {
                const usedInvite = await this.resolveUsedInvite(guild);
                if (usedInvite) {
                    const inviteRule = guildData.inviteRoles.find(x => x.invite === usedInvite);
                    if (inviteRule?.role) {
                        roleSet.add(inviteRule.role);
                        console.log(`[auto-role] Invite ${usedInvite} matched role ${inviteRule.role}`);
                    }
                }
            }

            const roleIds = Array.from(roleSet);
            if (roleIds.length === 0) {
                console.log(`No roles configured for member type in guild ${guildId}`);
                return;
            }

            const rolesAdded = await this.addRolesSafely(member, roleIds);

            if (rolesAdded > 0) {
                console.log(`Added ${rolesAdded} auto roles to ${member.user.tag}`);
            } else {
                console.log(`No roles added to ${member.user.tag}`);
            }

        } catch (error) {
            console.error('Error in assignAutoRoles:', error);
            console.error('Stack:', error.stack);
        }
    }
};

/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */