/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

/**
 * ── LEVEL SYSTEM ──────────────────────────────────────────────
 *  Tracks text messages (XP or count) and voice time (XP or minutes).
 *  Assigns reward roles when thresholds are reached.
 *  Level-up notifications via Discord Components V2.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const GUILD_DB_DIR = path.join(__dirname, '../dashboard/database');

function dbPath(guildId)  { return path.join(GUILD_DB_DIR, guildId, 'levels.json'); }
function cfgPath(guildId) { return path.join(GUILD_DB_DIR, guildId, 'settings.json'); }

// ── XP Algorithm ────────────────────────────────────────────────
// XP required to advance FROM level n  →  level n+1
function xpForLevel(level) {
    return 5 * level * level + 50 * level + 100;
}

// Total cumulative XP needed to REACH level n (from 0)
function totalXpToLevel(level) {
    let total = 0;
    for (let i = 0; i < level; i++) total += xpForLevel(i);
    return total;
}

// Level reached from given cumulative XP
function levelFromXp(totalXp) {
    let lvl = 0;
    while (totalXp >= xpForLevel(lvl)) {
        totalXp -= xpForLevel(lvl);
        lvl++;
    }
    return lvl;
}

// Messages mode level formula: messages_to_level(n) = n * 50  (50 msgs per level)
const MESSAGES_PER_LEVEL = 50;
function levelFromMessages(messages) {
    return Math.floor(messages / MESSAGES_PER_LEVEL);
}

// Voice minutes mode: level from minutes (1 level = 30 mins)
const MINUTES_PER_LEVEL = 30;
function levelFromMinutes(minutes) {
    return Math.floor(minutes / MINUTES_PER_LEVEL);
}

// ── Database helpers ─────────────────────────────────────────────
function readJson(filePath) {
    let raw = fs.readFileSync(filePath);
    // Strip UTF-8 BOM if present
    if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) raw = raw.slice(3);
    return JSON.parse(raw.toString('utf8'));
}

function readDb(guildId) {
    try {
        const p = dbPath(guildId);
        if (!fs.existsSync(p)) return {};
        return readJson(p);
    } catch (e) {
        console.error('[Levels] readDb error:', e.message);
        return {};
    }
}

function writeDb(guildId, data) {
    try {
        const p = dbPath(guildId);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('[Levels] writeDb error:', e.message);
    }
}

function getUser(db, userId) {
    if (!db[userId]) {
        db[userId] = {
            textXP: 0, textMessages: 0, textLevel: 0,
            voiceXP: 0, voiceMinutes: 0, voiceLevel: 0,
            lastTextTime: 0, voiceJoinedAt: null
        };
    }
    return db[userId];
}

const DEFAULT_LEVEL_SETTINGS = {
    ENABLE: true,
    TEXT_ACTIVITY:  { ENABLE: true, TRACK_MODE: 'MESSAGES', XP_PER_MESSAGE_MIN: 15, XP_PER_MESSAGE_MAX: 25, COOLDOWN_SECONDS: 60, IGNORE_ROLES: [], IGNORE_CHANNELS: [] },
    VOICE_ACTIVITY: { ENABLE: true, TRACK_MODE: 'XP', XP_PER_MINUTE: 10, IGNORE_MUTED: true, IGNORE_DEAFENED: true },
    REWARD_ROLES: [],
    REWARD_SETTINGS: { REMOVE_PREVIOUS_ROLES: true, DISABLE_REWARDS: false, REMOVE_ON_RESET: true, GIVE_HIGHEST_ROLE_ONLY: true },
    LEVELUP_CHANNEL: '',
    LEVELUP_MESSAGE_ENABLED: true
};

function getSettings(guildId) {
    try {
        const p = cfgPath(guildId);
        if (!fs.existsSync(p)) return { LEVEL_SYSTEM: DEFAULT_LEVEL_SETTINGS };
        const parsed = readJson(p);
        // Ensure LEVEL_SYSTEM key exists (merge with defaults)
        if (!parsed.LEVEL_SYSTEM) parsed.LEVEL_SYSTEM = DEFAULT_LEVEL_SETTINGS;
        return parsed;
    } catch (e) {
        console.error('[Levels] getSettings error for guild', guildId, ':', e.message);
        return { LEVEL_SYSTEM: DEFAULT_LEVEL_SETTINGS };
    }
}

// ── Level-up message using Discord Components V2 ──────────────────
async function sendLevelUpMessage(client, guild, memberId, trackType, newLevel, rewardRole) {
    const settings    = getSettings(guild.id);
    const lvlSettings = settings.LEVEL_SYSTEM;
    if (!lvlSettings?.LEVELUP_MESSAGE_ENABLED) return;

    const member = await guild.members.fetch(memberId).catch(() => null);
    if (!member) return;

    // ── Choose message config ────────────────────────────────────
    const msgs = lvlSettings.MESSAGES || {};
    let msgConfig, msgKey;
    if (rewardRole) {
        msgKey    = 'REWARD_ROLE';
        msgConfig = msgs.REWARD_ROLE || {};
    } else if (trackType === 'text') {
        msgKey    = 'TEXT_LEVELUP';
        msgConfig = msgs.TEXT_LEVELUP || {};
    } else {
        msgKey    = 'VOICE_LEVELUP';
        msgConfig = msgs.VOICE_LEVELUP || {};
    }

    // ── Resolve channel ──────────────────────────────────────────
    const chanId  = msgConfig.CHANNEL || lvlSettings.LEVELUP_CHANNEL || '';
    const channel = chanId ? guild.channels.cache.get(chanId) : null;

    // ── Default texts ────────────────────────────────────────────
    const defaults = {
        REWARD_ROLE:  `**🎉 Congrats, [user]!** You've leveled up from \`[oldLevel]\` to \`[newLevel]\` and earned the **[roleName]** role! 🚀`,
        TEXT_LEVELUP: `**💬 Congrats, [user]!** You've leveled up in text from \`[oldLevel]\` to \`[newLevel]\`!`,
        VOICE_LEVELUP:`**🎙️ Congrats, [user]!** You've leveled up in voice from \`[oldLevel]\` to \`[newLevel]\`!`,
    };

    // ── Build real text with variables ───────────────────────────
    const rawText = msgConfig.TEXT || defaults[msgKey] || '';
    // We don't know oldLevel here — expose it by reading DB
    const db      = readDb(guild.id);
    const ud      = db[memberId] || {};
    const oldLevel = Math.max(0, newLevel - 1);
    const text = rawText
        .replace(/\[user\]/g,      member.toString())
        .replace(/\[userName\]/g,  member.user.username)
        .replace(/\[roleName\]/g,  rewardRole || '')
        .replace(/\[oldLevel\]/g,  String(oldLevel))
        .replace(/\[newLevel\]/g,  String(newLevel));

    // ── Send to channel ──────────────────────────────────────────
    if (channel) {
        try {
            const djs = require('discord.js');
            const { ContainerBuilder, TextDisplayBuilder, MessageFlags } = djs;
            if (!ContainerBuilder) throw new Error('Components V2 unavailable');

            const container = new ContainerBuilder()
                .setAccentColor(0x7c3aed)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(text)
                );

            await channel.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
        } catch {
            try { await channel.send(text); } catch {}
        }
    }

    // ── DM (reward role messages only) ───────────────────────────
    if (rewardRole && msgConfig.DM) {
        try {
            const djs = require('discord.js');
            const { ContainerBuilder, TextDisplayBuilder, MessageFlags } = djs;
            if (!ContainerBuilder) throw new Error('Components V2 unavailable');

            const container = new ContainerBuilder()
                .setAccentColor(0x7c3aed)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(text)
                );
            await member.user.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
        } catch {
            try { await member.user.send(text); } catch {}
        }
    }
}

// ── Reward role assignment ────────────────────────────────────────
async function checkAndApplyRewards(client, guild, memberId, db) {
    const settings = getSettings(guild.id);
    const lvl      = settings.LEVEL_SYSTEM;
    if (!lvl || lvl.REWARD_SETTINGS?.DISABLE_REWARDS) return null;

    const rewardRoles = lvl.REWARD_ROLES || [];
    if (!rewardRoles.length) return null;

    const member = await guild.members.fetch(memberId).catch(() => null);
    if (!member) return null;

    const userData = getUser(db, memberId);
    const textMode = lvl.TEXT_ACTIVITY?.TRACK_MODE || 'MESSAGES';
    const voiceMode = lvl.VOICE_ACTIVITY?.TRACK_MODE || 'XP';

    // Compute effective levels for this user
    const userTextLevel  = textMode  === 'XP'     ? levelFromXp(userData.textXP)       :
                           textMode  === 'MESSAGES'? levelFromMessages(userData.textMessages) : 0;
    const userVoiceLevel = voiceMode === 'XP'     ? levelFromXp(userData.voiceXP)       :
                           voiceMode === 'MINUTES' ? levelFromMinutes(userData.voiceMinutes) : 0;

    let earnedRoleName = null;
    const removePrev   = lvl.REWARD_SETTINGS?.REMOVE_PREVIOUS_ROLES;
    const highestOnly  = lvl.REWARD_SETTINGS?.GIVE_HIGHEST_ROLE_ONLY;

    // Determine which roles the user is now eligible for
    const eligibleRoles = [];
    for (const rr of rewardRoles) {
        if (!rr.ROLE_ID) continue;
        const textOk  = !rr.TEXT_LEVEL  || rr.TEXT_LEVEL  === 0 || userTextLevel  >= rr.TEXT_LEVEL;
        const voiceOk = !rr.VOICE_LEVEL || rr.VOICE_LEVEL === 0 || userVoiceLevel >= rr.VOICE_LEVEL;

        let eligible;
        if (rr.EITHER_LEVEL) {
            eligible = textOk || voiceOk; // Either track sufficient
        } else {
            const needsText  = rr.TEXT_LEVEL  > 0;
            const needsVoice = rr.VOICE_LEVEL > 0;
            eligible = (!needsText || textOk) && (!needsVoice || voiceOk);
        }
        if (eligible) eligibleRoles.push(rr);
    }

    if (!eligibleRoles.length) return null;

    // Determine which roles to actually assign
    const toAssign = highestOnly
        ? [eligibleRoles[eligibleRoles.length - 1]] // highest = last in sorted order
        : eligibleRoles;

    for (const rr of toAssign) {
        const role = guild.roles.cache.get(rr.ROLE_ID);
        if (!role) continue;
        if (member.roles.cache.has(role.id)) continue; // already has it

        // Remove previous reward roles if setting is on
        if (removePrev) {
            const otherRewardRoleIds = rewardRoles
                .map(r => r.ROLE_ID)
                .filter(rid => rid && rid !== role.id);
            for (const rid of otherRewardRoleIds) {
                if (member.roles.cache.has(rid)) {
                    await member.roles.remove(rid, 'Level reward: remove previous').catch(() => {});
                }
            }
        }

        await member.roles.add(role, `Level reward: ${role.name}`).catch(() => {});
        earnedRoleName = role.name;
    }

    return earnedRoleName;
}

// ── Text XP tracking ─────────────────────────────────────────────
function handleTextEvent(client, guild, userId, db, settings) {
    const lvl     = settings.LEVEL_SYSTEM;
    const textCfg = lvl.TEXT_ACTIVITY;
    if (!lvl.ENABLE || !textCfg.ENABLE) return { leveledUp: false };

    const userData = getUser(db, userId);
    const mode     = textCfg.TRACK_MODE || 'MESSAGES';

    let prevLevel, newLevel, leveledUp = false;

    if (mode === 'XP') {
        const min = textCfg.XP_PER_MESSAGE_MIN || 15;
        const max = textCfg.XP_PER_MESSAGE_MAX || 25;
        const xp  = Math.floor(Math.random() * (max - min + 1)) + min;
        prevLevel  = levelFromXp(userData.textXP);
        userData.textXP += xp;
        newLevel = levelFromXp(userData.textXP);
    } else {
        prevLevel = levelFromMessages(userData.textMessages);
        userData.textMessages++;
        newLevel = levelFromMessages(userData.textMessages);
    }

    userData.textLevel = newLevel;
    if (newLevel > prevLevel) leveledUp = true;

    return { leveledUp, newLevel };
}

// ── Voice XP accumulation (called every minute for active voice users) ──
function handleVoiceTick(userId, db, settings) {
    const lvl      = settings.LEVEL_SYSTEM;
    const voiceCfg = lvl.VOICE_ACTIVITY;
    if (!lvl.ENABLE || !voiceCfg.ENABLE) return { leveledUp: false };

    const userData = getUser(db, userId);
    const mode     = voiceCfg.TRACK_MODE || 'XP';

    let prevLevel, newLevel, leveledUp = false;

    if (mode === 'XP') {
        const xpPerMin = voiceCfg.XP_PER_MINUTE || 10;
        prevLevel = levelFromXp(userData.voiceXP);
        userData.voiceXP += xpPerMin;
        newLevel = levelFromXp(userData.voiceXP);
    } else {
        prevLevel = levelFromMinutes(userData.voiceMinutes);
        userData.voiceMinutes++;
        newLevel = levelFromMinutes(userData.voiceMinutes);
    }

    userData.voiceLevel = newLevel;
    if (newLevel > prevLevel) leveledUp = true;

    return { leveledUp, newLevel };
}

// ══════════════════════════════════════════════════════════════════
module.exports = {
    name: 'level-system',

    execute(client) {
        this.client      = client;
        // map of userId → Set of voice channels
        this.voiceUsers  = new Map(); // guildId:userId → state

        // ── Text message listener ────────────────────────────────
        client.on('messageCreate', async (message) => {
            if (!message.guild || message.author.bot) return;

            const { guild, author } = message;
            const settings = getSettings(guild.id);
            const lvl      = settings.LEVEL_SYSTEM;

            if (!lvl?.ENABLE || !lvl.TEXT_ACTIVITY?.ENABLE) return;

            const textCfg = lvl.TEXT_ACTIVITY;

            // Ignore-channel check
            if (textCfg.IGNORE_CHANNELS?.includes(message.channel.id)) return;

            // Ignore-role check
            const member = message.member;
            if (!member) return;
            if (textCfg.IGNORE_ROLES?.some(rid => member.roles.cache.has(rid))) return;

            // Cooldown (only in XP mode)
            const userId  = author.id;
            const db      = readDb(guild.id);
            const userData = getUser(db, userId);

            if (textCfg.TRACK_MODE === 'XP') {
                const cooldown = (textCfg.COOLDOWN_SECONDS || 60) * 1000;
                const now      = Date.now();
                if (now - (userData.lastTextTime || 0) < cooldown) return;
                userData.lastTextTime = now;
            }

            const { leveledUp, newLevel } = handleTextEvent(client, guild, userId, db, settings);
            writeDb(guild.id, db);

            if (leveledUp) {
                const earnedRole = await checkAndApplyRewards(client, guild, userId, db);
                await sendLevelUpMessage(client, guild, userId, 'text', newLevel, earnedRole);
            }
        });

        // ── Voice state tracking ─────────────────────────────────
        client.on('voiceStateUpdate', async (oldState, newState) => {
            const guild = newState.guild || oldState.guild;
            if (!guild) return;

            const settings = getSettings(guild.id);
            const lvl      = settings.LEVEL_SYSTEM;
            if (!lvl?.ENABLE || !lvl.VOICE_ACTIVITY?.ENABLE) return;

            const userId    = newState.member?.id || oldState.member?.id;
            if (!userId) return;
            if (newState.member?.user?.bot) return;

            const voiceCfg  = lvl.VOICE_ACTIVITY;
            const key       = `${guild.id}:${userId}`;

            const channel   = newState.channel;
            const leftAll   = !channel;
            const isDef     = channel ? (newState.deaf  || newState.selfDeaf)  : false;
            const isMuted   = channel ? (newState.mute  || newState.selfMute)  : false;
            const skipDef   = voiceCfg.IGNORE_DEAFENED && isDef;
            const skipMuted = voiceCfg.IGNORE_MUTED    && isMuted;

            const db       = readDb(guild.id);
            const userData  = getUser(db, userId);

            // Accumulate time since join when leaving / becoming ignored
            const flushVoice = () => {
                if (userData.voiceJoinedAt) {
                    const mins = Math.floor((Date.now() - userData.voiceJoinedAt) / 60000);
                    if (mins > 0) {
                        const { leveledUp, newLevel } = handleVoiceTick(userId, db, settings);
                        // Simplified: add exact earned mins/XP
                        if (voiceCfg.TRACK_MODE === 'MINUTES') {
                            userData.voiceMinutes += Math.max(0, mins - 1);
                        } else {
                            userData.voiceXP += Math.max(0, (mins - 1) * (voiceCfg.XP_PER_MINUTE || 10));
                        }
                        userData.voiceLevel = voiceCfg.TRACK_MODE === 'XP'
                            ? levelFromXp(userData.voiceXP)
                            : levelFromMinutes(userData.voiceMinutes);
                    }
                    userData.voiceJoinedAt = null;
                }
            };

            if (leftAll || skipDef || skipMuted) {
                flushVoice();
                this.voiceUsers.delete(key);
            } else {
                userData.voiceJoinedAt = userData.voiceJoinedAt || Date.now();
                this.voiceUsers.set(key, { guild, userId });
            }

            writeDb(guild.id, db);
        });

        // ── Periodic voice XP tick (every 60s) ───────────────────
        setInterval(async () => {
            // Group active voice users by guild
            const byGuild = new Map();
            for (const [key, info] of this.voiceUsers.entries()) {
                const { guild: guildRef, userId } = info;
                const guildId = typeof guildRef === 'object' ? guildRef.id : guildRef;
                if (!byGuild.has(guildId)) byGuild.set(guildId, []);
                byGuild.get(guildId).push({ key, userId });
            }

            for (const [guildId, users] of byGuild.entries()) {
                const guild = client.guilds.cache.get(guildId);
                if (!guild) {
                    users.forEach(u => this.voiceUsers.delete(u.key));
                    continue;
                }

                const settings = getSettings(guildId);
                const lvl      = settings.LEVEL_SYSTEM;
                if (!lvl?.ENABLE || !lvl.VOICE_ACTIVITY?.ENABLE) continue;

                const db    = readDb(guildId);
                let dirty   = false;

                for (const { key, userId } of users) {
                    const member = guild.members.cache.get(userId);
                    if (!member || !member.voice.channel) {
                        this.voiceUsers.delete(key);
                        continue;
                    }

                    const voiceCfg = lvl.VOICE_ACTIVITY;
                    if (voiceCfg.IGNORE_DEAFENED && (member.voice.deaf  || member.voice.selfDeaf))  continue;
                    if (voiceCfg.IGNORE_MUTED    && (member.voice.mute  || member.voice.selfMute))  continue;

                    const { leveledUp, newLevel } = handleVoiceTick(userId, db, settings);
                    dirty = true;

                    if (leveledUp) {
                        const earnedRole = await checkAndApplyRewards(client, guild, userId, db);
                        await sendLevelUpMessage(client, guild, userId, 'voice', newLevel, earnedRole);
                    }
                }

                if (dirty) writeDb(guildId, db);
            }
        }, 60_000);

        console.log('[Levels] System loaded — tracking text & voice activity');
    }
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */