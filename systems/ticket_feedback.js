/*
 * This project was programmed by the Code Nexus team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/UvEYbFd2rj
 */

/**
 * systems/ticket_feedback.js
 * Exit-survey feedback system for tickets.
 *
 * Flow:
 *   1. After a ticket is closed, sendFeedbackPrompt() sends the user an
 *      ephemeral Components V2 message with star-rating buttons (1–5).
 *   2. The user clicks a star → handleFeedbackButton() shows a Modal for
 *      an optional extra comment.
 *   3. On modal submit → handleFeedbackModal() saves the entry to
 *      database/<guildId>/ticket_feedback.json and confirms to the user.
 *
 * Only runs when panel.exitSurvey is truthy.
 *
 * Register once by calling registerFeedbackHandlers(client) in index.js.
 */

'use strict';

const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags,
} = require('discord.js');

const guildDb = require('../dashboard/utils/guildDb');

// ── Notify dashboard via socket.io ───────────────────────────────────────
function _emitFeedbackUpdate(guildId) {
    try {
        const { io } = require('../dashboard/server');
        if (io) io.to(`guild:${guildId}`).emit('tickets:update', { guildId });
    } catch (_e) { /* non-critical */ }
}

// ── i18n helper ──────────────────────────────────────────────────────────
function _i18n(lang) {
    const isEn = lang === 'en';
    return {
        ratingReceived : isEn ? 'Your rating has been received' : 'تم استلام تقييمك',
        newFeedback    : isEn ? '📩 New Feedback Received'       : '📩 تقييم جديد مستلم',
        ticketLabel    : isEn ? '**Ticket:**'                    : '**التذكرة:**',
        panelLabel     : isEn ? '**Panel:**'                     : '**البانل:**',
        userLabel      : isEn ? '**User:**'                      : '**المستخدم:**',
        claimerLabel   : isEn ? '**Received by:**'               : '**مستلم التذكرة:**',
        ratingLabel    : isEn ? '**Rating:**'                    : '**التقييم:**',
        commentLabel   : isEn ? '**Comment:**'                   : '**التعليق:**',
        threadName     : isEn ? 'Feedback Thread'                : 'خيط التقييم',
    };
}

// ── Feedback schema (stored per guild) ───────────────────────────────────
// database/<guildId>/ticket_feedback.json
// {
//   entries: [
//     { ticketId, panelId, userId, rating, comment, submittedAt }
//   ]
// }

// ── Send the star-rating prompt to the user ────────────────────────────────
/**
 * Send an ephemeral star-rating message after ticket close.
 * Skips silently if panel.feedbackEnabled is not true.
 *
 * @param {import('discord.js').Interaction} interaction  – the closing interaction
 * @param {string} guildId
 * @param {object} ticket  – open ticket record
 * @param {object} [panel] – panel config from tickets.json
 * @param {import('discord.js').User} [dmUser] – if provided and panel.feedbackDm is true, also DMs the prompt
 */
async function sendFeedbackPrompt(interaction, guildId, ticket, panel, dmUser = null, ticketData = null) {
    if (!panel?.feedbackEnabled && !ticketData?.general?.ENABLE_FEEDBACK) return;

    const container = new ContainerBuilder().setAccentColor(0xfee75c);

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `## 📝 How was your experience?\nRate your support experience with **${panel?.panelTitle || 'our team'}**.`
        )
    );
    container.addSeparatorComponents(new SeparatorBuilder());
    if (ticket.claimedBy) {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`<@${ticket.claimedBy}>`)
        );
    }

    const row = new ActionRowBuilder().addComponents(
        ...[1, 2, 3, 4, 5].map(n =>
            new ButtonBuilder()
                .setCustomId(`ticket_fb_${guildId}_${ticket.id}_${n}`)
                .setLabel('⭐'.repeat(n))
                .setStyle(ButtonStyle.Secondary)
        )
    );
    container.addActionRowComponents(row);

    // Always DM the ticket opener when a dmUser (opener) is provided.
    // This is the ONLY delivery path when the closer is a staff member.
    if (dmUser) {
        try {
            const dmPayload = {
                components: [container],
                flags:      MessageFlags.IsComponentsV2,
            };
            const dmChannel = await dmUser.createDM();
            await dmChannel.send(dmPayload);
        } catch (err) {
            console.error('[ticket_feedback] Failed to DM feedback prompt to opener:', err.message);
        }
    }
}

// ── Handle the star button → show modal ───────────────────────────────────
/**
 * customId format: ticket_fb_<ticketId>_<rating>
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleFeedbackButton(interaction, client) {
    const parts     = interaction.customId.split('_');
    const fbGuildId = parts[2];
    const rating    = parseInt(parts[parts.length - 1], 10);
    const ticketId  = parts.slice(3, parts.length - 1).join('_');

    // Load ticket/panel data first so _i18n is available for the update message
    const openTicketsDb = guildDb.read(fbGuildId, 'open_tickets', { tickets: [] });
    const ticket        = openTicketsDb.tickets.find(t => t.id === ticketId);
    const panelId       = ticket?.panelId || null;
    const ticketsDb     = guildDb.read(fbGuildId, 'tickets', { panels: [], multiPanels: [] });
    const panel         = panelId ? (ticketsDb.panels || []).find(p => p.id === panelId) : null;
    const lang          = ticketsDb.general?.LANGUAGE || 'ar';
    const s             = _i18n(lang);

    // Build updated container with colored + disabled buttons
    const accentColor = rating >= 4 ? 0x57f287 : rating >= 3 ? 0xfee75c : 0xed4245;
    const updContainer = new ContainerBuilder().setAccentColor(accentColor);
    updContainer.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `## ${'⭐'.repeat(rating)} ${s.ratingReceived}`
        )
    );
    const disabledRow = new ActionRowBuilder().addComponents(
        ...[1, 2, 3, 4, 5].map(n => {
            const isChosen = n === rating;
            const style = isChosen
                ? (rating >= 4 ? ButtonStyle.Success : rating >= 3 ? ButtonStyle.Primary : ButtonStyle.Danger)
                : ButtonStyle.Secondary;
            return new ButtonBuilder()
                .setCustomId(`ticket_fb_${fbGuildId}_${ticketId}_${n}`)
                .setLabel('⭐'.repeat(n))
                .setStyle(style)
                .setDisabled(true);
        })
    );
    updContainer.addActionRowComponents(disabledRow);

    await interaction.update({
        components: [updContainer],
        flags:      MessageFlags.IsComponentsV2,
    });

    // Persist the rating

    const db = guildDb.read(fbGuildId, 'ticket_feedback', { entries: [] });
    db.entries.push({
        ticketId,
        panelId,
        userId:      interaction.user.id,
        rating,
        comment:     '',
        submittedAt: new Date().toISOString(),
    });
    guildDb.write(fbGuildId, 'ticket_feedback', db);
    _emitFeedbackUpdate(fbGuildId);

    // ── Staff Points: award rating-based points to ticket claimer ─────────
    try {
        const staffPoints = require('./staff_points');
        await staffPoints.awardRatingPoints(
            client, fbGuildId, ticket?.claimedBy,
            rating, ticketId, interaction.user.id
        );
    } catch (_e) { /* non-critical */ }

    // Post to feedback results channel if configured
    if (panel?.feedbackChannel && client) {
        try {
            const guild   = client.guilds.cache.get(fbGuildId);
            const channel = guild?.channels.cache.get(panel.feedbackChannel);
            if (channel) {
                const claimerMention = ticket?.claimedBy ? `<@${ticket.claimedBy}>` : null;
                const panelName      = panel.panelTitle || panelId || 'unknown';
                const stars          = '⭐'.repeat(rating);
                const notifContainer = new ContainerBuilder().setAccentColor(accentColor);
                notifContainer.addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `## ${s.newFeedback}${claimerMention ? ` ${claimerMention}` : ''}`
                    )
                );
                notifContainer.addSeparatorComponents(new SeparatorBuilder());
                notifContainer.addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        [
                            `${s.ticketLabel} \`${ticketId}\``,
                            `${s.userLabel} <@${interaction.user.id}>`,
                            claimerMention ? `${s.claimerLabel} ${claimerMention}` : null,
                            `${s.ratingLabel} ${stars}`,
                        ].filter(Boolean).join('\n')
                    )
                );
                const sentBtn = await channel.send({ components: [notifContainer], flags: MessageFlags.IsComponentsV2 });
                try { await sentBtn.startThread({ name: `${s.threadName} — ${ticketId}` }); } catch (_) {}
            }
        } catch (err) {
            console.error('[ticket_feedback] Failed to post result to channel:', err.message);
        }
    }
}

// ── Handle the modal submission → save + confirm ──────────────────────────
/**
 * customId format: ticket_fb_modal_<ticketId>_<rating>
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
async function handleFeedbackModal(interaction, client) {
    const parts    = interaction.customId.split('_');
    // ticket_fb_modal_<guildId>_<ticketId>_<rating>
    // index: 0=ticket 1=fb 2=modal 3=guildId 4…n-2=ticketId parts n-1=rating
    const guildId  = parts[3] || interaction.guildId;
    const rating   = parseInt(parts[parts.length - 1], 10);
    const ticketId = parts.slice(4, parts.length - 1).join('_');
    const comment  = interaction.fields.getTextInputValue('comment') || '';

    // Lookup panel id from open_tickets
    const openTicketsDb = guildDb.read(guildId, 'open_tickets', { tickets: [] });
    const ticket        = openTicketsDb.tickets.find(t => t.id === ticketId);
    const panelId       = ticket?.panelId || null;

    // Lookup panel config for feedbackChannel / feedbackRole
    const ticketsDb = guildDb.read(guildId, 'tickets', { panels: [], multiPanels: [] });
    const panel     = panelId ? (ticketsDb.panels || []).find(p => p.id === panelId) : null;
    const lang      = ticketsDb.general?.LANGUAGE || 'ar';
    const s         = _i18n(lang);

    // Persist feedback entry
    const db = guildDb.read(guildId, 'ticket_feedback', { entries: [] });
    db.entries.push({
        ticketId,
        panelId,
        userId:      interaction.user.id,
        rating,
        comment:     comment.trim(),
        submittedAt: new Date().toISOString(),
    });
    guildDb.write(guildId, 'ticket_feedback', db);
    _emitFeedbackUpdate(guildId);

    // ── Staff Points: award rating-based points to ticket claimer ─────────
    try {
        const staffPoints = require('./staff_points');
        await staffPoints.awardRatingPoints(
            client, guildId, ticket?.claimedBy,
            rating, ticketId, interaction.user.id
        );
    } catch (_e) { /* non-critical */ }

    // Confirmation card (ephemeral to user)
    const stars     = '⭐'.repeat(rating) + '☆'.repeat(5 - rating);
    const confirmContainer = new ContainerBuilder().setAccentColor(0x57f287);
    confirmContainer.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `✅ **Thank you for your feedback!**\nYou rated: ${stars}\n${comment ? `> ${comment}` : ''}`
        )
    );

    await interaction.reply({
        components: [confirmContainer],
        flags:      MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });

    // ── Post result to feedback results channel ───────────────────────────
    if (panel?.feedbackChannel && client) {
        try {
            const guild   = client.guilds.cache.get(guildId);
            const channel = guild?.channels.cache.get(panel.feedbackChannel);
            if (channel) {
                const claimerMention = ticket?.claimedBy ? `<@${ticket.claimedBy}>` : null;
                const panelName      = panel.panelTitle || panelId || 'unknown';

                const notifContainer = new ContainerBuilder().setAccentColor(
                    rating >= 4 ? 0x57f287 : rating >= 3 ? 0xfee75c : 0xed4245
                );

                notifContainer.addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `## ${s.newFeedback}${claimerMention ? ` ${claimerMention}` : ''}`
                    )
                );
                notifContainer.addSeparatorComponents(new SeparatorBuilder());
                notifContainer.addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        [
                            `${s.ticketLabel} \`${ticketId}\``,
                            `${s.userLabel} <@${interaction.user.id}>`,
                            claimerMention ? `${s.claimerLabel} ${claimerMention}` : null,
                            `${s.ratingLabel} ${stars}`,
                            comment ? `${s.commentLabel}\n> ${comment}` : null,
                        ].filter(Boolean).join('\n')
                    )
                );

                const sentModal = await channel.send({
                    components: [notifContainer],
                    flags:      MessageFlags.IsComponentsV2,
                });
                try { await sentModal.startThread({ name: `${s.threadName} — ${ticketId}` }); } catch (_) {}
            } else {
                console.warn('[ticket_feedback] feedbackChannel not found:', panel.feedbackChannel);
            }
        } catch (err) {
            console.error('[ticket_feedback] Failed to post result to channel:', err.message);
        }
    } else if (!panel?.feedbackChannel) {
        console.log(`[ticket_feedback] No feedbackChannel set for panel ${panelId} — saved locally only.`);
    }
}

// ── Optionally post feedback summary to a channel ─────────────────────────
/**
 * Post a compact summary of all feedback for a panel to a text channel.
 * Useful for periodic /feedback-report commands.
 *
 * @param {import('discord.js').TextChannel} channel
 * @param {string} guildId
 * @param {string} [panelId]  – filter by panel; omit to show all
 */
async function postFeedbackSummary(channel, guildId, panelId = null) {
    const db      = guildDb.read(guildId, 'ticket_feedback', { entries: [] });
    const entries = panelId
        ? db.entries.filter(e => e.panelId === panelId)
        : db.entries;

    if (entries.length === 0) {
        return channel.send({ content: 'No feedback found.', flags: MessageFlags.Ephemeral });
    }

    const avg   = (entries.reduce((s, e) => s + (e.rating || 0), 0) / entries.length).toFixed(2);
    const dist  = [1,2,3,4,5].map(n => `${n}⭐: ${entries.filter(e => e.rating === n).length}`).join('  |  ');
    const recents = entries.slice(-5).reverse()
        .map(e => `- <@${e.userId}> — ${'⭐'.repeat(e.rating)}${e.comment ? ` — _${e.comment}_` : ''}`)
        .join('\n');

    const container = new ContainerBuilder().setAccentColor(0xfee75c);
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('## 📊 Feedback Summary')
    );
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `**Total responses:** ${entries.length}\n**Average rating:** ${avg} / 5.0\n${dist}\n\n**Recent:**\n${recents}`
        )
    );

    await channel.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
}

// ── Register handlers on the client ───────────────────────────────────────
/**
 * Wire up star-button and modal-submit listeners.
 * Call once from index.js or the main system loader.
 *
 * @param {import('discord.js').Client} client
 */
function registerFeedbackHandlers(client) {
    client.on('interactionCreate', async interaction => {
        try {
            if (interaction.isButton() && interaction.customId.startsWith('ticket_fb_') && !interaction.customId.includes('modal')) {
                await handleFeedbackButton(interaction, client);
                return;
            }
            if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket_fb_modal_')) {
                await handleFeedbackModal(interaction, client);
                return;
            }
        } catch (err) {
            console.error('[ticket_feedback]', err);
        }
    });

    console.log('[Tickets] Feedback handlers registered');
}

module.exports = {
    sendFeedbackPrompt,
    postFeedbackSummary,
    registerFeedbackHandlers,
    // exported for testing / manual use
    handleFeedbackButton,
    handleFeedbackModal,
};


/*
 * This project was programmed by the Code Nexus team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/UvEYbFd2rj
 */