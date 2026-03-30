/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

/**
 * systems/ticket_after.js
 * Full post-panel-click lifecycle for the ticket system.
 *
 * Responsibilities
 * ─────────────────
 *  openTicket()   — ACL check → cooldown → max-open → channel/thread creation
 *                   → welcome message → log → user reply
 *  closeTicket()  — transcript → feedback prompt → log → channel teardown
 *  claimTicket()  — ownership assignment → log → in-channel notice
 *  unclaimTicket()— release ownership → log
 *  reopenTicket() — reopen a closed ticket channel → log
 *  addUser()      — add a user to the ticket channel
 *  removeUser()   — remove a user from the ticket channel
 *
 * Interaction customId conventions (set by _sendWelcomeMessage):
 *   ticket_close_<ticketId>
 *   ticket_claim_<ticketId>
 *   ticket_unclaim_<ticketId>
 *   ticket_add_<ticketId>       (opens a modal to type a user mention/id)
 *   ticket_remove_<ticketId>    (opens a modal to type a user mention/id)
 *
 * Storage
 * ─────────────────
 *   open_tickets.json     – live ticket records  { tickets:[], nextNumber:1 }
 *   ticket_cooldowns.json – per-user panel cooldowns { "<panelId>_<userId>": ISOString }
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
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ChannelType,
    PermissionFlagsBits,
    MessageFlags,
} = require('discord.js');

const guildDb     = require('../dashboard/utils/guildDb');
const logger = require('../utils/logger');
const ticketLog   = require('./ticket_log');
const ticketStats = require('./ticket_stats');

// ── Hex colour helper ─────────────────────────────────────────────────────
function _hex(hex) {
    if (!hex) return undefined;
    return parseInt(String(hex).replace('#', ''), 16);
}

// ═════════════════════════════════════════════════════════════════════════════
// OPEN TICKET
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Full open-ticket handler, called from systems/tickets.js _handleOpenTicket().
 *
 * @param {import('discord.js').ButtonInteraction|import('discord.js').StringSelectMenuInteraction} interaction
 * @param {string} panelId
 * @param {object} panel       – panel config from tickets.json
 * @param {object} ticketData  – full tickets.json data
 */
async function openTicket(interaction, panelId, panel, ticketData) {
    // ─ 0. If panel has a form, show Discord modal first ─────────────────────────
    if (panel.formEnabled && Array.isArray(panel.formQuestions) && panel.formQuestions.length > 0) {
        return await _showFormModal(interaction, panelId, panel);
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = interaction.guildId;
    const user    = interaction.user;
    const member  = interaction.member;

    // ─ 1. ACL check ──────────────────────────────────────────────────────
    if (!_passesAcl(panel.acl, member)) {
        return interaction.editReply({ content: '❌ You do not have permission to open this ticket.' });
    }

    // ─ 2. Panel disabled check ────────────────────────────────────────────
    if (panel.disabled) {
        return interaction.editReply({ content: '❌ This ticket panel is currently disabled.' });
    }

    // ─ 3. Hours / alwaysOpen check ────────────────────────────────────────
    if (!panel.alwaysOpen && panel.hours) {
        const tz    = panel.timezone || 'UTC';
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(new Date());
        const weekday = parts.find(p => p.type === 'weekday')?.value.toLowerCase();
        const hh      = parseInt(parts.find(p => p.type === 'hour')?.value   ?? '0', 10);
        const mm      = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
        const current = hh * 60 + mm;
        const day     = panel.hours[weekday];
        if (day) {
            const [oh, om] = (day.open  || '00:00').split(':').map(Number);
            const [ch, cm] = (day.close || '24:00').split(':').map(Number);
            if (current < (oh * 60 + om) || current >= (ch * 60 + cm)) {
                const fmt = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
                return interaction.editReply({
                    content: `❌ Tickets are currently closed. Open hours: **${fmt(oh, om)} – ${fmt(ch, cm)}** (${tz}).`,
                });
            }
        }
    }

    // ─ 4. Cooldown check ─────────────────────────────────────────────────
    if (panel.cooldown > 0) {
        const cdKey = `${panelId}_${user.id}`;
        const cds   = guildDb.read(guildId, 'ticket_cooldowns', {});
        const last  = cds[cdKey];
        if (last) {
            const elapsed = Date.now() - new Date(last).getTime();
            const total   = panel.cooldown * 1000;
            if (elapsed < total) {
                const left = Math.ceil((total - elapsed) / 1000);
                const unit = left >= 60 ? `${Math.ceil(left / 60)}m` : `${left}s`;
                return interaction.editReply({
                    content: `⏳ You are on cooldown. Try again in **${unit}**.`,
                });
            }
        }
        cds[cdKey] = new Date().toISOString();
        guildDb.write(guildId, 'ticket_cooldowns', cds);
    }

    // ─ 5. Max-open check ─────────────────────────────────────────────────
    if (panel.maxOpen > 0) {
        const otDb   = await guildDb.readAsync(guildId, 'open_tickets', { tickets: [] });
        const open   = otDb.tickets.filter(
            t => t.userId === user.id && t.panelId === panelId && t.status === 'open'
        );
        if (open.length >= panel.maxOpen) {
            const ch = open[0].channelId ? `<#${open[0].channelId}>` : 'your existing ticket';
            return interaction.editReply({
                content: `❌ You already have an open ticket: ${ch}`,
            });
        }
    }

    // ─ 6. Resolve ticket number + channel name ────────────────────────────
    const guild        = interaction.guild;
    const ticketNumber = await _nextTicketNumber(guildId);
    const channelName  = _buildChannelName(panel, user, ticketNumber, ticketData);

    // ─ 7. Create channel or thread ────────────────────────────────────────
    let ticketChannel = null;
    if (panel.threadMode) {
        ticketChannel = await _createThread(guild, panel, channelName, user);
    } else {
        ticketChannel = await _createChannel(guild, panel, channelName, user, ticketData);
    }

    if (!ticketChannel) {
        return interaction.editReply({
            content: '❌ Could not create ticket channel. Please contact an admin.',
        });
    }

    // ─ 8. Persist ticket record ───────────────────────────────────────────
    const ticketId = `tkt_${Date.now()}`;
    const record   = {
        id:                     ticketId,
        number:                 ticketNumber,
        panelId,
        guildId,
        channelId:              ticketChannel.id,
        userId:                 user.id,
        claimedBy:              null,
        status:                 'open',
        openedAt:               new Date().toISOString(),
        closedAt:               null,
        closedBy:               null,
        closeReason:            null,
        transcriptPath:         null,
        transcriptChannelMsgId: null,
    };

    const otDb = await guildDb.readAsync(guildId, 'open_tickets', { tickets: [], nextNumber: 1 });
    otDb.tickets.push(record);
    otDb.nextNumber = ticketNumber + 1;
    guildDb.write(guildId, 'open_tickets', otDb);
    ticketStats.onTicketOpen(guildId, record);

    // ─ 9. Welcome message ─────────────────────────────────────────────────
    await _sendWelcomeMessage(ticketChannel, panel, ticketData, user, record);

    // Thread notification channel (if enabled)
    if (panel.threadMode && panel.threadNotifChannel) {
        const nc = guild.channels.cache.get(panel.threadNotifChannel)
            ?? await guild.channels.fetch(panel.threadNotifChannel).catch(() => null);
        if (nc?.isTextBased()) {
            const c = new ContainerBuilder().setAccentColor(_hex(panel.panelColor) ?? 0x57f287);
            c.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `🎫 New thread ticket opened by <@${user.id}>: <#${ticketChannel.id}>`
                )
            );
            await nc.send({ components: [c], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
        }
    }

    // ─ 10. Reply to user ──────────────────────────────────────────────────
    const reply = new ContainerBuilder()
        .setAccentColor(_hex(panel.welcomeColor) ?? _hex(ticketData?.general?.COLOR_SUCCESS) ?? 0x57f287);
    reply.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `✅ Your ticket has been created: <#${ticketChannel.id}>`
        )
    );
    await interaction.editReply({ components: [reply], flags: MessageFlags.IsComponentsV2 });
}

// ═════════════════════════════════════════════════════════════════════════════
// CLOSE TICKET
// ═════════════════════════════════════════════════════════════════════════════
/**
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} ticketId
 * @param {string} [reason]
 */
async function closeTicket(interaction, ticketId, reason = '') {
    const guildId = interaction.guildId;
    const otDb    = await guildDb.readAsync(guildId, 'open_tickets', { tickets: [] });
    const idx     = otDb.tickets.findIndex(t => t.id === ticketId);

    if (idx === -1) {
        return interaction.reply({ content: '❌ Ticket record not found.', flags: MessageFlags.Ephemeral });
    }

    const ticket     = otDb.tickets[idx];
    const ticketData = guildDb.read(guildId, 'tickets', null);
    const panel      = ticketData?.panels?.find(p => p.id === ticket.panelId);

    // ─ Permission check ───────────────────────────────────────────────────
    const canClose = _isStaff(interaction.member, panel, ticketData)
        || (ticketData?.general?.ALLOW_USER_CLOSE && interaction.user.id === ticket.userId);
    if (!canClose) {
        return interaction.reply({
            content: '❌ You do not have permission to close this ticket.',
            flags:   MessageFlags.Ephemeral,
        });
    }

    // Check close-reason requirement — panel-level first, then fall back to global setting
    const _shouldAskReason = !(panel?.hideCloseReason ?? ticketData?.general?.HIDE_CLOSE_REASON_BTN ?? false);
    if (_shouldAskReason && !reason) {
        // Show a modal asking for reason
        const modal = new ModalBuilder()
            .setCustomId(`ticket_close_reason_${ticketId}`)
            .setTitle('Close Ticket');
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('reason')
                    .setLabel('Reason for closing')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setMaxLength(300)
            )
        );
        try {
            await interaction.showModal(modal);
        } catch (err) {
            if (err.code !== 10062) throw err;
        }
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Update record
    otDb.tickets[idx] = {
        ...ticket,
        status:      'closed',
        closedAt:    new Date().toISOString(),
        closedBy:    interaction.user.id,
        closeReason: reason || null,
    };
    guildDb.write(guildId, 'open_tickets', otDb);
    ticketStats.onTicketClose(guildId, ticket, otDb.tickets[idx].closedAt);

    const updatedTicket = otDb.tickets[idx];

    // ─ Transcript ─────────────────────────────────────────────────────────
    try {
        const { generateTranscript } = require('./ticket_transcript');
        // DM the transcript to the ticket creator (not the person who closed it)
        const ticketCreator = await interaction.client.users.fetch(ticket.userId).catch(() => null);
        const result = await generateTranscript(
            interaction.client, guildId, updatedTicket, panel, ticketData, ticketCreator
        );
        otDb.tickets[idx].transcriptPath           = result.filePath;
        otDb.tickets[idx].transcriptChannelMsgId   = result.transcriptChannelMsgId;
        guildDb.write(guildId, 'open_tickets', otDb);
    } catch (err) {
        logger.error('[ticket_after/close] Transcript error:', err.message);
    }

    // ─ Log (rich close card + transcript file) ──────────────────────────────
    await ticketLog.logEvent(interaction.client, guildId, 'close', {
        ticket:         otDb.tickets[idx],
        panel,
        ticketData,
        actor:          interaction.user,
        reason,
        transcriptPath: otDb.tickets[idx].transcriptPath ?? null,
    }).catch(err => logger.error('[ticket_after/close] log error:', err.message));

    // ─ Feedback prompt (always goes to the ticket OPENER, not the closer) ──
    try {
        const { sendFeedbackPrompt } = require('./ticket_feedback');
        const openerUser = await interaction.client.users.fetch(updatedTicket.userId).catch(() => null);
        await sendFeedbackPrompt(interaction, guildId, updatedTicket, panel, openerUser, ticketData);
    } catch (err) {
        logger.error('[ticket_after/close] Feedback error:', err.message);
    }

    // ─ Channel: post close notice and delete after delay ──────────────────
    const channel = interaction.channel;
    if (channel) {
        const closeCard = new ContainerBuilder().setAccentColor(_hex(ticketData?.general?.COLOR_FAILURE) ?? 0xed4245);
        const closeLines = [
            `🔒 Ticket closed by <@${interaction.user.id}>`,
        ];
        if (reason) closeLines.push(`> ${reason}`);
        closeLines.push(`\n-# This channel will be deleted in 5 seconds.`);
        closeCard.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(closeLines.join('\n'))
        );
        await channel.send({
            components: [closeCard],
            flags:      MessageFlags.IsComponentsV2,
        }).catch(() => {});

        setTimeout(() => channel.delete('Ticket closed').catch(() => {}), 5000);
    }

    const doneCard = new ContainerBuilder().setAccentColor(_hex(ticketData?.general?.COLOR_SUCCESS) ?? 0x57f287);
    doneCard.addTextDisplayComponents(new TextDisplayBuilder().setContent('✅ Ticket closed.'));
    await interaction.editReply({
        components: [doneCard],
        flags:      MessageFlags.IsComponentsV2,
    });
}

// Handle the close-reason modal submit
async function handleCloseReasonModal(interaction) {
    const parts    = interaction.customId.split('_');
    // ticket_close_reason_<ticketId>
    const ticketId = parts.slice(3).join('_');
    const reason   = interaction.fields.getTextInputValue('reason') || '';
    await closeTicket(interaction, ticketId, reason);
}

// ═════════════════════════════════════════════════════════════════════════════
// CLAIM / UNCLAIM
// ═════════════════════════════════════════════════════════════════════════════
/**
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} ticketId
 */
/**
 * Adjust channel permissions for all support roles based on claim state.
 *
 * When claimed:
 *   - CLAIM_SUPPORT_VIEW=false → deny ViewChannel for each support role
 *   - CLAIM_SUPPORT_TYPE=false → deny SendMessages for each support role
 *   - claimerId always gets explicit ViewChannel + SendMessages allow
 *
 * When unclaimed: restore original allow overwrites for every support role.
 */
async function _applyClaimPermissions(channel, ticketData, panel, claimerId, claiming) {
    if (!channel?.permissionOverwrites) return;

    const general      = ticketData?.general || {};
    const supportView  = general.CLAIM_SUPPORT_VIEW !== false; // default true
    const supportType  = general.CLAIM_SUPPORT_TYPE !== false; // default true

    // Collect all unique support role IDs
    const supportRoles = [
        ...(Array.isArray(ticketData?.supportRoles) ? ticketData.supportRoles : []),
        ...(Array.isArray(panel?.supportRoles)       ? panel.supportRoles      : []),
    ].filter((v, i, a) => v && a.indexOf(v) === i);

    const edits = [];

    if (claiming) {
        // Give the claimer explicit SendMessages + ViewChannel
        edits.push(
            channel.permissionOverwrites.edit(claimerId, {
                ViewChannel:        true,
                SendMessages:       true,
                ReadMessageHistory: true,
            }).catch(() => {})
        );

        // Adjust other support roles based on settings
        for (const roleId of supportRoles) {
            const overwrite = {};
            if (!supportView) overwrite.ViewChannel  = false;
            if (!supportType) overwrite.SendMessages = false;
            if (Object.keys(overwrite).length > 0) {
                edits.push(channel.permissionOverwrites.edit(roleId, overwrite).catch(() => {}));
            }
        }
    } else {
        // Unclaim: restore full access for all support roles
        for (const roleId of supportRoles) {
            edits.push(
                channel.permissionOverwrites.edit(roleId, {
                    ViewChannel:        true,
                    SendMessages:       true,
                    ReadMessageHistory: true,
                    ManageMessages:     true,
                }).catch(() => {})
            );
        }
        // Remove the claimer's explicit overwrite (they revert to their role permissions)
        if (claimerId) edits.push(channel.permissionOverwrites.delete(claimerId).catch(() => {}));
    }

    await Promise.all(edits);
}

async function claimTicket(interaction, ticketId) {
    const guildId = interaction.guildId;
    const otDb    = await guildDb.readAsync(guildId, 'open_tickets', { tickets: [] });
    const idx     = otDb.tickets.findIndex(t => t.id === ticketId);

    if (idx === -1) return interaction.reply({ content: '❌ Ticket not found.', flags: MessageFlags.Ephemeral });

    const ticketData = guildDb.read(guildId, 'tickets', null);
    const panel      = ticketData?.panels?.find(p => p.id === otDb.tickets[idx].panelId);

    // ─ Permission check ───────────────────────────────────────────────────
    if (!_isStaff(interaction.member, panel, ticketData)) {
        return interaction.reply({
            content: '❌ You do not have permission to claim this ticket.',
            flags:   MessageFlags.Ephemeral,
        });
    }

    if (otDb.tickets[idx].claimedBy) {
        return interaction.reply({
            content: `❌ Already claimed by <@${otDb.tickets[idx].claimedBy}>.`,
            flags:   MessageFlags.Ephemeral,
        });
    }

    otDb.tickets[idx].claimedBy = interaction.user.id;
    otDb.tickets[idx].claimedAt = new Date().toISOString();
    guildDb.write(guildId, 'open_tickets', otDb);
    ticketStats.onTicketClaim(guildId, otDb.tickets[idx]);

    // ─ Apply claim permissions ────────────────────────────────────────────
    await _applyClaimPermissions(interaction.channel, ticketData, panel, interaction.user.id, true);

    // Move to awaiting category if configured
    if (panel?.awaitingCat && interaction.channel?.setParent) {
        await interaction.channel.setParent(panel.awaitingCat, { lockPermissions: false }).catch(() => {});
    }

    const card = new ContainerBuilder().setAccentColor(0x5865f2);
    card.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`🙋 Ticket claimed by <@${interaction.user.id}>`)
    );
    await interaction.reply({ components: [card], flags: MessageFlags.IsComponentsV2 });
}

async function unclaimTicket(interaction, ticketId) {
    const guildId = interaction.guildId;
    const otDb    = await guildDb.readAsync(guildId, 'open_tickets', { tickets: [] });
    const idx     = otDb.tickets.findIndex(t => t.id === ticketId);

    if (idx === -1) return interaction.reply({ content: '❌ Ticket not found.', flags: MessageFlags.Ephemeral });

    const ticketData = guildDb.read(guildId, 'tickets', null);
    const panel      = ticketData?.panels?.find(p => p.id === otDb.tickets[idx].panelId);

    // ─ Permission check ───────────────────────────────────────────────────
    const claimedBy = otDb.tickets[idx].claimedBy;
    const isAdmin   = interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild);
    // Only the claimer themselves, or a server admin, can unclaim.
    // Regular staff who did NOT claim this ticket cannot unclaim it.
    if (interaction.user.id !== claimedBy && !isAdmin) {
        return interaction.reply({
            content: claimedBy
                ? `❌ Only the staff member who claimed this ticket (<@${claimedBy}>) or an admin can unclaim it.`
                : '❌ This ticket has not been claimed.',
            flags: MessageFlags.Ephemeral,
        });
    }

    otDb.tickets[idx].claimedBy = null;
    guildDb.write(guildId, 'open_tickets', otDb);
    ticketStats.onTicketUnclaim(guildId, otDb.tickets[idx]);

    // ─ Restore permissions ────────────────────────────────────────────────
    await _applyClaimPermissions(interaction.channel, ticketData, panel, claimedBy, false);

    const card = new ContainerBuilder().setAccentColor(0xfee75c);
    card.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`↩️ Ticket unclaimed by <@${interaction.user.id}>`)
    );
    await interaction.reply({ components: [card], flags: MessageFlags.IsComponentsV2 });
}

