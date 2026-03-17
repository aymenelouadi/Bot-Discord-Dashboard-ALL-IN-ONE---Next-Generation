/*
 * This project was programmed by the Code Nexus team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/UvEYbFd2rj
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../database/auto_responder.json');

// ── JSON helpers ─────────────────────────────────────────────

function readDb() {
    try {
        if (!fs.existsSync(DB_PATH)) return {};
        const raw = fs.readFileSync(DB_PATH, 'utf8').replace(/^\uFEFF/, '');
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

// ── Variable replacement ──────────────────────────────────────

function resolveVars(text, message) {
    const author       = message.author;
    const replyUser    = message.reference ? null : null; // populated below if available
    return text
        .replace(/\[user\]/g,        `<@${author.id}>`)
        .replace(/\[userName\]/g,    author.username)
        .replace(/\[displayName\]/g, message.member?.displayName || author.displayName || author.username)
        .replace(/\[replyUser\]/g,   message._arReplyMention || '')
        .replace(/\[replyUsername\]/g, message._arReplyUsername || '');
}

// ── Trigger match ─────────────────────────────────────────────

function matchesTrigger(content, trigger, triggerType) {
    const c = content.toLowerCase();
    const t = trigger.toLowerCase();
    switch (triggerType) {
        case 'equals':     return c === t;
        case 'startsWith': return c.startsWith(t);
        case 'endsWith':   return c.endsWith(t);
        case 'contains':
        default:           return c.includes(t);
    }
}

// ── Main module ───────────────────────────────────────────────

module.exports = {
    name: 'auto-responder',

    execute(client) {
        console.log('[system] Auto Responder system loaded');

        // Track bot reply → original message mapping for deleteOnAuthorDelete
        // Map<botMessageId, { originalMessageId, channelId, autoDeleteTimeout }>
        this._replyMap = new Map();

        client.on('messageCreate', async (message) => {
            await this.handleMessage(client, message);
        });

        client.on('messageDelete', async (message) => {
            await this.handleMessageDelete(client, message);
        });
    },

    async handleMessage(client, message) {
        // Ignore bots and system messages
        if (message.author?.bot || message.system) return;
        if (!message.guild) return;

        const db       = readDb();
        const guildCfg = db[message.guild.id];

        // Guild not configured or system disabled
        if (!guildCfg || !guildCfg.enabled) return;

        const responses = Array.isArray(guildCfg.responses) ? guildCfg.responses : [];
        const content   = message.content || '';
        if (!content.trim()) return;

        // Pre-fetch reply target once if needed
        let replyMember = null;
        if (message.reference?.messageId) {
            try {
                const refMsg = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
                if (refMsg) {
                    message._arReplyMention  = `<@${refMsg.author.id}>`;
                    message._arReplyUsername = refMsg.author.username;
                    replyMember = refMsg.member || null;
                }
            } catch { /* ignore */ }
        }

        for (const rule of responses) {
            if (rule.enabled === false) continue;
            if (!Array.isArray(rule.triggers) || rule.triggers.length === 0) continue;

            // Check triggers
            const matched = rule.triggers.some(t => t && matchesTrigger(content, t, rule.triggerType));
            if (!matched) continue;

            // ── Channel filters ──

            // If enabledChannels whitelist is set and this channel isn't in it → skip
            if (Array.isArray(rule.enabledChannels) && rule.enabledChannels.length > 0) {
                if (!rule.enabledChannels.includes(message.channel.id)) continue;
            }

            // If this channel is in ignoredChannels → skip
            if (Array.isArray(rule.ignoredChannels) && rule.ignoredChannels.includes(message.channel.id)) continue;

            // ── Role filters ──

            const memberRoles = message.member?.roles?.cache;

            // If allowedRoles whitelist is set and member has none of them → skip
            if (Array.isArray(rule.allowedRoles) && rule.allowedRoles.length > 0) {
                const hasAllowed = rule.allowedRoles.some(rId => memberRoles?.has(rId));
                if (!hasAllowed) continue;
            }

            // If member has any ignoredRole → skip
            if (Array.isArray(rule.ignoredRoles) && rule.ignoredRoles.length > 0) {
                const hasIgnored = rule.ignoredRoles.some(rId => memberRoles?.has(rId));
                if (hasIgnored) continue;
            }

            // ── Pick a random response message ──
            const msgs = (Array.isArray(rule.messages) ? rule.messages : []).filter(Boolean);
            if (!msgs.length) continue;
            const rawText = msgs[Math.floor(Math.random() * msgs.length)];
            const text    = resolveVars(rawText, message);

            // ── Delete user message ──
            if (rule.deleteUserMessage) {
                message.delete().catch(() => {});
            }

            // ── Send reply ──
            let botReply = null;
            try {
                switch (rule.sendType) {
                    case 'send':
                        botReply = await message.channel.send({ content: text });
                        break;

                    case 'reply_mention':
                        botReply = await message.reply({ content: text, allowedMentions: { repliedUser: true } });
                        break;

                    case 'dm':
                        try {
                            await message.author.send({ content: text });
                        } catch {
                            // DMs closed — silently ignore
                        }
                        break;

                    case 'reply':
                    default:
                        botReply = await message.reply({ content: text, allowedMentions: { repliedUser: false } });
                        break;
                }
            } catch (err) {
                console.error('[AutoResponder] Failed to send reply:', err.message);
                continue;
            }

            // ── Give role ──
            if (rule.giveRole && message.member) {
                message.member.roles.add(rule.giveRole).catch(() => {});
            }

            // ── Auto-delete bot reply after 5s ──
            if (botReply && rule.autoDeleteBotReply) {
                const timeout = setTimeout(() => {
                    botReply.delete().catch(() => {});
                    this._replyMap.delete(botReply.id);
                }, 5000);

                this._replyMap.set(botReply.id, {
                    originalMessageId: message.id,
                    channelId: message.channel.id,
                    autoDeleteTimeout: timeout,
                    deleteOnAuthorDelete: rule.deleteOnAuthorDelete,
                });
            } else if (botReply && rule.deleteOnAuthorDelete) {
                this._replyMap.set(botReply.id, {
                    originalMessageId: message.id,
                    channelId: message.channel.id,
                    autoDeleteTimeout: null,
                    deleteOnAuthorDelete: true,
                });
            }

            // Only fire the first matching rule per message
            break;
        }
    },

    async handleMessageDelete(client, message) {
        // Find any tracked bot replies whose original message was this one
        for (const [botMsgId, entry] of this._replyMap.entries()) {
            if (entry.originalMessageId !== message.id) continue;
            if (!entry.deleteOnAuthorDelete) {
                this._replyMap.delete(botMsgId);
                continue;
            }

            // Cancel the auto-delete timeout if still pending
            if (entry.autoDeleteTimeout) clearTimeout(entry.autoDeleteTimeout);

            try {
                const channel = client.channels.cache.get(entry.channelId);
                if (channel) {
                    const botMsg = await channel.messages.fetch(botMsgId).catch(() => null);
                    if (botMsg) botMsg.delete().catch(() => {});
                }
            } catch { /* ignore */ }

            this._replyMap.delete(botMsgId);
        }
    },
};
