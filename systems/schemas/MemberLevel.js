/*
 * Next Generation — MemberLevel Schema
 * ─────────────────────────────────────────────────────────────────────────────
 * Tracks XP, message count, voice time and computed levels for every member
 * in every guild.
 *
 * Design:
 *   • One document per (guildId, userId) pair — compound unique index.
 *   • Separate text-track and voice-track fields to support independent modes:
 *       XP mode      → textXP  / voiceXP
 *       MESSAGES mode → textMessages
 *       MINUTES mode  → voiceMinutes
 *   • Denormalized `textLevel` / `voiceLevel` fields for O(1) leaderboard
 *     queries without recomputing from XP on every read.
 *   • `voiceJoinedAt` stores the moment a member entered a voice channel so
 *     the system can award minutes on voiceStateUpdate leave event.
 *   • `lastTextTime` epoch-ms for message
 *  cooldown enforcement.
 */

'use strict';

const { Schema, model } = require('mongoose');

const MemberLevelSchema = new Schema({

    guildId: { type: String, required: true },
    userId:  { type: String, required: true },

    // ── Text activity ────────────────────────────────────────────────────────
    /** Cumulative XP gained from text messages (XP mode) */
    textXP:       { type: Number, default: 0, min: 0 },
    /** Total messages sent that counted toward leveling (MESSAGES mode) */
    textMessages: { type: Number, default: 0, min: 0 },
    /** Denormalized current text level — updated on every level-up */
    textLevel:    { type: Number, default: 0, min: 0 },
    /** Epoch milliseconds of the last message that awarded XP (cooldown tracking) */
    lastTextTime: { type: Number, default: 0 },

    // ── Voice activity ───────────────────────────────────────────────────────
    /** Cumulative XP gained from voice time (XP mode) */
    voiceXP:       { type: Number, default: 0, min: 0 },
    /** Total voice minutes accumulated (MINUTES mode) */
    voiceMinutes:  { type: Number, default: 0, min: 0 },
    /** Denormalized current voice level */
    voiceLevel:    { type: Number, default: 0, min: 0 },
    /**
     * ISO timestamp set when the member joins a voice channel.
     * Cleared (set to null) on leave after awarding minutes.
     * Sparse index allows efficient "find all members currently in voice" queries.
     */
    voiceJoinedAt: { type: Date, default: null },

    /** Last time this document was touched (for staleness cleanup jobs) */
    lastSeen: { type: Date, default: Date.now },

}, {
    timestamps: true,
    versionKey: false,
    collection: 'member_levels',
});

// ═══════════════════════════════════════════════════════════════════════════════
// INDEXES
// ═══════════════════════════════════════════════════════════════════════════════

// Primary: every read/write goes through (guildId, userId)
MemberLevelSchema.index({ guildId: 1, userId: 1 }, { unique: true });

// Leaderboard: /levels page — top members by text XP, descending
MemberLevelSchema.index({ guildId: 1, textXP: -1 });

// Leaderboard: top members by voice XP
MemberLevelSchema.index({ guildId: 1, voiceXP: -1 });

// Leaderboard: top members by text level (faster than re-sorting XP)
MemberLevelSchema.index({ guildId: 1, textLevel: -1 });

// Voice tracking: find all members currently sitting in a voice channel
// sparse=true so the index only stores docs where voiceJoinedAt != null
MemberLevelSchema.index(
    { guildId: 1, voiceJoinedAt: 1 },
    { sparse: true, name: 'voice_active_members' }
);

// ═══════════════════════════════════════════════════════════════════════════════
// STATIC HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Upsert a member document with default zeroed values if it doesn't exist.
 * @param {string} guildId
 * @param {string} userId
 * @returns {Promise<Document>}
 */
MemberLevelSchema.statics.findOrCreate = async function (guildId, userId) {
    return this.findOneAndUpdate(
        { guildId, userId },
        { $setOnInsert: { guildId, userId } },
        { new: true, upsert: true }
    );
};

/** Increment textXP (XP mode). Returns the updated document. */
MemberLevelSchema.statics.addTextXP = function (guildId, userId, xp) {
    return this.findOneAndUpdate(
        { guildId, userId },
        { $inc: { textXP: xp }, $set: { lastSeen: new Date() } },
        { new: true, upsert: true }
    );
};

/** Increment textMessages counter + optional XP. Updates lastTextTime for cooldown. */
MemberLevelSchema.statics.addTextMessage = function (guildId, userId, xp = 0) {
    return this.findOneAndUpdate(
        { guildId, userId },
        {
            $inc: { textMessages: 1, textXP: xp },
            $set: { lastTextTime: Date.now(), lastSeen: new Date() },
        },
        { new: true, upsert: true }
    );
};

/** Add voice minutes (MINUTES mode) and optional XP (XP mode). */
MemberLevelSchema.statics.addVoiceMinutes = function (guildId, userId, minutes, xp = 0) {
    return this.findOneAndUpdate(
        { guildId, userId },
        { $inc: { voiceMinutes: minutes, voiceXP: xp }, $set: { lastSeen: new Date() } },
        { new: true, upsert: true }
    );
};

/** Record when a member joined a voice channel (for voice-minutes delta calculation). */
MemberLevelSchema.statics.setVoiceJoined = function (guildId, userId) {
    return this.findOneAndUpdate(
        { guildId, userId },
        { $set: { voiceJoinedAt: new Date() } },
        { upsert: true }
    );
};

/** Clear voiceJoinedAt after awarding minutes on channel leave. */
MemberLevelSchema.statics.clearVoiceJoined = function (guildId, userId) {
    return this.findOneAndUpdate(
        { guildId, userId },
        { $set: { voiceJoinedAt: null } }
    );
};

/**
 * Sorted leaderboard for a guild.
 * @param {'text'|'voice'|'textMessages'|'voiceMinutes'} [type='text']
 * @param {number} [limit=10]
 */
MemberLevelSchema.statics.getLeaderboard = function (guildId, type = 'text', limit = 10) {
    const field = (
        { text: 'textXP', voice: 'voiceXP', textMessages: 'textMessages', voiceMinutes: 'voiceMinutes' }
    )[type] ?? 'textXP';
    return this.find({ guildId, [field]: { $gt: 0 } })
        .sort({ [field]: -1 })
        .limit(limit)
        .lean();
};

// ── Virtuals ───────────────────────────────────────────────────────────────────
/** Combined XP from both text and voice tracks. */
MemberLevelSchema.virtual('totalXP').get(function () { return this.textXP + this.voiceXP; });
/** Combined level from both text and voice tracks. */
MemberLevelSchema.virtual('totalLevel').get(function () { return this.textLevel + this.voiceLevel; });

module.exports = model('MemberLevel', MemberLevelSchema);