// ═════════════════════════════════════════════════════════════════════════════
// ADD / REMOVE USER
// ═════════════════════════════════════════════════════════════════════════════
async function handleAddUserButton(interaction, ticketId) {
    const guildId    = interaction.guildId;
    const otDb       = await guildDb.readAsync(guildId, 'open_tickets', { tickets: [] });
    const ticket     = otDb.tickets.find(t => t.id === ticketId);
    const ticketData = guildDb.read(guildId, 'tickets', null);
    const panel      = ticketData?.panels?.find(p => p.id === ticket?.panelId);
    if (!_isStaff(interaction.member, panel, ticketData)) {
        return interaction.reply({ content: '❌ You do not have permission to add users to this ticket.', flags: MessageFlags.Ephemeral });
    }
    const modal = new ModalBuilder()
        .setCustomId(`ticket_adduser_modal_${ticketId}`)
        .setTitle('Add User to Ticket');
    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('userid')
                .setLabel('User ID or @mention')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(30)
        )
    );
    try {
        await interaction.showModal(modal);
    } catch (err) {
        if (err.code !== 10062) throw err;
    }
}

async function handleAddUserModal(interaction) {
    const parts    = interaction.customId.split('_');
    const ticketId = parts.slice(3).join('_');
    const raw      = interaction.fields.getTextInputValue('userid').replace(/\D/g, '');

    let member;
    try {
        member = await interaction.guild.members.fetch(raw);
    } catch {
        return interaction.reply({ content: `❌ Could not find a member with ID \`${raw}\`.`, flags: MessageFlags.Ephemeral });
    }

    try {
        await interaction.channel.permissionOverwrites.edit(member, {
            ViewChannel:        true,
            SendMessages:       true,
            ReadMessageHistory: true,
        });
    } catch (err) {
        logger.error('[ticket_after/addUser] permissionOverwrites error:', err.message);
        return interaction.reply({ content: '❌ Failed to update channel permissions.', flags: MessageFlags.Ephemeral });
    }

    const card = new ContainerBuilder().setAccentColor(0x57f287);
    card.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`✅ Added <@${member.id}> to this ticket.`)
    );
    await interaction.reply({ components: [card], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
}

async function handleRemoveUserButton(interaction, ticketId) {
    const guildId    = interaction.guildId;
    const otDb       = await guildDb.readAsync(guildId, 'open_tickets', { tickets: [] });
    const ticket     = otDb.tickets.find(t => t.id === ticketId);
    const ticketData = guildDb.read(guildId, 'tickets', null);
    const panel      = ticketData?.panels?.find(p => p.id === ticket?.panelId);
    if (!_isStaff(interaction.member, panel, ticketData)) {
        return interaction.reply({ content: '❌ You do not have permission to remove users from this ticket.', flags: MessageFlags.Ephemeral });
    }
    const modal = new ModalBuilder()
        .setCustomId(`ticket_removeuser_modal_${ticketId}`)
        .setTitle('Remove User from Ticket');
    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('userid')
                .setLabel('User ID or @mention')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(30)
        )
    );
    try {
        await interaction.showModal(modal);
    } catch (err) {
        if (err.code !== 10062) throw err;
        // Interaction token expired before we could show the modal — silently ignore.
        // The user can simply click the button again.
    }
}

async function handleRemoveUserModal(interaction) {
    const parts    = interaction.customId.split('_');
    const ticketId = parts.slice(3).join('_');
    const raw      = interaction.fields.getTextInputValue('userid').replace(/\D/g, '');

    // Don't remove the ticket record owner or bot
    const otDb   = await guildDb.readAsync(interaction.guildId, 'open_tickets', { tickets: [] });
    const ticket = otDb.tickets.find(t => t.id === ticketId);
    if (ticket?.userId === raw) {
        return interaction.reply({ content: '❌ Cannot remove the ticket owner.', flags: MessageFlags.Ephemeral });
    }

    try {
        await interaction.channel.permissionOverwrites.edit(raw, { ViewChannel: false });
        const card = new ContainerBuilder().setAccentColor(0xed4245);
        card.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`✅ Removed <@${raw}> from this ticket.`)
        );
        await interaction.reply({ components: [card], flags: MessageFlags.IsComponentsV2 });
    } catch {
        await interaction.reply({ content: `❌ Could not remove member with ID \`${raw}\`.`, flags: MessageFlags.Ephemeral });
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// REFRESH MULTI-PANEL MENU
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Re-sends the multi-panel select menu as an ephemeral reply so the user
 * gets a fresh, unexpired dropdown. customId: ticket_mp_refresh_<mpId>
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} mpId
 */
async function handleMpRefresh(interaction, mpId) {
    const guildId    = interaction.guildId;
    const ticketData = guildDb.read(guildId, 'tickets', null);
    const mp         = ticketData?.multiPanels?.find(m => m.id === mpId);

    if (!mp) {
        return interaction.reply({ content: '❌ Multi-panel not found.', flags: MessageFlags.Ephemeral });
    }

    // Resolve panel slots (same logic as the send route)
    const panels = (mp.panels || []).map((slot, i) => {
        const full = (slot.panelId && ticketData.panels?.find(p => p.id === slot.panelId))
            || ticketData.panels?.find(p => (p.name || p.panelTitle) === slot.name);
        return full ? { ...full, ...slot, panelId: full.id } : { ...slot, _slotIndex: i };
    });

    if (panels.length === 0) {
        return interaction.reply({ content: '❌ No panels configured in this multi-panel.', flags: MessageFlags.Ephemeral });
    }

    const { buildMultiPanelPayload } = require('./tickets');
    const payload = buildMultiPanelPayload(mp, panels);

    // Force ephemeral so only this user sees the refreshed menu
    payload.flags = (payload.flags ?? 0) | MessageFlags.Ephemeral;

    await interaction.reply(payload);
}

// ═════════════════════════════════════════════════════════════════════════════
// INTERACTION ROUTER
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Register all post-open interaction handlers on the Discord client.
 * Call once from index.js.
 *
 * @param {import('discord.js').Client} client
 */
// ═════════════════════════════════════════════════════════════════════════════
// PANEL FORM MODAL
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Shows the panel's question form as a Discord modal.
 * customId: ticket_form_<panelId>
 */
