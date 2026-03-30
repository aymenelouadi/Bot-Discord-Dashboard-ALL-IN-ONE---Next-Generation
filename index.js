/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const fs = require('fs');
const path = require('path');
const { Client, Collection, GatewayIntentBits, REST, Routes } = require('discord.js');
require('dotenv').config();
const logger       = require('./utils/logger');
const settingsUtil = require('./utils/settings');
const guildSystem  = require('./utils/guildSystem');
const cmdLang      = require('./utils/cmdLang');
const dbSchemas    = require('./systems/schemas');
const guildDb      = require('./dashboard/utils/guildDb');

// ── Dashboard ──────────────────────────────────────────
require('./dashboard/server').start();

// Unhandled errors are caught by logger.js process handlers

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildWebhooks
    ]
});

client.commands = new Collection();
client.systems = new Collection();
client.textCommands = new Collection();

const loadFiles = (directory, callback) => {
    const dirPath = path.join(__dirname, directory);
    if (!fs.existsSync(dirPath)) return logger.warn(`Directory not found: ${directory}`, { category: 'loader' });
    fs.readdirSync(dirPath).filter(file => file.endsWith('.js')).forEach(file => {
        const filePath = path.join(dirPath, file);
        try {
            const loadedFile = require(filePath);
            callback(file, loadedFile);
        } catch (err) {
            logger.error(`Failed to load file: ${filePath}`, { category: 'loader', error: err.message, stack: err.stack });
        }
    });
};

loadFiles('commands', (file, command) => {
    const actionKey = file.replace('.js', '');
    command._actionKey = actionKey;
    if (command.data && typeof command.execute === 'function') {
        client.commands.set(command.data.name, command);
            logger.discord(`Command loaded: ${command.data.name}`, { category: 'loader' });
    }
    if (command.textCommand) {
        client.textCommands.set(command.textCommand.name, command);
        const actionCfg     = settingsUtil.get().actions?.[actionKey] || {};
        const globalAliases = actionCfg.aliases || [];
        const label         = actionCfg.label;
        // Register the settings label as a trigger so !label always works
        if (label && label !== command.textCommand.name) {
            client.textCommands.set(label, command);
        }
        [...(command.textCommand.aliases || []), ...globalAliases].forEach(alias => {
            client.textCommands.set(alias, command);
        });
    }
});

loadFiles('systems', (file, system) => {
    if (system.name && typeof system.execute === 'function') {
        system.execute(client);
        client.systems.set(system.name, system);
        logger.discord(`System loaded: ${system.name}`, { category: 'loader' });
    }
});

const updateSlashCommands = async () => {
    const commands = [...client.commands.values()]
        .filter(cmd => cmd.data)
        .map(cmd => cmd.data.toJSON());
    try {
        await new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN)
            .put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        logger.discord('Slash commands updated successfully');
    } catch (error) {
        logger.error('Failed to update slash commands', { category: 'discord', error: error.message, stack: error.stack });
    }
};

const guildCmds = require('./utils/guildCmds');

client.once('ready', async () => {
    const status = 'Online';
    const developerName = 'Shaad You';
    const developerId = '756947441592303707';
    const poweredBy = 'Next Generation';
    const discordLink = 'https://discord.gg/BhJStSa89s';
    const loginTime = new Date().toLocaleString();

    console.log(`
██████╗ ██████╗ ██████╗ ███████╗    ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗
██╔════╝██╔═══██╗██╔══██╗██╔════╝    ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝
██║     ██║   ██║██║  ██║█████╗      ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗
██║     ██║   ██║██║  ██║██╔══╝      ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║
╚██████╗╚██████╔╝██████╔╝███████╗    ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║
 ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝    ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝

Status          : ${status}
Project Developer: ${developerName}
Developer Id     : ${developerId}
Powered by       : ${poweredBy}
Discord link     : ${discordLink}
Logged in at     : ${loginTime}
`);
    await updateSlashCommands();
    // Share the client with the dashboard
    require('./dashboard/utils/botClient').setClient(client);
    // Initialise per-guild commands.json for every guild the bot is already in
    client.guilds.cache.forEach(guild => {
        try { guildCmds.init(guild.id); } catch (e) { logger.error('guildCmds.init failed', { category: 'discord', guildId: guild.id, error: e.message }); }
    });
    logger.discord(`guildCmds initialised for ${client.guilds.cache.size} guild(s)`);

    // ── Auto-Leave sweep on startup ─────────────────────────────────────────
    const srvCfg = settingsUtil.get()?.DASHBOARD?.SERVERS || {};
    if (srvCfg.LEAVE_AUTO) {
        const allowed = Array.isArray(srvCfg.SERVER_ALLOWED) ? srvCfg.SERVER_ALLOWED : [];
        if (allowed.length > 0) {
            for (const [, guild] of client.guilds.cache) {
                if (!allowed.includes(guild.id)) {
                    logger.discord(`Auto-Leave startup sweep — leaving disallowed guild: ${guild.name}`, { guildId: guild.id });
                    try { await guild.leave(); } catch (e) { logger.error('Auto-Leave failed to leave guild', { guildId: guild.id, error: e.message }); }
                }
            }
        }
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const guildId = interaction.guild?.id;
    const sysCfg  = guildSystem.resolve(guildId);
    const lang    = sysCfg.COMMANDS.lang || 'en';

    if (!sysCfg.COMMANDS.ENABLE_SLASH_COMMANDS) {
        const bothOff = !sysCfg.COMMANDS.ENABLE_PREFIX && !sysCfg.COMMANDS.ENABLE_SLASH_COMMANDS;
        const msgKey  = bothOff ? 'system.maintenance' : 'system.slash_disabled';
        return interaction.reply({ content: cmdLang.t(lang, msgKey), flags: 64 });
    }

    const command = client.commands.get(interaction.commandName);
    if (!command) return interaction.reply({ content: 'Command not found.', flags: 64 });
    try {
        await command.execute(client, interaction);
    } catch (error) {
        logger.error('Error handling slash command', {
            category: 'discord',
            command:  interaction.commandName,
            userId:   interaction.user?.id,
            guildId,
            error:    error.message,
            stack:    error.stack,
        });
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: cmdLang.t(lang, 'system.error'), flags: 64 });
            } else {
                await interaction.followUp({ content: cmdLang.t(lang, 'system.error'), flags: 64 });
            }
        } catch (replyError) {
            if (replyError.code !== 10062) logger.error('Failed to send error reply', { category: 'discord', error: replyError.message });
        }
    }
});

/* ── Log when bot joins a new guild ── */
client.on('guildCreate', async (guild) => {
    // ── Auto-Leave: check if this guild is allowed ──────────────────────────
    const srvCfg = settingsUtil.get()?.DASHBOARD?.SERVERS || {};
    if (srvCfg.LEAVE_AUTO) {
        const allowed = Array.isArray(srvCfg.SERVER_ALLOWED) ? srvCfg.SERVER_ALLOWED : [];
        if (allowed.length > 0 && !allowed.includes(guild.id)) {
            logger.discord(`Auto-Leave — leaving disallowed guild: ${guild.name}`, { guildId: guild.id });
            try { await guild.leave(); } catch (e) { logger.error('Auto-Leave failed to leave guild', { guildId: guild.id, error: e.message }); }
            return;
        }
    }

    // Initialise an isolated commands.json for this guild immediately
    try { guildCmds.init(guild.id); } catch (e) { logger.error('guildCmds.init failed', { category: 'discord', guildId: guild.id, error: e.message }); }
    try {
        const dashLogs = require('./dashboard/utils/dashboardLogs');
        dashLogs.addEntry({
            type:        'guild_join',
            guildId:     guild.id,
            guildName:   guild.name,
            guildIcon:   guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64` : null,
            memberCount: guild.memberCount,
            ownerId:     guild.ownerId,
        });
    } catch (_) {}
});

client.on('guildMemberAdd', (member) => {
    try { require('./dashboard/utils/activityTracker').increment(member.guild.id, 'joins'); } catch (_) {}
});

client.on('guildMemberRemove', (member) => {
    try { require('./dashboard/utils/activityTracker').increment(member.guild.id, 'leaves'); } catch (_) {}
});

client.on('voiceStateUpdate', (oldState, newState) => {
    if (!oldState.channelId && newState.channelId) {
        try { require('./dashboard/utils/activityTracker').increment(newState.guild.id, 'voice'); } catch (_) {}
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;
    try { require('./dashboard/utils/activityTracker').increment(message.guild.id, 'messages'); } catch (_) {}

    const afkData = await getAFKUser(message.author.id);
    if (afkData) {
        await removeAFKFromDatabase(message.author.id);
        
        const duration = formatTimeSince(afkData.timestamp);
        await message.reply(`<@${message.author.id}> is no longer AFK after ${duration}.`)
            .then(msg => setTimeout(() => msg.delete().catch(() => {}), 5000))
            .catch(() => {});
    }
    
    let afkNotifiedId = null;
    if (message.reference && message.reference.messageId) {
        try {
            const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
            const repliedUserAFK = await getAFKUser(repliedMessage.author.id);
            
            if (repliedUserAFK && repliedMessage.author.id !== message.author.id) {
                const response = `<@${repliedMessage.author.id}> is AFK: **${repliedUserAFK.reason}**`;
                await message.reply(response)
                    .then(msg => setTimeout(() => msg.delete().catch(() => {}), 10000))
                    .catch(() => {});
                afkNotifiedId = repliedMessage.author.id;
            }
        } catch (error) {
            if (error.code !== 10008) logger.error('Error fetching replied message', { category: 'discord', error: error.message });
        }
    }
    
    const mentions = message.mentions.users;
    if (mentions.size > 0) {
        for (const [userId, user] of mentions) {
            if (userId === message.author.id) continue;
            if (userId === afkNotifiedId) continue; // already notified via reply-reference
            
            const mentionedUserAFK = await getAFKUser(userId);
            if (mentionedUserAFK) {
                const response = `<@${userId}> is AFK: **${mentionedUserAFK.reason}**`;
                await message.reply(response)
                    .then(msg => setTimeout(() => msg.delete().catch(() => {}), 10000))
                    .catch(() => {});
                break;
            }
        }
    }
    
    const guildId  = message.guild.id;
    const sysCfg   = guildSystem.resolve(guildId);
    const lang     = sysCfg.COMMANDS.lang || 'en';

    if (!sysCfg.COMMANDS.ENABLE_PREFIX) return;

    const prefix = sysCfg.PREFIX || '!';
    if (!message.content.startsWith(prefix)) return;

    const args        = message.content.slice(prefix.length).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();

    // 1. Check registered textCommand names (includes global aliases loaded at startup)
    let command = client.textCommands.get(commandName);

    // 2. Check per-guild label + aliases at dispatch time
    if (!command) {
        const guildCmdsUtil = require('./utils/guildCmds');
        for (const [, cmd] of client.textCommands) {
            if (!cmd._actionKey) continue;
            const cfg = guildCmdsUtil.resolve(guildId, cmd._actionKey);
            // Match per-guild label override
            if (cfg.label && cfg.label === commandName) { command = cmd; break; }
            // Match per-guild aliases
            if (cfg.aliases?.includes(commandName)) { command = cmd; break; }
        }
    }

    // 3. Fallback: match global settings label (handles runtime label changes)
    if (!command) {
        const allActions = settingsUtil.get().actions || {};
        for (const [, cmd] of client.textCommands) {
            if (!cmd._actionKey) continue;
            const lbl = allActions[cmd._actionKey]?.label;
            if (lbl && lbl === commandName) { command = cmd; break; }
        }
    }

    if (!command) return;

    try {
        await command.execute(client, message, args);
    } catch (error) {
        logger.error('Error handling text command', {
            category: 'discord',
            command:  commandName,
            userId:   message.author?.id,
            guildId:  message.guild?.id,
            error:    error.message,
            stack:    error.stack,
        });
        message.reply(cmdLang.t(lang, 'system.error')).catch(() => {});
    }
    
});

const getAFKUser = async (userId) => {
    try {
        return await dbSchemas.AFK.findOne({ userId }).lean();
    } catch {
        return null;
    }
};

const removeAFKFromDatabase = async (userId) => {
    try {
        return await dbSchemas.AFK.findOneAndDelete({ userId }).lean();
    } catch {
        return null;
    }
};

function formatTimeSince(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days} day${days > 1 ? 's' : ''}`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''}`;
    if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''}`;
    return `${seconds} second${seconds > 1 ? 's' : ''}`;
}

// ── Bootstrap: connect MongoDB → warm cache → login ──────────────────────────
(async () => {
    try {
        await dbSchemas.connect();
        await require('./utils/settings').loadFromMongoDB();
        await guildDb.loadFromMongoDB();
    } catch (e) {
        logger.error('MongoDB bootstrap error', { category: 'db', error: e.message, stack: e.stack });
    }
    client.login(process.env.DISCORD_TOKEN);
})();

/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */