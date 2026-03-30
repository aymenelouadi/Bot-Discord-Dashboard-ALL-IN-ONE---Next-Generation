'use strict';

/*
 * Next Generation — Welcome Join System
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles the guildMemberAdd event and sends configured welcome messages.
 *
 * Responsibilities:
 *   • Read the guild's WelcomeJoin config from MongoDB.
 *   • Respect all per-guild flags: enabled, ignoreBots, ignoreUsers, waitRules.
 *   • Send a DM welcome message if dmWelcome is enabled.
 *   • Send every configured template to its target channel.
 *   • Replace [variables] with real member / guild data.
 *   • Apply per-template sendDelay (wait before send).
 *   • Apply per-template deleteDelay (auto-delete the sent message after N sec).
 *   • Handle members who pass membership screening via guildMemberUpdate.
 *   • Send a Dynamic Image (if an image config is enabled) via embed, Component v2,
 *     or standalone attachment — requires the optional `canvas` package.
 */

const {
    EmbedBuilder,
    ContainerBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    TextDisplayBuilder,
    MessageFlags,
    AttachmentBuilder,
} = require('discord.js');
const db     = require('./schemas');
const logger = require('../utils/logger');

// ── Variable resolver ─────────────────────────────────────────────────────────

/**
 * Replace all [variable] placeholders in `text` with real values.
 * @param {string} text
 * @param {import('discord.js').GuildMember} member
 * @param {import('discord.js').Guild} guild
 * @returns {string}
 */
function resolveVars(text, member, guild) {
    if (!text) return '';
    const user       = member.user;
    const createdAt  = user.createdAt;
    const daysSince  = Math.floor((Date.now() - createdAt.getTime()) / 86_400_000);

    return text
        .replace(/\[user\]/g,            `<@${user.id}>`)
        .replace(/\[userName\]/g,        user.username)
        .replace(/\[userCreatedDate\]/g, createdAt.toLocaleDateString('en-GB'))
        .replace(/\[userCreatedDays\]/g, String(daysSince))
        .replace(/\[serverName\]/g,      guild.name)
        .replace(/\[memberCount\]/g,     String(guild.memberCount))
        // Invite variables — resolved at call-site when tracked; leave as-is otherwise
        .replace(/\[inviter\]/g,         user.toString())
        .replace(/\[inviterName\]/g,     user.username)
        .replace(/\[invitesCount\]/g,    '0')
        .replace(/\[inviteCode\]/g,      'N/A');
}

// ── Build a Discord message payload from a template ───────────────────────────

/**
 * @param {'text'|'embed'|'component'} type
 * @param {object} tpl  template doc
 * @param {import('discord.js').GuildMember} member
 * @param {import('discord.js').Guild} guild
 * @returns {{ content?: string, embeds?: import('discord.js').EmbedBuilder[], components?: object[] }|null}
 */
function buildPayload(tpl, member, guild) {
    const { type, content, embed, componentJson } = tpl;

    if (type === 'embed') {
        const e = new EmbedBuilder();
        if (embed?.title)       e.setTitle(resolveVars(embed.title, member, guild).slice(0, 256));
        if (embed?.description) e.setDescription(resolveVars(embed.description, member, guild).slice(0, 4096));
        if (embed?.footer)      e.setFooter({ text: resolveVars(embed.footer, member, guild).slice(0, 2048) });
        if (embed?.thumbnail && /^https?:\/\//i.test(embed.thumbnail)) e.setThumbnail(embed.thumbnail);
        if (embed?.color) {
            try { e.setColor(embed.color); } catch { /* invalid hex — skip */ }
        }
        // Add member avatar as author icon
        const avatarURL = member.user.displayAvatarURL({ size: 64 });
        e.setAuthor({ name: member.user.username, iconURL: avatarURL });
        return { embeds: [e] };
    }

    if (type === 'component') {
        try {
            const { buildComponentPayload } = require('../dashboard/utils/componentBuilder');
            const parsed = JSON.parse(componentJson || '{}');
            const rows = Array.isArray(parsed.components) ? parsed.components : (Array.isArray(parsed) ? parsed : []);
            return buildComponentPayload({ content: '', components: rows });
        } catch (err) {
            logger.warn('welcome_join: invalid componentJson', {
                category: 'system', guildId: guild.id, error: err.message,
            });
            return null;
        }
    }

    // Default: plain text
    const resolved = resolveVars(content || '', member, guild);
    if (!resolved.trim()) return null;
    return { content: resolved };
}

// ── Send a single template ──────────────────────────────────────────────────

/**
 * @param {object} tpl  template config object
 * @param {import('discord.js').GuildMember} member
 * @param {import('discord.js').Guild} guild
 */
async function sendTemplate(tpl, member, guild) {
    const { channelId, sendDelay, deleteDelay } = tpl;

    // Apply send delay
    if (sendDelay > 0) {
        await new Promise(r => setTimeout(r, sendDelay * 1_000));
    }

    // Resolve channel
    let channel;
    if (channelId === 'dm') {
        try {
            channel = await member.user.createDM();
        } catch {
            logger.warn('welcome_join: could not open DM', {
                category: 'system', guildId: guild.id, userId: member.id,
            });
            return;
        }
    } else {
        channel = guild.channels.cache.get(channelId);
        if (!channel) {
            logger.warn('welcome_join: channel not found', {
                category: 'system', guildId: guild.id, channelId,
            });
            return;
        }
    }

    // Build and send
    const payload = buildPayload(tpl, member, guild);
    if (!payload) return;

    let sentMsg;
    try {
        sentMsg = await channel.send(payload);
    } catch (err) {
        logger.warn('welcome_join: failed to send message', {
            category: 'system', guildId: guild.id, channelId, error: err.message,
        });
        db.WelcomeJoin.pushLog(guild.id, {
            userId:       member.id,
            username:     member.user.username,
            displayName:  member.displayName,
            avatarUrl:    member.user.displayAvatarURL({ size: 32 }),
            templateName: tpl.name || '',
            channelId:    channelId,
            type:         tpl.type || 'text',
            status:       'error',
            errorMsg:     err.message,
        }).catch(() => {});
        return;
    }

    // Log successful send
    db.WelcomeJoin.pushLog(guild.id, {
        userId:       member.id,
        username:     member.user.username,
        displayName:  member.displayName,
        avatarUrl:    member.user.displayAvatarURL({ size: 32 }),
        templateName: tpl.name || '',
        channelId:    channelId,
        type:         tpl.type || 'text',
        status:       'ok',
    }).catch(() => {});

    // Apply delete delay
    if (deleteDelay > 0 && sentMsg?.deletable) {
        setTimeout(() => sentMsg.delete().catch(() => {}), deleteDelay * 1_000);
    }
}

// ── Send the Dynamic Image on member join ─────────────────────────────────────

/**
 * Renders the welcome image (requires `canvas`) and sends it via the configured sendMode.
 * Silently skips if canvas is unavailable or the config is disabled.
 * @param {import('discord.js').GuildMember} member
 * @param {import('discord.js').Guild} guild
 */
async function sendWelcomeImage(member, guild, joinConfig) {
    let imgConfig;
    try {
        const db = require('./schemas');
        imgConfig = await db.WelcomeImage.getConfig(guild.id);
    } catch (err) {
        logger.warn('welcome_join: failed to load WelcomeImage config', {
            category: 'system', guildId: guild.id, error: err.message,
        });
        return;
    }

    if (!imgConfig || !imgConfig.enabled) return;

    const mode = imgConfig.sendMode || 'embed';

    let channelId = imgConfig.channelId;
    if (mode === 'embed' || mode === 'component') {
        if (!imgConfig.linkedTemplateId) {
            logger.warn('welcome_join: WelcomeImage embed/component mode requires a linked template', {
                category: 'system', guildId: guild.id,
            });
            return;
        }
        const templates = Array.isArray(joinConfig?.templates) ? joinConfig.templates : [];
        const linkedTpl = templates.find(t => t.name === imgConfig.linkedTemplateId);
        if (!linkedTpl || !linkedTpl.channelId) {
            logger.warn('welcome_join: linked template not found for image', {
                category: 'system', guildId: guild.id, linkedTemplateId: imgConfig.linkedTemplateId,
            });
            return;
        }
        channelId = linkedTpl.channelId;
    }

    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
        logger.warn('welcome_join: WelcomeImage channel not found', {
            category: 'system', guildId: guild.id, channelId,
        });
        return;
    }

    // Try to render the image — canvas might not be installed
    let imageBuffer = null;
    try {
        const { renderWelcomeImage } = require('./welcome_image_renderer');
        imageBuffer = await renderWelcomeImage(imgConfig, { member, guild });
    } catch (err) {
        logger.warn('welcome_join: could not render welcome image (canvas may not be installed)', {
            category: 'system', guildId: guild.id, error: err.message,
        });
        return;
    }

    if (!imageBuffer || !imageBuffer.length) return;

    const attachment = new AttachmentBuilder(imageBuffer, { name: 'welcome.png' });

    // Resolve any text variables
    const componentText  = resolveVars(imgConfig.componentText  || '', member, guild);
    const attachmentText = resolveVars(imgConfig.attachmentText || '', member, guild);

    try {
        if (mode === 'embed') {
            const e = new EmbedBuilder().setImage('attachment://welcome.png');
            const opts = imgConfig.embedOptions || {};
            if (opts.title)       e.setTitle(resolveVars(opts.title, member, guild).slice(0, 256));
            if (opts.description) e.setDescription(resolveVars(opts.description, member, guild).slice(0, 4096));
            if (opts.footer)      e.setFooter({ text: resolveVars(opts.footer, member, guild).slice(0, 2048) });
            if (opts.color) { try { e.setColor(opts.color); } catch { /* invalid */ } }
            await channel.send({ embeds: [e], files: [attachment] });

        } else if (mode === 'component') {
            const container = new ContainerBuilder();
            if (componentText.trim()) {
                container.addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(componentText)
                );
            }
            container.addMediaGalleryComponents(
                new MediaGalleryBuilder().addItems(
                    new MediaGalleryItemBuilder().setURL('attachment://welcome.png')
                )
            );
            await channel.send({
                components: [container],
                files: [attachment],
                flags: MessageFlags.IsComponentsV2,
            });

        } else {
            // attachment mode — send the image as a standalone file with optional text
            await channel.send({
                content:  attachmentText.trim() || undefined,
                files:    [attachment],
            });
        }
    } catch (err) {
        logger.warn('welcome_join: failed to send welcome image', {
            category: 'system', guildId: guild.id, channelId: imgConfig.channelId,
            sendMode: mode, error: err.message,
        });
    }
}

// ── Core: process a member join ───────────────────────────────────────────────

/**
 * @param {import('discord.js').GuildMember} member
 * @param {boolean} [rulesJustPassed=false]  true when called from guildMemberUpdate after screening
 */
async function processJoin(member, rulesJustPassed = false) {
    const guild = member.guild;

    let config;
    try {
        config = await db.WelcomeJoin.getConfig(guild.id);
    } catch (err) {
        logger.error('welcome_join: failed to read config', {
            category: 'system', guildId: guild.id, error: err.message,
        });
        return;
    }

    if (!config.enabled) return;

    // Global filters
    if (config.ignoreBots  && member.user.bot)   return;
    if (config.ignoreUsers && !member.user.bot)  return;

    // If waitRules is on globally and we're at the initial join (not post-screening), skip
    if (config.waitRules && !rulesJustPassed && member.pending) return;

    // DM welcome
    if (config.dmWelcome && config.dmMessage) {
        try {
            const dm = await member.user.createDM();
            const resolved = resolveVars(config.dmMessage, member, guild);
            if (resolved.trim()) await dm.send(resolved);
        } catch (err) {
            logger.warn('welcome_join: DM send failed', {
                category: 'system', guildId: guild.id, userId: member.id, error: err.message,
            });
        }
    }

    const templates = Array.isArray(config.templates) ? config.templates : [];
    const groups    = Array.isArray(config.groups)    ? config.groups    : [];

    // Collect all template names claimed by at least one enabled group
    // — those templates are sent exclusively through their group (random pick), not individually
    const _groupedNames = new Set();
    for (const g of groups) {
        if (g.enabled !== false && Array.isArray(g.templateNames)) {
            for (const n of g.templateNames) _groupedNames.add(n);
        }
    }

    if (templates.length === 0 && groups.length === 0) return;

    // ── Individual templates (not belonging to any group) ──
    for (const tpl of templates) {
        if (!tpl.channelId) continue;
        if (tpl.enabled === false) continue;
        if (_groupedNames.has(tpl.name)) continue; // handled by its group

        // Per-template filters
        if (tpl.ignoreBots  && member.user.bot)  continue;
        if (tpl.ignoreUsers && !member.user.bot) continue;

        if (tpl.waitRules && !rulesJustPassed && member.pending) continue;
        if (rulesJustPassed && !tpl.waitRules) continue;

        await sendTemplate(tpl, member, guild);
    }

    // ── Randomized groups — pick one template at random from each enabled group ──
    for (const group of groups) {
        if (group.enabled === false) continue;
        const candidates = (group.templateNames || [])
            .map(name => templates.find(t => t.name === name))
            .filter(t => t && t.enabled !== false && t.channelId
                && !(t.ignoreBots  && member.user.bot)
                && !(t.ignoreUsers && !member.user.bot)
                && !(t.waitRules && !rulesJustPassed && member.pending)
                && !(rulesJustPassed && !t.waitRules));
        if (!candidates.length) continue;
        const picked = candidates[Math.floor(Math.random() * candidates.length)];
        await sendTemplate(picked, member, guild);
    }

    // Dynamic image (no waitRules support — always fires on final join)
    if (!rulesJustPassed) {
        await sendWelcomeImage(member, guild, config);
    }
}

// ── Module export ─────────────────────────────────────────────────────────────

module.exports = {
    name: 'welcome-join-system',

    execute(client) {
        logger.info('Loading welcome-join system...');

        // Primary event: member joins the guild
        client.on('guildMemberAdd', async (member) => {
            try {
                await processJoin(member, false);
            } catch (err) {
                logger.error('welcome_join: unhandled error in guildMemberAdd', {
                    category: 'system',
                    guildId: member.guild?.id,
                    userId:  member.id,
                    error:   err.message,
                    stack:   err.stack,
                });
            }
        });

        // Secondary: member passes membership screening
        client.on('guildMemberUpdate', async (oldMember, newMember) => {
            // Only fire when the member just passed screening (pending: true → false)
            if (!oldMember.pending || newMember.pending) return;
            try {
                await processJoin(newMember, true);
            } catch (err) {
                logger.error('welcome_join: unhandled error in guildMemberUpdate', {
                    category: 'system',
                    guildId: newMember.guild?.id,
                    userId:  newMember.id,
                    error:   err.message,
                    stack:   err.stack,
                });
            }
        });

        logger.info('Welcome-join system loaded successfully');
    },
};