async function _showFormModal(interaction, panelId, panel) {
    const modal = new ModalBuilder()
        .setCustomId(`ticket_form_${panelId}`)
        .setTitle((panel.panelTitle || 'Open Ticket').substring(0, 45));

    const questions = (panel.formQuestions || []).slice(0, 5);
    for (let i = 0; i < questions.length; i++) {
        const q   = questions[i];
        const inp = new TextInputBuilder()
            .setCustomId(`q${i}`)
            .setLabel((q.label || `Question ${i + 1}`).substring(0, 45))
            .setStyle(q.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
            .setRequired(q.required !== false)
            .setMaxLength(q.style === 'paragraph' ? 1000 : 200);
        if (q.placeholder) inp.setPlaceholder(q.placeholder.substring(0, 100));
        modal.addComponents(new ActionRowBuilder().addComponents(inp));
    }
    try {
        await interaction.showModal(modal);
    } catch (err) {
        if (err.code !== 10062) throw err;
    }
}

/**
 * Handles the modal submit: runs all pre-checks, creates channel, posts answers.
 * customId: ticket_form_<panelId>
 */
async function handleFormModal(interaction) {
    const panelId    = interaction.customId.slice('ticket_form_'.length);
    const guildId    = interaction.guildId;
    const user       = interaction.user;
    const member     = interaction.member;
    const ticketData = guildDb.read(guildId, 'tickets', null);
    const panel      = ticketData?.panels?.find(p => p.id === panelId);

    if (!panel) {
        return interaction.reply({ content: '\u274c Panel not found.', flags: MessageFlags.Ephemeral });
    }

    // Collect answers
    const answers = (panel.formQuestions || []).slice(0, 5).map((q, i) => ({
        label:  q.label || `Question ${i + 1}`,
        answer: (() => { try { return interaction.fields.getTextInputValue(`q${i}`) || ''; } catch { return ''; } })(),
    }));

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // ─ ACL check ──────────────────────────────────────────────────────────
    if (!_passesAcl(panel.acl, member)) {
        return interaction.editReply({ content: '\u274c You do not have permission to open this ticket.' });
    }
    if (panel.disabled) {
        return interaction.editReply({ content: '\u274c This ticket panel is currently disabled.' });
    }

    // ─ Cooldown ────────────────────────────────────────────────────────────────
    if (panel.cooldown > 0) {
        const cdKey = `${panelId}_${user.id}`;
        const cds   = guildDb.read(guildId, 'ticket_cooldowns', {});
        const last  = cds[cdKey];
        if (last) {
            const elapsed = Date.now() - new Date(last).getTime();
            const total   = panel.cooldown * 1000;
            if (elapsed < total) {
                const left = Math.ceil((total - elapsed) / 1000);
                const unit = left >= 60 ? `${Math.ceil(left / 60)}m` : `${left}s`;
                return interaction.editReply({ content: `\u23f3 You are on cooldown. Try again in **${unit}**.` });
            }
        }
        cds[cdKey] = new Date().toISOString();
        guildDb.write(guildId, 'ticket_cooldowns', cds);
    }

    // ─ Max open ───────────────────────────────────────────────────────────────
    if (panel.maxOpen > 0) {
        const otDb = await guildDb.readAsync(guildId, 'open_tickets', { tickets: [] });
        const open = otDb.tickets.filter(
            t => t.userId === user.id && t.panelId === panelId && t.status === 'open'
        );
        if (open.length >= panel.maxOpen) {
            const ch = open[0].channelId ? `<#${open[0].channelId}>` : 'your existing ticket';
            return interaction.editReply({ content: `\u274c You already have an open ticket: ${ch}` });
        }
    }

    // ─ Create channel ─────────────────────────────────────────────────────────
    const guild        = interaction.guild;
    const ticketNumber = await _nextTicketNumber(guildId);
    const channelName  = _buildChannelName(panel, user, ticketNumber, ticketData);
    const ticketChannel = panel.threadMode
        ? await _createThread(guild, panel, channelName, user)
        : await _createChannel(guild, panel, channelName, user, ticketData);

    if (!ticketChannel) {
        return interaction.editReply({ content: '\u274c Could not create ticket channel. Please contact an admin.' });
    }

    // ─ Persist record ─────────────────────────────────────────────────────────
    const ticketId = `tkt_${Date.now()}`;
    const record   = {
        id:                     ticketId,
        number:                 ticketNumber,
        panelId,
        guildId,
        channelId:              ticketChannel.id,
        userId:                 user.id,
        claimedBy:              null,
        status:                 'open',
        openedAt:               new Date().toISOString(),
        closedAt:               null,
        closedBy:               null,
        closeReason:            null,
        transcriptPath:         null,
        transcriptChannelMsgId: null,
    };
    const otDb2 = await guildDb.readAsync(guildId, 'open_tickets', { tickets: [], nextNumber: 1 });
    otDb2.tickets.push(record);
    otDb2.nextNumber = ticketNumber + 1;
    guildDb.write(guildId, 'open_tickets', otDb2);

    // ─ Welcome message ───────────────────────────────────────────────────────
    await _sendWelcomeMessage(ticketChannel, panel, ticketData, user, record);

    // ─ Post form answers in ticket channel ────────────────────────────────────
    const filledAnswers = answers.filter(a => a.answer);
    if (filledAnswers.length > 0) {
        const ansCard = new ContainerBuilder().setAccentColor(0x5865f2);
        ansCard.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `## \ud83d\udccb Form Answers \u2014 <@${user.id}>`
            )
        );
        ansCard.addSeparatorComponents(new SeparatorBuilder());
        const lines = answers.map(a =>
            `> **${a.label}**\n> ${a.answer ? a.answer.replace(/\n/g, '\n> ') : '*\u2014*'}`
        );
        ansCard.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(lines.join('\n\n'))
        );
        await ticketChannel.send({ components: [ansCard], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
    }

    // ─ Reply to user ──────────────────────────────────────────────────────────
    const reply = new ContainerBuilder()
        .setAccentColor(_hex(panel.welcomeColor) ?? _hex(ticketData?.general?.COLOR_SUCCESS) ?? 0x57f287);
    reply.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`\u2705 Your ticket has been created: <#${ticketChannel.id}>`)
    );
    await interaction.editReply({ components: [reply], flags: MessageFlags.IsComponentsV2 });
}

function registerAfterHandlers(client) {
    client.on('interactionCreate', async interaction => {
        try {
            // ── Buttons ────────────────────────────────────────────────────
            if (interaction.isButton()) {
                const id = interaction.customId;

                if (id.startsWith('ticket_close_')) {
                    return await closeTicket(interaction, id.slice('ticket_close_'.length));
                }
                if (id.startsWith('ticket_claim_')) {
                    return await claimTicket(interaction, id.slice('ticket_claim_'.length));
                }
                if (id.startsWith('ticket_unclaim_')) {
                    return await unclaimTicket(interaction, id.slice('ticket_unclaim_'.length));
                }
                if (id.startsWith('ticket_add_')) {
                    return await handleAddUserButton(interaction, id.slice('ticket_add_'.length));
                }
                if (id.startsWith('ticket_remove_')) {
                    return await handleRemoveUserButton(interaction, id.slice('ticket_remove_'.length));
                }
                if (id.startsWith('ticket_mp_refresh_')) {
                    return await handleMpRefresh(interaction, id.slice('ticket_mp_refresh_'.length));
                }
                if (id.startsWith('ticket_rules_')) {
                    return await handleRulesButton(interaction, id.slice('ticket_rules_'.length));
                }
                if (id.startsWith('ticket_escalate_') && !id.startsWith('ticket_escalate_sel_')) {
                    return await handleEscalateButton(interaction, id.slice('ticket_escalate_'.length));
                }
            }

            // ── String Select Menus ────────────────────────────────────────
            if (interaction.isStringSelectMenu()) {
                const id = interaction.customId;
                if (id.startsWith('ticket_action_sel_')) {
                    return await handleActionSelect(interaction, id.slice('ticket_action_sel_'.length));
                }
                if (id.startsWith('ticket_escalate_sel_')) {
                    return await handleEscalateSelect(interaction);
                }
            }

            // ── Modals ─────────────────────────────────────────────────────
            if (interaction.isModalSubmit()) {
                const id = interaction.customId;

                if (id.startsWith('ticket_form_')) {
                    return await handleFormModal(interaction);
                }
                if (id.startsWith('ticket_close_reason_')) {
                    return await handleCloseReasonModal(interaction);
                }
                if (id.startsWith('ticket_adduser_modal_')) {
                    return await handleAddUserModal(interaction);
                }
                if (id.startsWith('ticket_removeuser_modal_')) {
                    return await handleRemoveUserModal(interaction);
                }
            }
        } catch (err) {
            // 10062 = Unknown interaction (token expired — nothing we can do)
            if (err.code === 10062) return;
            logger.error('[ticket_after]', err);
            const msg = { content: '❌ An error occurred.', flags: MessageFlags.Ephemeral };
            if (interaction.replied || interaction.deferred) interaction.followUp(msg).catch(() => {});
            else interaction.reply(msg).catch(() => {});
        }
    });

    logger.info('[Tickets] After-open handlers registered');
}

// ═════════════════════════════════════════════════════════════════════════════
// RULES BUTTON
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Shows the server rules as an ephemeral Components V2 reply.
 * customId: ticket_rules_<guildId>  (permanent — not tied to a ticket instance)
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} guildId
 */
async function handleRulesButton(interaction, guildId) {
    const ticketData = guildDb.read(guildId, 'tickets', null);
    const rulesText  = ticketData?.general?.RULES_BTN_TEXT;

    if (!rulesText) {
        return interaction.reply({
            content: '❌ Rules text has not been configured yet.',
            flags: MessageFlags.Ephemeral,
        });
    }

    const card = new ContainerBuilder()
        .setAccentColor(_hex(ticketData.general?.COLOR_SUCCESS) ?? 0x5865f2);
    card.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`## 📜 Server Rules`)
    );
    card.addSeparatorComponents(new SeparatorBuilder());
    card.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(rulesText)
    );

    await interaction.reply({
        components: [card],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Returns true if the member is considered "staff" for this ticket:
 *   – has ManageGuild permission, OR
 *   – has a global support role, OR
 *   – has a panel-level support role
 */
function _isStaff(member, panel, ticketData) {
    if (!member) return false;
    const globalRoles = Array.isArray(ticketData?.supportRoles) ? ticketData.supportRoles : [];
    const panelRoles  = Array.isArray(panel?.supportRoles)       ? panel.supportRoles      : [];
    // When explicit support roles are configured, ONLY those roles grant staff access.
    // ManageGuild bypass is intentionally skipped — it lets server admins use tickets
    // as regular users when support roles are defined.
    if (globalRoles.length === 0 && panelRoles.length === 0) {
        if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
    }
    if (globalRoles.some(r => member.roles?.cache?.has(r))) return true;
    if (panelRoles.some(r => member.roles?.cache?.has(r)))  return true;
    return false;
}

function _passesAcl(acl, member) {
    if (!Array.isArray(acl) || acl.length === 0) return true;
    const denies = acl.filter(r => r.action === 'deny');
    const allows = acl.filter(r => r.action === 'allow');
    for (const rule of denies) {
        if (_matchesRule(rule, member)) return false;
    }
    if (allows.length > 0) return allows.some(r => _matchesRule(r, member));
    return true;
}

function _matchesRule(rule, member) {
    if (rule.type === 'user') return member.id === rule.target;
    if (rule.type === 'role') return member.roles.cache.has(rule.target);
    return false;
}

async function _nextTicketNumber(guildId) {
    const db = await guildDb.readAsync(guildId, 'open_tickets', { tickets: [], nextNumber: 1 });
    return db.nextNumber ?? (db.tickets.length + 1);
}

function _buildChannelName(panel, user, number, ticketData) {
    const mode         = panel.namingMode || 'global';
    const globalScheme = ticketData?.general?.NAMING_SCHEME || 'ticket-{number}';
    const template     = mode === 'custom'
        ? (panel.namingCustom || globalScheme)
        : globalScheme;
    return template
        .replace('{number}',   String(number).padStart(4, '0'))
        .replace('{username}', user.username.toLowerCase().replace(/[^a-z0-9]/g, ''))
        .replace('{userid}',   user.id)
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 100) || `ticket-${String(number).padStart(4,'0')}`;
}

function _buildPermissionOverwrites(guild, panel, user, ticketData) {
    const overwrites = [
        { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
        {
            id:    user.id,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.AttachFiles,
            ],
        },
    ];

    // Global support roles
    if (Array.isArray(ticketData?.supportRoles)) {
        for (const roleId of ticketData.supportRoles) {
            if (!roleId) continue;
            overwrites.push({
                id:    roleId,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.ManageMessages,
                ],
            });
        }
    }

    // Panel-level support roles (full management access)
    if (Array.isArray(panel.supportRoles)) {
        for (const roleId of panel.supportRoles) {
            if (!roleId) continue;
            overwrites.push({
                id:    roleId,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.ManageMessages,
                ],
            });
        }
    }

    // Panel-level ACL: allow-listed roles get view access
    if (Array.isArray(panel.acl)) {
        for (const rule of panel.acl) {
            if (rule.action === 'allow' && rule.type === 'role' && rule.target) {
                overwrites.push({
                    id:    rule.target,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                    ],
                });
            }
        }
    }

    return overwrites;
}

async function _createChannel(guild, panel, name, user, ticketData) {
    try {
        return await guild.channels.create({
            name,
            type:                 ChannelType.GuildText,
            parent:               panel.category || ticketData?.general?.CHANNEL_CATEGORY || null,
            permissionOverwrites: _buildPermissionOverwrites(guild, panel, user, ticketData),
            topic:                `Ticket for ${user.tag} | Opened: ${new Date().toUTCString()}`,
        });
    } catch (err) {
        logger.error('[ticket_after] Channel create error:', err.message);
        return null;
    }
}

async function _createThread(guild, panel, name, user) {
    const parentChannel = guild.channels.cache.get(panel.panelChannel)
        ?? await guild.channels.fetch(panel.panelChannel).catch(() => null);
    if (!parentChannel) return null;
    try {
        const thread = await parentChannel.threads.create({
            name,
            type:      ChannelType.PrivateThread,
            invitable: false,
            reason:    `Ticket opened by ${user.tag}`,
        });
        await thread.members.add(user.id).catch(() => {});
        return thread;
    } catch (err) {
        logger.error('[ticket_after] Thread create error:', err.message);
        return null;
    }
}

async function _sendWelcomeMessage(channel, panel, ticketData, user, record) {
    const container = new ContainerBuilder()
        .setAccentColor(_hex(panel.welcomeColor) ?? _hex(panel.panelColor) ?? _hex(ticketData?.general?.COLOR_SUCCESS) ?? 0x5865f2);

    // Author line
    if (panel.welcomeAuthor) {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`-# ${panel.welcomeAuthor}`)
        );
    }

    // Title
    const wTitle = (panel.welcomeTitle || `Ticket \`#${String(record.number).padStart(4,'0')}\``)
        .replace('{user}',     user.username)
        .replace('{number}',   String(record.number).padStart(4,'0'));
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`## ${wTitle}`)
    );

    // Description
    const wDesc = (panel.welcomeDesc || 'Support will be with you shortly. Please describe your issue.')
        .replace('{user}',     `<@${user.id}>`)
        .replace('{username}', user.username)
        .replace('{number}',   String(record.number).padStart(4,'0'));
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(wDesc)
    );

    container.addSeparatorComponents(new SeparatorBuilder());

    // ─ Action buttons / select menu ──────────────────────────────────────────
    const _hideClos = panel.hideClose  ?? ticketData?.general?.HIDE_CLOSE_BTN  ?? false;
    const _hideClm  = panel.hideClaim  ?? ticketData?.general?.HIDE_CLAIM_BTN  ?? false;
    const _ab       = panel.actionBtns || {};
    const _abMode   = panel.actionBtnsMode || 'buttons';

    // Build ordered list of visible actions
    const _actions = [];
    if (!_hideClos) _actions.push({ key: 'close',   id: `ticket_close_${record.id}`,   label: 'Close',       defEmoji: '🔒', defStyle: ButtonStyle.Danger     });
    if (!_hideClm)  _actions.push(
        { key: 'claim',   id: `ticket_claim_${record.id}`,   label: 'Claim',       defEmoji: '🙋', defStyle: ButtonStyle.Primary    },
        { key: 'unclaim', id: `ticket_unclaim_${record.id}`, label: 'Unclaim',     defEmoji: '↩️', defStyle: ButtonStyle.Secondary  }
    );
    _actions.push(
        { key: 'add',    id: `ticket_add_${record.id}`,    label: 'Add User',    defEmoji: '➕', defStyle: ButtonStyle.Secondary },
        { key: 'remove', id: `ticket_remove_${record.id}`, label: 'Remove User', defEmoji: '➖', defStyle: ButtonStyle.Secondary }
    );

    if (_abMode === 'select') {
        // Single select menu containing all visible actions as options
        const selOptions = _actions.map(a => {
            const cfg   = _ab[a.key] || {};
            const emoji = (cfg.emoji || '').trim() || a.defEmoji;
            const opt   = new StringSelectMenuOptionBuilder().setLabel(a.label).setValue(a.key);
            try { opt.setEmoji(emoji); } catch (_) { /* invalid emoji — skip */ }
            return opt;
        });
        const menu = new StringSelectMenuBuilder()
            .setCustomId(`ticket_action_sel_${record.id}`)
            .setPlaceholder('⚙️ Actions...')
            .addOptions(selOptions);
        container.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
        // Rules + Escalate shown as a separate button row even in select mode
        const _extraBtns = [];
        if (ticketData?.general?.RULES_BTN_ENABLED && ticketData.general.RULES_BTN_TEXT) {
            const rEmoji   = (ticketData.general.RULES_BTN_EMOJI || '').trim();
            const rStyle   = Number(ticketData.general.RULES_BTN_STYLE) || ButtonStyle.Secondary;
            const rLabel   = (ticketData.general.RULES_BTN_LABEL || '').trim() || 'Rules';
            const rBtn     = new ButtonBuilder()
                .setCustomId(`ticket_rules_${record.guildId}`)
                .setLabel(rLabel)
                .setStyle(rStyle);
            if (rEmoji) rBtn.setEmoji(rEmoji); else rBtn.setEmoji('📜');
            _extraBtns.push(rBtn);
        }
        if (ticketData?.general?.ESCALATE_ENABLED &&
            Array.isArray(ticketData?.general?.ESCALATE_CATEGORIES) &&
            ticketData.general.ESCALATE_CATEGORIES.length > 0) {
            _extraBtns.push(new ButtonBuilder().setCustomId(`ticket_escalate_${record.id}`).setLabel('⬆️ Escalate').setStyle(ButtonStyle.Secondary));
        }
        if (_extraBtns.length > 0) {
            container.addActionRowComponents(new ActionRowBuilder().addComponents(..._extraBtns));
        }
    } else {
        // Buttons mode — build each action button with custom emoji / style / labelMode
        const btns = _actions.map(a => {
            const cfg       = _ab[a.key] || {};
            const rawEmoji  = (cfg.emoji || '').trim();
            const labelMode = cfg.labelMode || 'both';
            const style     = Number(cfg.style) || a.defStyle;
            let displayLabel;
            if      (labelMode === 'emoji_only') displayLabel = rawEmoji || a.defEmoji;
            else if (labelMode === 'text_only')  displayLabel = a.label;
            else                                 displayLabel = rawEmoji ? `${rawEmoji} ${a.label}` : `${a.defEmoji} ${a.label}`;
            return new ButtonBuilder().setCustomId(a.id).setLabel(displayLabel).setStyle(style);
        });

        // Rules button — configurable emoji / style / label
        if (ticketData?.general?.RULES_BTN_ENABLED && ticketData.general.RULES_BTN_TEXT) {
            const rEmoji  = (ticketData.general.RULES_BTN_EMOJI  || '').trim();
            const rStyle  = Number(ticketData.general.RULES_BTN_STYLE)  || ButtonStyle.Secondary;
            const rLabel  = (ticketData.general.RULES_BTN_LABEL || '').trim() || 'Rules';
            const rBtn    = new ButtonBuilder()
                .setCustomId(`ticket_rules_${record.guildId}`)
                .setLabel(rLabel)
                .setStyle(rStyle);
            if (rEmoji) rBtn.setEmoji(rEmoji); else rBtn.setEmoji('📜');
            btns.push(rBtn);
        }
        if (ticketData?.general?.ESCALATE_ENABLED &&
            Array.isArray(ticketData?.general?.ESCALATE_CATEGORIES) &&
            ticketData.general.ESCALATE_CATEGORIES.length > 0) {
            btns.push(
                new ButtonBuilder()
                    .setCustomId(`ticket_escalate_${record.id}`)
                    .setLabel('⬆️ Escalate')
                    .setStyle(ButtonStyle.Secondary)
            );
        }

        // Discord allows max 5 buttons per action row
        for (let i = 0; i < btns.length; i += 5) {
            container.addActionRowComponents(
                new ActionRowBuilder().addComponents(...btns.slice(i, i + 5))
            );
        }
    }

    // Footer
    const footerParts = [];
    if (panel.welcomeFooter)    footerParts.push(panel.welcomeFooter);
    if (panel.welcomeTimestamp) footerParts.push(`<t:${Math.floor(Date.now() / 1000)}:f>`);
    if (footerParts.length) {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`-# ${footerParts.join('  •  ')}`)
        );
    }

    // Build support-role mentions as a TextDisplay (content field is banned with V2)
    const mentions = [];
    if (panel.mentionRole)                       mentions.push(`<@&${panel.mentionRole}>`);
    if (Array.isArray(ticketData?.supportRoles)) {
        for (const r of ticketData.supportRoles) {
            if (r) mentions.push(`<@&${r}>`);
        }
    }
    if (mentions.length) {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(mentions.join(' '))
        );
    }

    await channel.send({
        components: [container],
        flags:      MessageFlags.IsComponentsV2,
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// ESCALATE BUTTON
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Shows an ephemeral select menu with all configured escalation categories.
 * Splits into chunks of 25 if needed (up to 5 rows / 125 cats total).
 * customId: ticket_escalate_<ticketId>
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} ticketId
 */
async function handleEscalateButton(interaction, ticketId) {
    const guildId    = interaction.guildId;
    const ticketData = guildDb.read(guildId, 'tickets', null);
    const cats       = ticketData?.general?.ESCALATE_CATEGORIES;

    if (!Array.isArray(cats) || cats.length === 0) {
        return interaction.reply({ content: '❌ No escalation categories configured.', flags: MessageFlags.Ephemeral });
    }

    // ── Role-based permission check ─────────────────────────────────
    const allowedRoles = ticketData?.general?.ESCALATE_ROLES;
    if (Array.isArray(allowedRoles) && allowedRoles.length > 0) {
        const hasRole = interaction.member.roles.cache.some(r => allowedRoles.includes(r.id));
        if (!hasRole) {
            return interaction.reply({
                content: '❌ You don\'t have permission to escalate this ticket.',
                flags: MessageFlags.Ephemeral,
            });
        }
    }

    // Resolve category names from guild channel cache
    const options = cats.slice(0, 125).map(id => {
        const ch = interaction.guild.channels.cache.get(id);
        return { id, name: ch?.name || id };
    });

    // Split into chunks of max 25 options each
    const chunks = [];
    for (let i = 0; i < options.length; i += 25) chunks.push(options.slice(i, i + 25));

    const container = new ContainerBuilder().setAccentColor(0x7c3aed);
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('### ⬆️ Escalate Ticket\nSelect a category to move this ticket to.')
    );
    container.addSeparatorComponents(new SeparatorBuilder());

    for (let ci = 0; ci < Math.min(chunks.length, 5); ci++) {
        const menu = new StringSelectMenuBuilder()
            .setCustomId(`ticket_escalate_sel_${ci}_${ticketId}`)
            .setPlaceholder(
                chunks.length > 1
                    ? `Categories ${ci * 25 + 1}–${ci * 25 + chunks[ci].length}`
                    : 'Select a category...'
            )
            .addOptions(
                chunks[ci].map(c =>
                    new StringSelectMenuOptionBuilder().setLabel(c.name).setValue(c.id)
                )
            );
        container.addActionRowComponents(
            new ActionRowBuilder().addComponents(menu)
        );
    }

    await interaction.reply({
        components: [container],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
}

/**
 * Handles category selection from the escalate select menu.
 * Moves the ticket channel into the chosen category.
 * customId: ticket_escalate_sel_<chunk>_<ticketId>
 *
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
async function handleEscalateSelect(interaction) {
    const categoryId = interaction.values[0];
    const ch         = interaction.guild.channels.cache.get(categoryId);

    try {
        await interaction.channel.setParent(categoryId, { lockPermissions: false });

        // ─ Mark ticket record as escalated ───────────────────────────────
        try {
            const _otDb = await guildDb.readAsync(interaction.guildId, 'open_tickets', { tickets: [] });
            const _idx  = _otDb.tickets.findIndex(t => interaction.channelId === t.channelId);
            if (_idx !== -1) {
                _otDb.tickets[_idx].escalated = true;
                guildDb.write(interaction.guildId, 'open_tickets', _otDb);
            }
        } catch (_e) { /* non-critical */ }

        const card = new ContainerBuilder().setAccentColor(0x57f287);
        card.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `✅ Ticket moved to **${ch?.name ?? categoryId}**`
            )
        );
        await interaction.reply({
            components: [card],
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
    } catch (err) {
        logger.error('[Escalate]', err);
        await interaction.reply({
            content: '❌ Failed to move the ticket. Make sure the bot has **Manage Channels** permission.',
            flags: MessageFlags.Ephemeral,
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// handleActionSelect  –  dispatches select-menu action choices to the relevant
//                        ticket action handler.
// customId: ticket_action_sel_<ticketId>
// ─────────────────────────────────────────────────────────────────────────────
async function handleActionSelect(interaction, ticketId) {
    const action = interaction.values[0];
    if (action === 'close')   return await closeTicket(interaction, ticketId);
    if (action === 'claim')   return await claimTicket(interaction, ticketId);
    if (action === 'unclaim') return await unclaimTicket(interaction, ticketId);
    if (action === 'add')     return await handleAddUserButton(interaction, ticketId);
    if (action === 'remove')  return await handleRemoveUserButton(interaction, ticketId);
    return interaction.reply({ content: '❌ Unknown action.', flags: MessageFlags.Ephemeral });
}

module.exports = {
    openTicket,
    closeTicket,
    claimTicket,
    unclaimTicket,
    handleAddUserButton,
    handleAddUserModal,
    handleRemoveUserButton,
    handleRemoveUserModal,
    handleCloseReasonModal,
    registerAfterHandlers,
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */