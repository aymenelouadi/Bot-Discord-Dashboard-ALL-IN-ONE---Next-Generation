/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const {
    ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SectionBuilder, ThumbnailBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, SeparatorSpacingSize,
    MessageFlags, PermissionFlagsBits
} = require('discord.js');

const SETTINGS_PATH = path.join(__dirname, '../database/suggestions.json');
const DATA_PATH     = path.join(__dirname, '../database/suggestions_data.json');
const LEVELS_DB_DIR = path.join(__dirname, '../dashboard/database');

// ── JSON helpers ──────────────────────────────────────────────

function readJson(filePath) {
    try {
        if (!fs.existsSync(filePath)) return {};
        const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

function writeJson(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error('[Suggestions] writeJson error:', e.message);
    }
}

// ── Settings helpers ──────────────────────────────────────────

function getSettings(guildId) {
    const db = readJson(SETTINGS_PATH);
    return db[guildId] || null;
}

// ── Data (per-guild suggestion records + cooldowns) ───────────

function getData(guildId) {
    const db = readJson(DATA_PATH);
    if (!db[guildId]) {
        db[guildId] = { suggestions: {}, userCooldowns: {}, nextId: 1, _pendingRejects: {} };
    }
    return { db, guild: db[guildId] };
}

function saveData(db) {
    writeJson(DATA_PATH, db);
}

// ── Emoji utilities ───────────────────────────────────────────

function emojiKey(emoji) {
    if (!emoji) return '';
    if (emoji.id) {
        return `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;
    }
    return emoji.name;
}

// ── Levels helper ─────────────────────────────────────────────

function getUserLevel(guildId, userId) {
    try {
        const p = path.join(LEVELS_DB_DIR, guildId, 'levels.json');
        if (!fs.existsSync(p)) return 0;
        const data = readJson(p);
        const user = data[userId];
        if (!user) return 0;
        return Math.max(user.textLevel || 0, user.voiceLevel || 0);
    } catch {
        return 0;
    }
}

// ── Status labels ─────────────────────────────────────────────

function statusLabel(status, cfg) {
    const tags = cfg.statusTags || {};
    return {
        accepted:   `✅  ${tags.accepted   || 'Accepted'}`,
        rejected:   `❌  ${tags.rejected   || 'Rejected'}`,
        considered: `🔍  ${tags.considered || 'Under Review'}`,
        pending:    '⏳  Pending Approval'
    }[status] || '';
}

// ── Accent palette ────────────────────────────────────────────

const ACCENT = {
    active:     0x5865F2,
    pending:    0xF0B232,
    accepted:   0x23A55A,
    rejected:   0xED4245,
    considered: 0xFEE75C
};

// ── Components V2 helpers ─────────────────────────────────────

function txt(content) {
    return new TextDisplayBuilder().setContent(content);
}

function sep() {
    return new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
}

// ── Build main suggestion card (Components V2) ────────────────

function buildCard(suggestion, cfg) {
    const voting = cfg.voting || {};
    const color  = ACCENT[suggestion.status] || ACCENT.active;

    // Header text
    const header = [
        `## 💡  Suggestion #${suggestion.id}`,
        `-# 👤 Submitted by **${suggestion.memberTag || 'Unknown'}**`
    ].join('\n');

    // Stats text
    const label = statusLabel(suggestion.status, cfg);
    const lines = [];
    if (label) lines.push(label);

    if (voting.enabled) {
        if (voting.type === 'upvote_downvote') {
            const upE   = voting.upvoteEmoji   || '👍';
            const downE = voting.downvoteEmoji || '👎';
            lines.push(`${upE} **${suggestion.upvotes ?? 0}**  ·  ${downE} **${suggestion.downvotes ?? 0}**`);
        } else if (voting.type === 'multiple_reactions') {
            const rxLine = Object.entries(suggestion.reactions || {})
                .map(([em, voters]) => `${em} **${voters.length}**`)
                .join('  ·  ');
            if (rxLine) lines.push(rxLine);
        }
    }

    lines.push(`-# 🆔  #${suggestion.id}`);

    // Container
    const container = new ContainerBuilder().setAccentColor(color);

    if (suggestion.avatarUrl) {
        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(txt(header))
                .setThumbnailAccessory(new ThumbnailBuilder().setURL(suggestion.avatarUrl))
        );
    } else {
        container.addTextDisplayComponents(txt(header));
    }

    container
        .addSeparatorComponents(sep())
        .addTextDisplayComponents(txt('> ' + suggestion.content.replace(/\n/g, '\n> ')))
        .addSeparatorComponents(sep())
        .addTextDisplayComponents(txt(lines.join('\n')));

    // Vote buttons (only for 'buttons' type while active)
    if (voting.enabled && voting.type === 'buttons' && suggestion.status === 'active') {
        container.addActionRowComponents(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`sg_vote_up_${suggestion.id}`)
                    .setLabel(`👍  ${suggestion.upvotes ?? 0}`)
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`sg_vote_down_${suggestion.id}`)
                    .setLabel(`👎  ${suggestion.downvotes ?? 0}`)
                    .setStyle(ButtonStyle.Danger)
            )
        );
    }

    return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

// ── Build pending review card ─────────────────────────────────

function buildPendingCard(suggestion) {
    const header = [
        `## ⏳  Pending Review`,
        `**Suggestion #${suggestion.id}**`,
        `-# 👤 From **${suggestion.memberTag || 'Unknown'}**`
    ].join('\n');

    const container = new ContainerBuilder().setAccentColor(ACCENT.pending);

    if (suggestion.avatarUrl) {
        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(txt(header))
                .setThumbnailAccessory(new ThumbnailBuilder().setURL(suggestion.avatarUrl))
        );
    } else {
        container.addTextDisplayComponents(txt(header));
    }

    container
        .addSeparatorComponents(sep())
        .addTextDisplayComponents(txt('> ' + suggestion.content.replace(/\n/g, '\n> ')))
        .addSeparatorComponents(sep())
        .addActionRowComponents(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`sg_approve_${suggestion.id}`)
                    .setLabel('✅  Approve')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`sg_reject_${suggestion.id}`)
                    .setLabel('❌  Reject')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`sg_consider_${suggestion.id}`)
                    .setLabel('🔍  Under Review')
                    .setStyle(ButtonStyle.Secondary)
            )
        );

    return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

// ── Build outcome card (replaces pending card after decision) ─

function buildOutcomeCard(suggestion, moderatorTag, reason) {
    const emoji = { accepted: '✅', rejected: '❌', considered: '🔍' }[suggestion.status] || '📋';
    const label = { accepted: 'Accepted', rejected: 'Rejected', considered: 'Under Review' }[suggestion.status] || suggestion.status;

    const lines = [
        `## ${emoji}  Suggestion #${suggestion.id} — ${label}`,
        `-# Reviewed by **${moderatorTag}**`
    ];
    if (reason) lines.push(`-# *${reason}*`);

    const container = new ContainerBuilder()
        .setAccentColor(ACCENT[suggestion.status] || 0x99AAB5)
        .addTextDisplayComponents(txt(lines.join('\n')));

    return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

// ── Add reactions (for non-button voting types) ───────────────

async function attachVoting(message, cfg) {
    const voting = cfg.voting || {};
    if (!voting.enabled || voting.type === 'buttons') return;

    if (voting.type === 'upvote_downvote') {
        try { await message.react(voting.upvoteEmoji   || '👍'); } catch {}
        try { await message.react(voting.downvoteEmoji || '👎'); } catch {}
    } else if (voting.type === 'multiple_reactions') {
        for (const em of (voting.multipleReactions || [])) {
            try { await message.react(em); } catch {}
        }
    }
}

// ── Post to pending channel ───────────────────────────────────

async function postPending(guild, suggestion, cfg) {
    const ch = guild.channels.cache.get(cfg.moderation?.pendingChannel);
    if (!ch) return null;
    try {
        return await ch.send(buildPendingCard(suggestion));
    } catch (e) {
        console.error('[Suggestions] postPending error:', e.message);
        return null;
    }
}

// ── Post to main suggestions channel ─────────────────────────

async function postActive(guild, suggestion, cfg) {
    const ch = guild.channels.cache.get(cfg.channel);
    if (!ch) return null;
    try {
        const msg = await ch.send(buildCard(suggestion, cfg));
        await attachVoting(msg, cfg);
        if (cfg.allowThreads) {
            try {
                await msg.startThread({
                    name: `Suggestion #${suggestion.id} — Discussion`,
                    autoArchiveDuration: 1440
                });
            } catch {}
        }
        return msg;
    } catch (e) {
        console.error('[Suggestions] postActive error:', e.message);
        return null;
    }
}

// ── Refresh main card in-place ────────────────────────────────

async function refreshCard(message, suggestion, cfg) {
    try {
        await message.edit(buildCard(suggestion, cfg));
    } catch (e) {
        console.error('[Suggestions] refreshCard error:', e.message);
    }
}

// ── Auto-threshold check ─────────────────────────────────────

async function checkAutoThreshold(message, suggestion, cfg, db) {
    const at = cfg.autoThreshold;
    if (!at?.enabled || suggestion.status !== 'active') return;

    let newStatus = null;
    if (at.minUpvotes   > 0 && suggestion.upvotes   >= at.minUpvotes)   newStatus = 'accepted';
    if (at.minDownvotes > 0 && suggestion.downvotes >= at.minDownvotes) newStatus = 'rejected';
    if (!newStatus) return;

    suggestion.status        = newStatus;
    suggestion.autoModerated = true;
    writeJson(DATA_PATH, db);
    await refreshCard(message, suggestion, cfg);
}

// ── DM helper ────────────────────────────────────────────────

async function tryDm(user, text) {
    try {
        const dm = await user.createDM();
        await dm.send(text);
    } catch {}
}

// ─────────────────────────────────────────────────────────────
// Module export
// ─────────────────────────────────────────────────────────────

module.exports = {
    name: 'suggestions',

    execute(client) {
        this.client = client;
        console.log('[system] Suggestions system loaded');

        // ── messageCreate — capture suggestions ─────────────
        client.on('messageCreate', async (message) => {
            if (message.author.bot || !message.guild) return;

            const cfg = getSettings(message.guild.id);
            if (!cfg || !cfg.enabled || !cfg.channel) return;
            if (message.channel.id !== cfg.channel) return;

            // Delete original so channel only shows formatted cards
            try { await message.delete(); } catch {}

            const content = message.content.trim();
            if (!content) return;

            const member = message.member
                || await message.guild.members.fetch(message.author.id).catch(() => null);
            if (!member) return;

            // ── Permission checks ────────────────────────────
            const perms = cfg.permissions || {};
            if (!perms.allowAll) {
                const hasRole = (perms.allowedRoles || []).some(rid => member.roles.cache.has(rid));
                if (!hasRole) {
                    await tryDm(message.author, `❌ You don't have the required role to submit suggestions in **${message.guild.name}**.`);
                    return;
                }
            }

            if (perms.minAccountAge > 0) {
                const ageDays = (Date.now() - message.author.createdTimestamp) / 86_400_000;
                if (ageDays < perms.minAccountAge) {
                    await tryDm(message.author, `❌ Your account must be at least **${perms.minAccountAge} day(s)** old to submit suggestions here.`);
                    return;
                }
            }

            if (perms.minServerLevel > 0) {
                const level = getUserLevel(message.guild.id, message.author.id);
                if (level < perms.minServerLevel) {
                    await tryDm(message.author, `❌ You need to reach at least **level ${perms.minServerLevel}** in **${message.guild.name}** before submitting suggestions.`);
                    return;
                }
            }

            // ── Spam checks ──────────────────────────────────
            const spam = cfg.spam || {};
            const { db, guild: gData } = getData(message.guild.id);
            if (!gData.userCooldowns)   gData.userCooldowns   = {};
            if (!gData._pendingRejects) gData._pendingRejects = {};

            const userId = message.author.id;
            const now    = Date.now();
            const today  = new Date().toISOString().slice(0, 10);
            const cd     = gData.userCooldowns[userId] || { lastSuggestion: 0, todayCount: 0, todayDate: '' };

            if (spam.cooldown > 0) {
                const minutesPassed = (now - cd.lastSuggestion) / 60_000;
                if (minutesPassed < spam.cooldown) {
                    const remaining = Math.ceil(spam.cooldown - minutesPassed);
                    await tryDm(message.author, `⏳ Please wait **${remaining} minute(s)** before submitting another suggestion.`);
                    return;
                }
            }

            if (spam.maxPerDay > 0 && cd.todayDate === today && cd.todayCount >= spam.maxPerDay) {
                await tryDm(message.author, `❌ You've reached the daily limit of **${spam.maxPerDay} suggestion(s)** in **${message.guild.name}**.`);
                return;
            }

            // ── Create suggestion record ─────────────────────
            if (!gData.suggestions) gData.suggestions = {};
            const id = gData.nextId || 1;
            gData.nextId = id + 1;

            const suggestion = {
                id,
                messageId:        null,
                pendingMessageId: null,
                submitterId:      userId,
                memberTag:        message.author.tag || message.author.username,
                avatarUrl:        message.author.displayAvatarURL({ size: 128 }),
                content:          content.slice(0, 2000),
                status:           cfg.moderation?.requireApproval ? 'pending' : 'active',
                upvotes:          0,
                downvotes:        0,
                voters:           {},
                reactions:        {},
                createdAt:        now,
                threadId:         null
            };

            gData.suggestions[id] = suggestion;
            gData.userCooldowns[userId] = {
                lastSuggestion: now,
                todayCount:     cd.todayDate === today ? cd.todayCount + 1 : 1,
                todayDate:      today
            };
            saveData(db);

            // ── Route: pending review or post directly ───────
            if (cfg.moderation?.requireApproval) {
                const pendingMsg = await postPending(message.guild, suggestion, cfg);
                if (pendingMsg) {
                    gData.suggestions[id].pendingMessageId = pendingMsg.id;
                    saveData(db);
                }
                await tryDm(message.author, `✅ Your suggestion has been submitted to **${message.guild.name}** and is pending admin review!`);
            } else {
                const posted = await postActive(message.guild, suggestion, cfg);
                if (posted) {
                    gData.suggestions[id].messageId = posted.id;
                    if (posted.thread) gData.suggestions[id].threadId = posted.thread.id;
                    saveData(db);
                }
                await tryDm(message.author, `✅ Your suggestion **#${id}** has been posted in **${message.guild.name}**!`);
            }
        });

        // ── messageReactionAdd — reaction voting ─────────────
        client.on('messageReactionAdd', async (reaction, user) => {
            if (user.bot) return;
            try {
                if (reaction.partial) await reaction.fetch();
                if (reaction.message.partial) await reaction.message.fetch();
            } catch { return; }
            if (!reaction.message.guild) return;

            const guildId = reaction.message.guild.id;
            const cfg     = getSettings(guildId);
            if (!cfg || !cfg.enabled || !cfg.voting?.enabled) return;
            if (cfg.voting.type === 'buttons') return;

            const { db, guild: gData } = getData(guildId);
            const suggestion = this._findByMessageId(gData, reaction.message.id);
            if (!suggestion || suggestion.status !== 'active') return;

            const key = emojiKey(reaction.emoji);

            if (cfg.voting.type === 'upvote_downvote') {
                const upKey   = cfg.voting.upvoteEmoji   || '👍';
                const downKey = cfg.voting.downvoteEmoji || '👎';
                if (key !== upKey && key !== downKey) return;

                const prev = suggestion.voters[user.id];
                if (key === upKey) {
                    if (prev === 'up') return;
                    if (prev === 'down') {
                        suggestion.downvotes = Math.max(0, suggestion.downvotes - 1);
                        try {
                            const r = reaction.message.reactions.cache.find(rx => emojiKey(rx.emoji) === downKey);
                            await r?.users.remove(user.id);
                        } catch {}
                    }
                    suggestion.voters[user.id] = 'up';
                    suggestion.upvotes++;
                } else {
                    if (prev === 'down') return;
                    if (prev === 'up') {
                        suggestion.upvotes = Math.max(0, suggestion.upvotes - 1);
                        try {
                            const r = reaction.message.reactions.cache.find(rx => emojiKey(rx.emoji) === upKey);
                            await r?.users.remove(user.id);
                        } catch {}
                    }
                    suggestion.voters[user.id] = 'down';
                    suggestion.downvotes++;
                }

            } else if (cfg.voting.type === 'multiple_reactions') {
                if (!(cfg.voting.multipleReactions || []).includes(key)) return;
                if (!suggestion.reactions[key]) suggestion.reactions[key] = [];
                if (!suggestion.reactions[key].includes(user.id)) suggestion.reactions[key].push(user.id);
            }

            saveData(db);
            await refreshCard(reaction.message, suggestion, cfg);
            await checkAutoThreshold(reaction.message, suggestion, cfg, db);
        });

        // ── messageReactionRemove — reaction voting ──────────
        client.on('messageReactionRemove', async (reaction, user) => {
            if (user.bot) return;
            try {
                if (reaction.partial) await reaction.fetch();
                if (reaction.message.partial) await reaction.message.fetch();
            } catch { return; }
            if (!reaction.message.guild) return;

            const guildId = reaction.message.guild.id;
            const cfg     = getSettings(guildId);
            if (!cfg || !cfg.enabled || !cfg.voting?.enabled) return;
            if (cfg.voting.type === 'buttons') return;

            const { db, guild: gData } = getData(guildId);
            const suggestion = this._findByMessageId(gData, reaction.message.id);
            if (!suggestion || suggestion.status !== 'active') return;

            const key     = emojiKey(reaction.emoji);
            const upKey   = cfg.voting.upvoteEmoji   || '👍';
            const downKey = cfg.voting.downvoteEmoji || '👎';

            if (cfg.voting.type === 'upvote_downvote') {
                if (key === upKey && suggestion.voters[user.id] === 'up') {
                    suggestion.upvotes = Math.max(0, suggestion.upvotes - 1);
                    delete suggestion.voters[user.id];
                } else if (key === downKey && suggestion.voters[user.id] === 'down') {
                    suggestion.downvotes = Math.max(0, suggestion.downvotes - 1);
                    delete suggestion.voters[user.id];
                } else return;

            } else if (cfg.voting.type === 'multiple_reactions') {
                if (!suggestion.reactions[key]) return;
                suggestion.reactions[key] = suggestion.reactions[key].filter(uid => uid !== user.id);
            }

            saveData(db);
            await refreshCard(reaction.message, suggestion, cfg);
        });

        // ── interactionCreate — buttons ──────────────────────
        client.on('interactionCreate', async (interaction) => {
            if (!interaction.isButton() || !interaction.guild) return;
            const cid = interaction.customId;

            if (cid.startsWith('sg_vote_up_') || cid.startsWith('sg_vote_down_')) {
                await this._handleVoteButton(interaction);
            } else if (cid.startsWith('sg_approve_') || cid.startsWith('sg_reject_') || cid.startsWith('sg_consider_')) {
                await this._handleModerationButton(interaction);
            }
        });
    },

    // ── Internal: find suggestion by posted messageId ─────────
    _findByMessageId(gData, messageId) {
        return Object.values(gData.suggestions || {}).find(s => s.messageId === messageId) || null;
    },

    // ── Internal: vote button handler ────────────────────────
    async _handleVoteButton(interaction) {
        const guildId = interaction.guild.id;
        const cfg     = getSettings(guildId);
        if (!cfg || !cfg.enabled) return;

        // Parse suggId from customId: sg_vote_up_<id> or sg_vote_down_<id>
        const parts  = interaction.customId.split('_');
        const suggId = parseInt(parts[parts.length - 1]);
        if (isNaN(suggId)) return;

        const { db, guild: gData } = getData(guildId);
        const suggestion = gData.suggestions?.[suggId];
        if (!suggestion || suggestion.status !== 'active') {
            return interaction.reply({ content: '❌ This suggestion is no longer active.', ephemeral: true });
        }

        const isUp   = interaction.customId.startsWith('sg_vote_up_');
        const userId = interaction.user.id;
        const prev   = suggestion.voters[userId];

        if (isUp) {
            if (prev === 'up') {
                suggestion.upvotes = Math.max(0, suggestion.upvotes - 1);
                delete suggestion.voters[userId];
                await interaction.reply({ content: '↩️ Removed your upvote.', ephemeral: true });
            } else {
                if (prev === 'down') suggestion.downvotes = Math.max(0, suggestion.downvotes - 1);
                suggestion.upvotes++;
                suggestion.voters[userId] = 'up';
                await interaction.reply({ content: '👍 Upvote registered!', ephemeral: true });
            }
        } else {
            if (prev === 'down') {
                suggestion.downvotes = Math.max(0, suggestion.downvotes - 1);
                delete suggestion.voters[userId];
                await interaction.reply({ content: '↩️ Removed your downvote.', ephemeral: true });
            } else {
                if (prev === 'up') suggestion.upvotes = Math.max(0, suggestion.upvotes - 1);
                suggestion.downvotes++;
                suggestion.voters[userId] = 'down';
                await interaction.reply({ content: '👎 Downvote registered!', ephemeral: true });
            }
        }

        saveData(db);
        try {
            await refreshCard(interaction.message, suggestion, cfg);
            await checkAutoThreshold(interaction.message, suggestion, cfg, db);
        } catch {}
    },

    // ── Internal: moderation button handler ──────────────────
    async _handleModerationButton(interaction) {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ content: '❌ You need **Manage Server** permission to moderate suggestions.', ephemeral: true });
        }

        const guildId = interaction.guild.id;
        const cfg     = getSettings(guildId);
        if (!cfg) return;

        // customId format: sg_<action>_<id>
        const parts  = interaction.customId.split('_');
        const action = parts[1];                       // approve | reject | consider
        const suggId = parseInt(parts[parts.length - 1]);
        if (isNaN(suggId)) return;

        const { db, guild: gData } = getData(guildId);
        const suggestion = gData.suggestions?.[suggId];
        if (!suggestion) {
            return interaction.reply({ content: '❌ Suggestion not found.', ephemeral: true });
        }

        if (action === 'reject') {
            await interaction.reply({ content: '📝 Please type your **rejection reason** in the next message (60 seconds)...', ephemeral: true });
            const filter    = m => m.author.id === interaction.user.id;
            const collected = await interaction.channel.awaitMessages({ filter, max: 1, time: 60_000, errors: [] });
            const reason    = collected.first()?.content?.trim() || '';
            try { await collected.first()?.delete(); } catch {}
            await this._applyMod(interaction, suggestion, cfg, db, gData, 'rejected', reason);
        } else {
            await interaction.deferUpdate();
            const newStatus = action === 'approve' ? 'accepted' : 'considered';
            await this._applyMod(interaction, suggestion, cfg, db, gData, newStatus, '');
        }
    },

    // ── Internal: apply moderation decision ──────────────────
    async _applyMod(interaction, suggestion, cfg, db, gData, newStatus, reason) {
        suggestion.status      = newStatus;
        suggestion.moderator   = interaction.user.tag || interaction.user.username;
        suggestion.rejectReason = reason || null;
        writeJson(DATA_PATH, db);

        const modTag = interaction.user.tag || interaction.user.username;

        // Replace pending card with outcome card
        try {
            await interaction.message.edit(buildOutcomeCard(suggestion, modTag, reason));
        } catch {}

        // If approved/considered → post to main suggestions channel
        if (newStatus === 'accepted' || newStatus === 'considered') {
            const posted = await postActive(interaction.guild, suggestion, cfg);
            if (posted) {
                suggestion.messageId = posted.id;
                if (posted.thread) suggestion.threadId = posted.thread.id;
                writeJson(DATA_PATH, db);
            }
        }

        // If rejected and a main card already existed → refresh it too
        if (newStatus === 'rejected' && suggestion.messageId) {
            try {
                const ch  = interaction.guild.channels.cache.get(cfg.channel);
                const msg = ch ? await ch.messages.fetch(suggestion.messageId).catch(() => null) : null;
                if (msg) await refreshCard(msg, suggestion, cfg);
            } catch {}
        }

        // DM the submitter
        try {
            const submitter = await interaction.client.users.fetch(suggestion.submitterId);
            if (submitter) {
                const dmText = {
                    accepted:   `✅ Your suggestion **#${suggestion.id}** in **${interaction.guild.name}** has been **accepted**!`,
                    rejected:   `❌ Your suggestion **#${suggestion.id}** in **${interaction.guild.name}** was **rejected**${reason ? `\n> *${reason}*` : '.'}`,
                    considered: `🔍 Your suggestion **#${suggestion.id}** in **${interaction.guild.name}** is now **under review**.`
                }[newStatus];
                if (dmText) await tryDm(submitter, dmText);
            }
        } catch {}
    }
};
