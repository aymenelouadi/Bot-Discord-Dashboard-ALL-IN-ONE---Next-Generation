/*
 * Next Generation — Ticket Schema
 * ─────────────────────────────────────────────────────────────────────────────
 * Stores individual support ticket records.
 *
 * Design:
 *   • One document per ticket — ticketId is globally unique.
 *   • `status` drives the lifecycle: open → pending_close → closed.
 *   • `formAnswers` stores answers from any intake form as key-value pairs.
 *   • `claimedBy` tracks which staff member is handling the ticket.
 *   • `rating` records the user's satisfaction score after closing.
 */

'use strict';

const { Schema, model } = require('mongoose');

const TicketSchema = new Schema({

    /** Unique ticket identifier (e.g. "ticket-0042" or a UUID) */
    ticketId: { type: String, required: true, unique: true },

    /** Discord guild ID where the ticket was created */
    guildId: { type: String, required: true },

    /** Discord user ID who opened the ticket */
    userId: { type: String, required: true },

    /** Discord channel ID for the ticket thread/channel */
    channelId: { type: String, default: null },

    /** ID of the ticket panel that was used to open this ticket */
    panelId: { type: String, default: null },

    /** Ticket category / type label (e.g. "support", "billing") */
    category: { type: String, default: '' },

    /** Lifecycle status */
    status: {
        type: String,
        enum: ['open', 'closed', 'pending_close'],
        default: 'open',
    },

    /** Staff member ID who claimed this ticket (null = unclaimed) */
    claimedBy: { type: String, default: null },

    /** ISO timestamp of when the ticket was claimed */
    claimedAt: { type: Date, default: null },

    /** ISO timestamp of when the ticket was closed */
    closedAt: { type: Date, default: null },

    /** Staff member who closed the ticket */
    closedBy: { type: String, default: null },

    /** Answers provided via the ticket intake form */
    formAnswers: { type: Schema.Types.Mixed, default: {} },

    /** User's satisfaction rating (1–5) after ticket is closed */
    rating: { type: Number, min: 1, max: 5, default: null },

    /** Optional transcript storage ID / URL */
    transcriptUrl: { type: String, default: null },

    /** Sequential ticket number within the guild (e.g. 1, 2, 3…) */
    number: { type: Number, default: null },

    /** Reason provided when the ticket was closed */
    closeReason: { type: String, default: null },

}, {
    timestamps: true,
    versionKey: false,
    collection: 'tickets',
});

TicketSchema.index({ guildId: 1, status: 1 });
TicketSchema.index({ guildId: 1, userId: 1 });
TicketSchema.index({ guildId: 1, number: 1 });

// ═══════════════════════════════════════════════════════════════════════════════
// STATIC HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Close a ticket and record who closed it. */
TicketSchema.statics.close = function (ticketId, closedBy) {
    return this.findOneAndUpdate(
        { ticketId },
        { $set: { status: 'closed', closedBy, closedAt: new Date() } },
        { new: true }
    );
};

/** Claim a ticket for a staff member (sets claimedBy + claimedAt). */
TicketSchema.statics.claim = function (ticketId, staffId) {
    return this.findOneAndUpdate(
        { ticketId },
        { $set: { claimedBy: staffId, claimedAt: new Date() } },
        { new: true }
    );
};

/** Fetch all open tickets in a guild (bot restart restore + dashboard). */
TicketSchema.statics.findOpen = function (guildId) {
    return this.find({ guildId, status: 'open' }).lean();
};

/**
 * Count tickets grouped by lifecycle status.
 * @returns {Promise<Array<{ _id: string, count: number }>>}
 */
TicketSchema.statics.countByStatus = function (guildId) {
    return this.aggregate([
        { $match: { guildId } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
};

// ── Virtuals ───────────────────────────────────────────────────────────────────
TicketSchema.virtual('isOpen').get(function ()   { return this.status === 'open'; });
TicketSchema.virtual('isClosed').get(function () { return this.status === 'closed'; });

module.exports = model('Ticket', TicketSchema);

/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */
