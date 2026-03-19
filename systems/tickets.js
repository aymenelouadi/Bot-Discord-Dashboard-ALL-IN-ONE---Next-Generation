/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

/**
 * systems/tickets.js
 * Ticket panel send/edit using Discord Components V2 (discord.js ≥ 14.14)
 * All data read from  dashboard/database/<guildId>/tickets.json
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const {
    ContainerBuilder,
    TextDisplayBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    AttachmentBuilder,
    SeparatorBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    MessageFlags,
} = require('discord.js');

// Parse a #rrggbb hex string to a 24-bit integer for setAccentColor()
function _parseColor(hex) {
    if (!hex || typeof hex !== 'string') return null;
    const n = parseInt(hex.replace('#', ''), 16);
    return isNaN(n) ? null : n;
}

// Dashboard btnColor 1-4 → ButtonStyle
const BTN_STYLE = {
    1: ButtonStyle.Primary,
    2: ButtonStyle.Secondary,
    3: ButtonStyle.Success,
    4: ButtonStyle.Danger,
};
function _btnStyle(n) { return BTN_STYLE[Number(n)] || ButtonStyle.Primary; }

// Resolve a bannerImage value to { url, attachment? }
// Returns null if the image can't be resolved.
function _resolveBanner(bannerImage) {
    if (!bannerImage) return null;
    if (bannerImage.startsWith('http://') || bannerImage.startsWith('https://')) {
        return { url: bannerImage, attachment: null };
    }
    if (bannerImage.startsWith('/uploads/')) {
        const filePath = path.join(__dirname, '../dashboard/public', bannerImage);
        if (!fs.existsSync(filePath)) return null;
        const ext    = path.extname(bannerImage).slice(1).toLowerCase() || 'png';
        const fname  = `banner.${ext}`;
        const buffer = fs.readFileSync(filePath);
        return { url: `attachment://${fname}`, attachment: new AttachmentBuilder(buffer, { name: fname }) };
    }
    return null;
}

// ── Build single-panel Components V2 payload ───────────────────────────────
function _buildPanelPayload(panel) {
    const container = new ContainerBuilder();
    const files     = [];

    // Accent colour stripe on the container
    const accentNum = _parseColor(panel.accentColor);
    if (accentNum !== null) container.setAccentColor(accentNum);

    // Banner image (MediaGallery at top)
    const banner = _resolveBanner(panel.bannerImage);
    if (banner) {
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder().setURL(banner.url)
            )
        );
        if (banner.attachment) files.push(banner.attachment);
    }

    // Title & description text
    if (panel.panelTitle) {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`## ${panel.panelTitle}`)
        );
    }
    if (panel.description) {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(panel.description)
        );
    }

    // Divider before interactive component
    container.addSeparatorComponents(new SeparatorBuilder());

    if (panel.useSelectMenu) {
        // Single-entry select menu (allowed even with 1 option)
        const menu = new StringSelectMenuBuilder()
            .setCustomId(`ticket_mp_select_${panel.id}`)
            .setPlaceholder((panel.selectMenuPlaceholder || 'Select a category…').substring(0, 150))
            .setMinValues(1).setMaxValues(1);
        const opt = new StringSelectMenuOptionBuilder()
            .setValue(`ticket_open_${panel.id}`)
            .setLabel((panel.btnText || panel.panelTitle || 'Open Ticket').substring(0, 100));
        if (panel.btnEmoji) { try { opt.setEmoji(panel.btnEmoji); } catch (_) {} }
        if (panel.selectMenuDesc) { try { opt.setDescription(panel.selectMenuDesc.substring(0, 50)); } catch (_) {} }
        menu.addOptions(opt);
        container.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
    } else {
        // Standard button
        const btn = new ButtonBuilder()
            .setCustomId(`ticket_open_${panel.id}`)
            .setLabel((panel.btnText || 'Open Ticket').substring(0, 80))
            .setStyle(_btnStyle(panel.btnColor));
        if (panel.btnEmoji) {
            try { btn.setEmoji(panel.btnEmoji); } catch (_) { /* ignore bad emoji */ }
        }
        container.addActionRowComponents(new ActionRowBuilder().addComponents(btn));
    }

    const payload = { components: [container], flags: MessageFlags.IsComponentsV2 };
    if (files.length) payload.files = files;
    return payload;
}

// ── Build multi-panel Components V2 payload ────────────────────────────────
function _buildMultiPanelPayload(mp, panels) {
    const container = new ContainerBuilder();
    const files     = [];

    // Accent colour stripe
    const accentNum = _parseColor(mp.accentColor);
    if (accentNum !== null) container.setAccentColor(accentNum);

    // Banner image (MediaGallery at top)
    const banner = _resolveBanner(mp.bannerImage);
    if (banner) {
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder().setURL(banner.url)
            )
        );
        if (banner.attachment) files.push(banner.attachment);
    }

    // Title & description text
    if (mp.panelTitle) {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`## ${mp.panelTitle}`)
        );
    }
    if (mp.description) {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(mp.description)
        );
    }

    // Separator before interactive components
    container.addSeparatorComponents(new SeparatorBuilder());

    if (mp.useDropdown) {
        // StringSelectMenu — one option per panel (max 25)
        const menu = new StringSelectMenuBuilder()
            .setCustomId(`ticket_mp_select_${mp.id}`)
            .setPlaceholder((mp.placeholder || 'Select a category…').substring(0, 150))
            .setMinValues(1).setMaxValues(1);

        // Track used values to guarantee uniqueness (values must be unique within a select)
        const usedValues = new Set();
        panels.slice(0, 25).forEach((p, i) => {
            let baseId = p.panelId || p.id;
            // Fallback: use mp.id + slot index to ensure uniqueness when panelId is absent
            let value = `ticket_open_${baseId || `${mp.id}_${i}`}`;
            // De-duplicate in the unlikely case two slots share the same panelId
            if (usedValues.has(value)) value = `ticket_open_${mp.id}_${i}`;
            usedValues.add(value);

            const opt = new StringSelectMenuOptionBuilder()
                .setValue(value)
                .setLabel((p.overrideBtnText || p.btnText || p.panelTitle || p.name || 'Panel').substring(0, 100));
            const emoji = p.overrideBtnEmoji || p.btnEmoji;
            if (emoji) { try { opt.setEmoji(emoji); } catch (_) {} }
            menu.addOptions(opt);
        });

        container.addActionRowComponents(new ActionRowBuilder().addComponents(menu));

        // Optional refresh button below the select menu
        if (mp.showRefreshBtn) {
            const refreshBtn = new ButtonBuilder()
                .setCustomId(`ticket_mp_refresh_${mp.id}`)
                .setLabel((mp.refreshBtnLabel || '🔄 Refresh').substring(0, 80))
                .setStyle(ButtonStyle.Secondary);
            container.addActionRowComponents(new ActionRowBuilder().addComponents(refreshBtn));
        }
    } else {
        // Buttons: up to 5 per ActionRow, max 5 rows (25 buttons total)
        // Use absolute slot index for guaranteed unique customIds
        const capped = panels.slice(0, 25);
        for (let i = 0; i < capped.length; i += 5) {
            const row = new ActionRowBuilder();
            capped.slice(i, i + 5).forEach((p, j) => {
                const absIdx = i + j;
                const baseId = p.panelId || p.id;
                const customId = `ticket_open_${baseId || `${mp.id}_${absIdx}`}`;
                const btn = new ButtonBuilder()
                    .setCustomId(customId)
                    .setLabel((p.overrideBtnText || p.btnText || p.panelTitle || p.name || 'Open').substring(0, 80))
                    .setStyle(_btnStyle(p.overrideBtnColor || p.btnColor));
                const emoji = p.overrideBtnEmoji || p.btnEmoji;
                if (emoji) { try { btn.setEmoji(emoji); } catch (_) {} }
                row.addComponents(btn);
            });
            container.addActionRowComponents(row);
        }
    }

    const payload = { components: [container], flags: MessageFlags.IsComponentsV2 };
    if (files.length) payload.files = files;
    return payload;
}

// ── Send or edit a single panel ────────────────────────────────────────────
/**
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @param {object} panel              – panel object from tickets.json
 * @param {string|null} existingMsgId – tries to edit; re-sends if deleted
 * @returns {Promise<string>} live message ID
 */
async function sendPanel(client, guildId, panel, existingMsgId = null) {
    if (!panel.panelChannel)
        throw new Error('No channel set for this panel. Choose a channel first.');

    const channel = client.channels.cache.get(panel.panelChannel)
        ?? await client.channels.fetch(panel.panelChannel).catch(() => null);
    if (!channel)
        throw new Error('Channel not found — ensure the bot has access to it.');

    const payload = _buildPanelPayload(panel);

    if (existingMsgId) {
        const existing = await channel.messages.fetch(existingMsgId).catch(() => null);
        if (existing) { await existing.edit(payload); return existing.id; }
    }

    const msg = await channel.send(payload);
    return msg.id;
}

// ── Send or edit a multi-panel ─────────────────────────────────────────────
/**
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @param {object} mp                 – multi-panel object from tickets.json
 * @param {object[]} panels           – resolved panel objects (overrides merged in)
 * @param {string|null} existingMsgId
 * @returns {Promise<string>} live message ID
 */
async function sendMultiPanel(client, guildId, mp, panels, existingMsgId = null) {
    if (!mp.channel)
        throw new Error('No channel set for this multi-panel. Choose a channel first.');
    if (!panels || panels.length === 0)
        throw new Error('Multi-panel has no panels added to it.');

    const channel = client.channels.cache.get(mp.channel)
        ?? await client.channels.fetch(mp.channel).catch(() => null);
    if (!channel)
        throw new Error('Channel not found — ensure the bot has access to it.');

    const payload = _buildMultiPanelPayload(mp, panels);

    if (existingMsgId) {
        const existing = await channel.messages.fetch(existingMsgId).catch(() => null);
        if (existing) { await existing.edit(payload); return existing.id; }
    }

    const msg = await channel.send(payload);
    return msg.id;
}

// ── Discord interaction handler ────────────────────────────────────────────
module.exports = {
    name: 'ticket-system',

    execute(client) {
        this.client = client;

        // ── Register post-open handlers (close, claim, add/remove user, etc.) ──
        const ticketAfter    = require('./ticket_after');
        const ticketFeedback = require('./ticket_feedback');
        ticketAfter.registerAfterHandlers(client);
        ticketFeedback.registerFeedbackHandlers(client);

        // ── Panel open interactions ────────────────────────────────────────
        client.on('interactionCreate', async (interaction) => {
            try {
                // Single-panel button: ticket_open_<panelId>
                if (interaction.isButton() && interaction.customId.startsWith('ticket_open_')) {
                    const panelId = interaction.customId.slice('ticket_open_'.length);
                    await this._handleOpenTicket(interaction, panelId);
                    return;
                }

                // Multi-panel select: value = ticket_open_<panelId>
                if (interaction.isStringSelectMenu() && interaction.customId.startsWith('ticket_mp_select_')) {
                    const panelId = (interaction.values[0] || '').slice('ticket_open_'.length);
                    await this._handleOpenTicket(interaction, panelId);
                    return;
                }
            } catch (err) {
                console.error('[Tickets]', err);
                const msg = { content: '❌ An error occurred. Please try again.', flags: MessageFlags.Ephemeral };
                if (interaction.replied || interaction.deferred)
                    await interaction.followUp(msg).catch(() => {});
                else
                    await interaction.reply(msg).catch(() => {});
            }
        });

        console.log('[Tickets] System loaded — listening for panel interactions');
    },

    // ── Open a ticket ──────────────────────────────────────────────────────
    async _handleOpenTicket(interaction, panelId) {
        const guildDb    = require('../dashboard/utils/guildDb');
        const ticketData = guildDb.read(interaction.guildId, 'tickets', null);

        if (!ticketData?.enabled) {
            return interaction.reply({ content: '❌ Ticket system is disabled.', flags: MessageFlags.Ephemeral });
        }
        const panel = ticketData.panels?.find(p => p.id === panelId);
        if (!panel) {
            return interaction.reply({ content: '❌ Panel not found.', flags: MessageFlags.Ephemeral });
        }

        const { openTicket } = require('./ticket_after');
        await openTicket(interaction, panelId, panel, ticketData);
    },

    // Exported for dashboard server routes + refresh handler
    sendPanel,
    sendMultiPanel,
    buildMultiPanelPayload: _buildMultiPanelPayload,
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */