'use strict';

/**
 * component_triggers — Event-based & scheduled trigger dispatcher for ComponentMessage.
 *
 * Handles every non-interaction trigger type that can fire a ComponentMessage automation:
 *
 *   on_join        → guildMemberAdd
 *   member_leave   → guildMemberRemove
 *   role_add       → guildMemberUpdate (role gained)
 *   role_remove    → guildMemberUpdate (role lost)
 *   on_message     → messageCreate (optional regex pattern match)
 *   on_reaction    → messageReactionAdd (optional emoji filter)
 *   slash_command  → interactionCreate ChatInput (auto-registers on ready)
 *   scheduled      → 60-second cron tick with 5-field cron expression
 *
 * _sendDoc() — shared helper that:
 *   • Builds the payload from the initial state (or legacy flat fields)
 *   • Sends a preMentions ping message before the main payload
 *   • Loops over all configured channelIds and logs to sentLog
 */

const logger = require('../utils/logger');

// ═══════════════════════════════════════════════════════════════════════════
// CRON HELPER  —  minimal 5-field parser (min hour dom mon dow)
// ═══════════════════════════════════════════════════════════════════════════

function _cronField(spec, val) {
    if (spec === '*') return true;
    if (spec.startsWith('*/')) return val % parseInt(spec.slice(2), 10) === 0;
    if (spec.includes(',')) return spec.split(',').map(Number).includes(val);
    if (spec.includes('-')) {
        const [a, b] = spec.split('-').map(Number);
        return val >= a && val <= b;
    }
    return parseInt(spec, 10) === val;
}

function _cronMatches(expr, date) {
    const parts = (expr || '').trim().split(/\s+/);
    if (parts.length < 5) return false;
    return (
        _cronField(parts[0], date.getMinutes())      &&
        _cronField(parts[1], date.getUTCHours())     &&
        _cronField(parts[2], date.getUTCDate())      &&
        _cronField(parts[3], date.getUTCMonth() + 1) &&
        _cronField(parts[4], date.getUTCDay())
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED SEND HELPER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {import('discord.js').Client} client
 * @param {object}  doc              - lean ComponentMessage document
 * @param {string|null} [overrideChannelId]  - optional override (e.g. from messageCreate / on_reaction)
 */
async function _sendDoc(client, doc, overrideChannelId = null) {
    const { buildComponentPayload } = require('../dashboard/utils/componentBuilder');

    // Resolve initial state
    const initState = (doc.states?.find(s => s.id === doc.initialStateId) || doc.states?.[0])
        || { content: doc.content, components: doc.components };

    const payload = buildComponentPayload({
        content:    initState.content    ?? doc.content    ?? '',
        components: initState.components ?? doc.components ?? [],
    });

    if (!payload.components?.length && !payload.content) {
        logger.warn('component_triggers._sendDoc: payload is empty, skipping', { name: doc.name, guildId: doc.guildId });
        return;
    }

    // Determine target channel list
    const targetIds = overrideChannelId
        ? [overrideChannelId]
        : (doc.channelIds?.length ? doc.channelIds : (doc.channelId ? [doc.channelId] : []));

    if (!targetIds.length) {
        logger.warn('component_triggers._sendDoc: no channel configured', { name: doc.name, guildId: doc.guildId });
        return;
    }

    // Build preMentions ping text
    const mentions = Array.isArray(doc.preMentions) ? doc.preMentions : [];
    const pingText = mentions.map(m => {
        if (!m) return '';
        if (typeof m === 'string') return m;
        if (m.type === 'special') return `@${m.id}`;
        if (m.type === 'role')    return `<@&${m.id}>`;
        return '';
    }).filter(Boolean).join(' ');

    const ComponentMessage = require('./schemas/ComponentMessage');

    for (const cid of targetIds) {
        try {
            const channel = client.channels.cache.get(cid)
                ?? await client.channels.fetch(cid).catch(() => null);

            if (!channel?.isTextBased?.()) continue;

            // Ping message first
            if (pingText) {
                await channel.send({
                    content: pingText,
                    allowedMentions: { parse: ['roles', 'everyone', 'here'] },
                }).catch(() => null);
            }

            const sent = await channel.send(payload);

            await ComponentMessage.findByIdAndUpdate(doc._id, {
                $push: { sentLog: { channelId: channel.id, messageId: sent.id, sentAt: new Date() } },
            }).catch(() => null);

            logger.discord?.(`component_triggers: sent "${doc.name}" → #${channel.name}`, {
                guildId: doc.guildId, docId: String(doc._id),
            });
        } catch (err) {
            logger.error('component_triggers._sendDoc: send error', {
                error: err.message, guildId: doc.guildId, channelId: cid,
            });
        }
    }
}

// Fetch all ComponentMessage docs for a guild matching a trigger type
async function _docsForTrigger(guildId, triggerType) {
    const ComponentMessage = require('./schemas/ComponentMessage');
    return ComponentMessage.find({ guildId, 'triggers.type': triggerType }).lean().catch(e => {
        logger.error('component_triggers._docsForTrigger', { error: e.message, guildId, triggerType });
        return [];
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// SLASH COMMAND SYNC  —  runs once on ready + 8s delay
// ═══════════════════════════════════════════════════════════════════════════

async function _syncSlashCommands(client) {
    try {
        const ComponentMessage = require('./schemas/ComponentMessage');
        const docs = await ComponentMessage.find({ 'triggers.type': 'slash_command' }).lean().catch(() => []);

        // Group valid command names by guild
        const byGuild = {};
        for (const doc of docs) {
            const trigger = doc.triggers.find(t => t.type === 'slash_command' && t.params?.name);
            if (!trigger) continue;
            const name = (trigger.params.name || '').replace(/^\//, '').trim().toLowerCase();
            if (!name || !/^[\w-]{1,32}$/.test(name)) continue;
            if (!byGuild[doc.guildId]) byGuild[doc.guildId] = new Set();
            byGuild[doc.guildId].add(name);
        }

        for (const [guildId, names] of Object.entries(byGuild)) {
            const guild = client.guilds.cache.get(guildId);
            if (!guild) continue;
            const commands = [...names].map(name => ({
                name,
                description: `Component automation: ${name}`,
            }));
            await guild.commands.set(commands).catch(e => {
                logger.warn(`component_triggers: slash sync failed for ${guildId}`, { error: e.message });
            });
            logger.discord?.(`component_triggers: registered ${commands.length} slash command(s) → guild ${guildId}`);
        }
    } catch (err) {
        logger.error('component_triggers._syncSlashCommands failed', { error: err.message });
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN MODULE
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
    name: 'component_triggers',

    execute(client) {

        // ── on_join → guildMemberAdd ─────────────────────────────────────
        client.on('guildMemberAdd', async (member) => {
            if (!member.guild?.id) return;
            const docs = await _docsForTrigger(member.guild.id, 'on_join');
            for (const doc of docs) await _sendDoc(client, doc).catch(() => null);
        });

        // ── member_leave → guildMemberRemove ────────────────────────────
        client.on('guildMemberRemove', async (member) => {
            if (!member.guild?.id) return;
            const docs = await _docsForTrigger(member.guild.id, 'member_leave');
            for (const doc of docs) await _sendDoc(client, doc).catch(() => null);
        });

        // ── role_add / role_remove → guildMemberUpdate ──────────────────
        client.on('guildMemberUpdate', async (oldMember, newMember) => {
            if (!newMember.guild?.id) return;
            const oldRoles = oldMember.roles?.cache;
            const newRoles = newMember.roles?.cache;
            if (!oldRoles || !newRoles) return;

            const gained  = newRoles.filter((_, id) => !oldRoles.has(id));
            const lost    = oldRoles.filter((_, id) => !newRoles.has(id));

            for (const [roleId] of gained) {
                const docs = await _docsForTrigger(newMember.guild.id, 'role_add');
                for (const doc of docs) {
                    const trig = doc.triggers.find(t =>
                        t.type === 'role_add' && (!t.params?.roleId || t.params.roleId === roleId)
                    );
                    if (trig) await _sendDoc(client, doc).catch(() => null);
                }
            }

            for (const [roleId] of lost) {
                const docs = await _docsForTrigger(newMember.guild.id, 'role_remove');
                for (const doc of docs) {
                    const trig = doc.triggers.find(t =>
                        t.type === 'role_remove' && (!t.params?.roleId || t.params.roleId === roleId)
                    );
                    if (trig) await _sendDoc(client, doc).catch(() => null);
                }
            }
        });

        // ── on_message → messageCreate ───────────────────────────────────
        client.on('messageCreate', async (message) => {
            if (message.author?.bot || !message.guildId || !message.content) return;
            const docs = await _docsForTrigger(message.guildId, 'on_message');
            for (const doc of docs) {
                const trig = doc.triggers.find(t => {
                    if (t.type !== 'on_message') return false;
                    const pattern = t.params?.pattern;
                    if (!pattern) return true; // no pattern → match every message
                    try { return new RegExp(pattern, 'i').test(message.content); }
                    catch { return false; }
                });
                if (trig) await _sendDoc(client, doc, message.channelId).catch(() => null);
            }
        });

        // ── on_reaction → messageReactionAdd ────────────────────────────
        client.on('messageReactionAdd', async (reaction, user) => {
            if (user.bot || !reaction.message.guildId) return;
            if (reaction.partial) await reaction.fetch().catch(() => null);
            const emoji  = reaction.emoji.name || reaction.emoji.toString();
            const guildId = reaction.message.guildId;
            const docs   = await _docsForTrigger(guildId, 'on_reaction');
            for (const doc of docs) {
                const trig = doc.triggers.find(t => {
                    if (t.type !== 'on_reaction') return false;
                    const req = t.params?.emoji;
                    return !req || req === emoji;
                });
                if (trig) await _sendDoc(client, doc, reaction.message.channelId).catch(() => null);
            }
        });

        // ── slash_command → interactionCreate (ChatInput) ───────────────
        client.on('interactionCreate', async (interaction) => {
            if (!interaction.isChatInputCommand() || !interaction.guildId) return;
            const cmdName = interaction.commandName.toLowerCase();
            const docs = await _docsForTrigger(interaction.guildId, 'slash_command');
            for (const doc of docs) {
                const trig = doc.triggers.find(t => {
                    if (t.type !== 'slash_command') return false;
                    return (t.params?.name || '').replace(/^\//, '').trim().toLowerCase() === cmdName;
                });
                if (!trig) continue;

                try {
                    await interaction.deferReply({ ephemeral: false }).catch(() => null);
                    const { buildComponentPayload } = require('../dashboard/utils/componentBuilder');
                    const st = (doc.states?.find(s => s.id === doc.initialStateId) || doc.states?.[0])
                        || { content: doc.content, components: doc.components };
                    const payload = buildComponentPayload({ content: st.content, components: st.components });
                    if (payload.components?.length || payload.content) {
                        await interaction.editReply(payload).catch(e =>
                            logger.warn('component_triggers: slash reply failed', { error: e.message })
                        );
                    }
                } catch (err) {
                    logger.error('component_triggers: slash dispatch error', { error: err.message });
                }
                break; // one match per interaction
            }
        });

        // ── scheduled → 60-second cron tick ────────────────────────────
        let _lastCronMin = -1;
        setInterval(async () => {
            const now    = new Date();
            const minute = now.getMinutes();
            if (minute === _lastCronMin) return;
            _lastCronMin = minute;

            try {
                const ComponentMessage = require('./schemas/ComponentMessage');
                const docs = await ComponentMessage.find({ 'triggers.type': 'scheduled' }).lean().catch(() => []);
                for (const doc of docs) {
                    const trig = doc.triggers.find(t => t.type === 'scheduled' && t.params?.cron);
                    if (trig && _cronMatches(trig.params.cron, now)) {
                        await _sendDoc(client, doc).catch(() => null);
                    }
                }
            } catch (err) {
                logger.error('component_triggers: cron tick error', { error: err.message });
            }
        }, 60_000);

        // ── Sync slash commands once after bot is ready ─────────────────
        client.once('ready', () => {
            setTimeout(() => _syncSlashCommands(client), 8_000);
        });
    },
};
