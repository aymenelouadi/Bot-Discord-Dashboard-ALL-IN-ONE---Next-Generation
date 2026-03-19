/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

/**
 * systems/ticket_log.js
 * Posts compact Components V2 log messages to the configured log channel
 * for every ticket lifecycle event.
 *
 * Events: open | close | claim | unclaim | reopen | delete | transfer
 *
 * Usage:
 *   const ticketLog = require('./ticket_log');
 *   await ticketLog.logEvent(client, guildId, 'open', { ticket, panel, ticketData, actor, reason });
 */

'use strict';

const path = require('path');

const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    AttachmentBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    MessageFlags,
} = require('discord.js');

// ── Main export ────────────────────────────────────────────────────────────
/**
 * Post a rich close log to the configured log channel.
 * Only fires on the 'close' event — open/claim/unclaim are intentionally silent.
 *
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @param {'close'} event
 * @param {object}  data
 * @param {object}  data.ticket         – ticket record from open_tickets.json
 * @param {object}  [data.panel]        – panel config from tickets.json
 * @param {object}  [data.ticketData]   – full tickets.json data
 * @param {import('discord.js').User} [data.actor]  – user who closed the ticket
 * @param {string}  [data.reason]       – close reason text
 * @param {string|null} [data.transcriptPath] – absolute path to the transcript HTML file
 */
async function logEvent(client, guildId, event, data = {}) {
    // Only log on close
    if (event !== 'close') return;

    const { ticket, panel, ticketData, actor, reason, transcriptPath } = data;

    // Resolve log channel: panel-level first, then global
    const logChannelId = panel?.logChannel
        || ticketData?.logChannel
        || ticketData?.general?.NOTIFICATION_CHANNEL;
    if (!logChannelId) return;

    const logChannel = client.channels.cache.get(logChannelId)
        ?? await client.channels.fetch(logChannelId).catch(() => null);
    if (!logChannel?.isTextBased()) return;

    // ── Timestamps ────────────────────────────────────────────────────────
    const openedTs  = (ticket.openedAt || ticket.createdAt) ? Math.floor(new Date(ticket.openedAt || ticket.createdAt).getTime() / 1000) : null;
    const closedTs  = ticket.closedAt   ? Math.floor(new Date(ticket.closedAt).getTime()   / 1000) : Math.floor(Date.now() / 1000);

    // ── Detail lines ──────────────────────────────────────────────────────
    const ticketNum   = `\`#${String(ticket.number ?? ticket.id).padStart(4, '0')}\``;
    const actorMention = actor ? `<@${actor.id}>` : '`System`';

    const lines = [
        `> **Ticket:** ${ticketNum}`,
        `> **Opened by:** <@${ticket.userId}>`,
        `> **Panel:** ${panel?.panelTitle || ticket.panelId || '—'}`,
        `> **Channel:** ${ticket.channelId ? `<#${ticket.channelId}>` : '*(deleted)*'}`,
    ];

    if (ticket.claimedBy) {
        lines.push(`> **Claimed by:** <@${ticket.claimedBy}>`);
    } else {
        lines.push(`> **Claimed by:** —`);
    }

    lines.push(
        `> **Closed by:** ${actorMention}`,
        `> **Reason:** ${reason || '—'}`,
    );

    if (openedTs) lines.push(`> **Opened:** <t:${openedTs}:f>`);
    lines.push(`> **Closed:** <t:${closedTs}:f>`);

    // ── Build Components V2 container ────────────────────────────────────
    const container = new ContainerBuilder().setAccentColor(0xed4245);

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `## Ticket Closed — ${ticketNum}`
        )
    );

    container.addSeparatorComponents(new SeparatorBuilder());

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(lines.join('\n'))
    );

    // ── Send ──────────────────────────────────────────────────────────────
    // V2 components message — no files here (Discord drops unreferenced attachments
    // when IS_COMPONENTS_V2 is set).
    try {
        await logChannel.send({
            components: [container],
            flags:      MessageFlags.IsComponentsV2,
        });
    } catch (err) {
        console.error('[ticket_log] Failed to post close log:', err.message);
        return;
    }

    // Transcript file — sent as a plain follow-up so Discord delivers it
    if (transcriptPath) {
        const fileName = path.basename(transcriptPath);
        try {
            await logChannel.send({
                content: `📎 Transcript for ticket \`#${String(ticket?.number ?? ticket?.id ?? '?').padStart(4, '0')}\``,
                files: [new AttachmentBuilder(transcriptPath, { name: fileName })],
            });
        } catch (err) {
            console.error('[ticket_log] Failed to send transcript file:', err.message);
        }
    }
}

module.exports = { logEvent };


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */