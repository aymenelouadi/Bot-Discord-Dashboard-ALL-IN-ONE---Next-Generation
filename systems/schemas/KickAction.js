/*
 * Next Generation — Kick Schema
 * ─────────────────────────────────────────────────────────────────────────────
 * Tracks every kick issued by the bot for moderation audit purposes.
 *
 * Design:
 *   • One document per kick action — kicks are purely historical (no
 *     active/inactive concept since there is no "unkick" action).
 *   • `caseId` is unique per record for cross-referencing.
 *   • Index on (guildId, userId, kickedAt) supports "how many times has this
 *     user been kicked in this guild" queries efficiently.
 */

'use strict';

const { Schema, model } = require('mongoose');

const KickSchema = new Schema({

    guildId:     { type: String, required: true },
    userId:      { type: String, required: true },

    /** Cached username for display */
    username:    { type: String, default: '' },

    reason:      { type: String, default: '' },
    moderatorId: { type: String, required: true },

    /** 8-char case ID */
    caseId:      { type: String, required: true },

    kickedAt:    { type: Date, default: Date.now },

}, {
    timestamps: true,
    versionKey: false,
    collection: 'kicks',
});

// ═══════════════════════════════════════════════════════════════════════════════
// INDEXES
// ═══════════════════════════════════════════════════════════════════════════════

// Per-guild per-user kick history
KickSchema.index({ guildId: 1, userId: 1, kickedAt: -1 });

// Case ID lookup
KickSchema.index({ caseId: 1 }, { unique: true, sparse: true });

// ═══════════════════════════════════════════════════════════════════════════════
// STATIC HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Create a new kick record. */
KickSchema.statics.createRecord = function (data) {
    return new this(data).save();
};

/** Count how many times a user has been kicked in this guild. */
KickSchema.statics.countForUser = function (guildId, userId) {
    return this.countDocuments({ guildId, userId });
};

module.exports = model('Kick', KickSchema);

/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */
