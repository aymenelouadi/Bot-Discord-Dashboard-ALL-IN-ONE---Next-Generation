/*
 * Next Generation — Ban Schema
 * ─────────────────────────────────────────────────────────────────────────────
 * Tracks every ban issued by the bot so moderators have a full history.
 *
 * Design:
 *   • One document per ban action (not per user) — a user can be re-banned
 *     after being unbanned, so each action gets its own record.
 *   • `active` flag: true while the user is still banned, false after unban.
 *     Allows querying the current ban state without hitting the Discord API.
 *   • `expiresAt` is null for permanent bans; set for temp-bans so a future
 *     expiry-checker job can auto-lift them.
 *   • `caseId` is unique per record for cross-referencing with other cases.
 *   • `endAll(guildId)` is used by the unban_all command to bulk-mark inactive.
 */

'use strict';

const { Schema, model } = require('mongoose');

const BanSchema = new Schema({

    guildId:     { type: String, required: true },
    userId:      { type: String, required: true },

    /** Cached username for display */
    username:    { type: String, default: '' },

    reason:      { type: String, default: '' },
    moderatorId: { type: String, required: true },

    /** 8-char case ID */
    caseId:      { type: String, required: true },

    /** Duration in milliseconds. null = permanent */
    duration:    { type: Number, default: null },

    bannedAt:    { type: Date, default: Date.now },

    /** null = permanent */
    expiresAt:   { type: Date, default: null },

    /** false once the user is unbanned */
    active:      { type: Boolean, default: true },

}, {
    timestamps: true,
    versionKey: false,
    collection: 'bans',
});

// ═══════════════════════════════════════════════════════════════════════════════
// INDEXES
// ═══════════════════════════════════════════════════════════════════════════════

// Primary: look up active ban for a user in a guild
BanSchema.index({ guildId: 1, userId: 1, active: 1 });

// Case ID lookup
BanSchema.index({ caseId: 1 }, { unique: true, sparse: true });

// Expiry checker: find active temp-bans that have elapsed
BanSchema.index(
    { active: 1, expiresAt: 1 },
    { sparse: true, name: 'ban_expiry_checker' }
);

// ═══════════════════════════════════════════════════════════════════════════════
// STATIC HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Create a new ban record. */
BanSchema.statics.createRecord = function (data) {
    return new this(data).save();
};

/** Mark the currently active ban for a user as ended (unban). */
BanSchema.statics.end = function (guildId, userId) {
    return this.findOneAndUpdate(
        { guildId, userId, active: true },
        { $set: { active: false } },
        { new: true }
    );
};

/** Mark ALL active bans in a guild as ended (unban_all). */
BanSchema.statics.endAll = function (guildId) {
    return this.updateMany(
        { guildId, active: true },
        { $set: { active: false } }
    );
};

/** Find the currently active ban for a user, or null if not banned. */
BanSchema.statics.findActive = function (guildId, userId) {
    return this.findOne({ guildId, userId, active: true }).lean();
};

/** Return all active temp-bans whose expiresAt has elapsed. */
BanSchema.statics.getExpired = function () {
    return this.find({ active: true, expiresAt: { $lte: new Date(), $ne: null } }).lean();
};

module.exports = model('Ban', BanSchema);

/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */
