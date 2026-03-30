/*
 * Next Generation — Guild Schema
 * ─────────────────────────────────────────────────────────────────────────────
 * Master configuration document for each Discord guild.
 *
 * Design:
 *   • One document per guildId — stores all per-guild settings as sub-objects.
 *   • Mirrors the folder structure of dashboard/database/<guildId>/*.json
 *     so that guildDb.js can use a single Guild document as source of truth.
 *   • Sub-schemas are deliberately flexible (Mixed / nested objects) to avoid
 *     migration pain when new settings are added via the dashboard.
 */

'use strict';

const { Schema, model } = require('mongoose');

const GuildSchema = new Schema({

    /** Discord guild (server) ID */
    guildId: { type: String, required: true, unique: true },

    // ── Core system settings (mirrors system.json) ────────────────────────
    system: {
        PREFIX: { type: String, default: '!' },
        COMMANDS: {
            ENABLE_PREFIX:         { type: Boolean, default: true },
            ENABLE_SLASH_COMMANDS: { type: Boolean, default: true },
            ACTIVITY_TYPE:         { type: String,  default: 'none' },
            STATUS:                { type: String,  default: 'ONLINE' },
            lang:                  { type: String,  default: 'en' },
        },
    },

    // ── Command/action settings (mirrors settings.json per-guild overrides) ─
    settings: {
        type: Schema.Types.Mixed,
        default: {},
    },

    // ── Anti-raid / protection config (mirrors protection.json) ──────────
    protection: {
        type: Schema.Types.Mixed,
        default: {},
    },

    // ── Level system config (mirrors settings.json → LEVEL_SYSTEM) ────────
    levelSystem: {
        type: Schema.Types.Mixed,
        default: {},
    },

    // ── Auto-role assignments (mirrors auto_roles.json) ───────────────────
    autoRoles: {
        type: Schema.Types.Mixed,
        default: {},
    },

    // ── Auto-responder triggers (mirrors auto_responder.json per-guild) ───
    autoResponder: {
        enabled:   { type: Boolean, default: false },
        responses: { type: [Schema.Types.Mixed], default: [] },
    },

    // ── Suggestions system config ─────────────────────────────────────────
    suggestionsConfig: {
        type: Schema.Types.Mixed,
        default: {},
    },

    // ── Staff points system config ─────────────────────────────────────────
    staffPointsConfig: {
        type: Schema.Types.Mixed,
        default: {},
    },

    // ── Interaction points system config ──────────────────────────────────
    interactionPointsConfig: {
        type: Schema.Types.Mixed,
        default: {},
    },

    // ── Ticket general config ─────────────────────────────────────────────
    ticketGeneral: {
        type: Schema.Types.Mixed,
        default: {},
    },

    // ── Ticket panel definitions ──────────────────────────────────────────
    ticketPanels: {
        type: [Schema.Types.Mixed],
        default: [],
    },

    // ── Ticket cooldowns (per-user panel cooldowns) ───────────────────────
    ticketCooldowns: {
        type: Schema.Types.Mixed,
        default: {},
    },

    // ── Suggestions runtime data (nextId, userCooldowns, suggestions map) ─
    suggestionsData: {
        type: Schema.Types.Mixed,
        default: {},
    },

    // ── Per-guild hourly activity counters (date → hour → {joins,leaves,messages,voice}) ─
    activityStats: {
        type: Schema.Types.Mixed,
        default: {},
    },

    // ── Aggregate stats ───────────────────────────────────────────────────
    stats: {
        ticketStats: { type: Schema.Types.Mixed, default: {} },
    },

}, {
    timestamps: true,
    versionKey: false,
    collection: 'guilds',
});

// Index is declared via `unique: true` on the field above — no separate .index() needed.

// ═══════════════════════════════════════════════════════════════════════════════
// STATIC HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Upsert a guild document. Safe to call on every interaction without extra reads.
 * @param {string} guildId
 * @returns {Promise<Document>}
 */
GuildSchema.statics.findOrCreate = function (guildId) {
    return this.findOneAndUpdate(
        { guildId },
        { $setOnInsert: { guildId } },
        { new: true, upsert: true }
    );
};

/**
 * Read a single nested field using dot-notation path.
 * e.g. `getField(guildId, 'system.PREFIX')`
 * @param {string} guildId
 * @param {string} field  Dot-notation field path
 * @returns {Promise<*>}  The field value, or null if the guild doesn't exist
 */
GuildSchema.statics.getField = async function (guildId, field) {
    const doc = await this.findOne({ guildId }).select(field).lean();
    if (!doc) return null;
    return field.split('.').reduce((o, k) => o?.[k], doc) ?? null;
};

/**
 * Set a single nested field atomically. Upserts the guild document if needed.
 * e.g. `patchField(guildId, 'system.PREFIX', '!')`
 * @param {string} guildId
 * @param {string} field  Dot-notation field path
 * @param {*}      data   New value
 * @returns {Promise<Document>}
 */
GuildSchema.statics.patchField = function (guildId, field, data) {
    return this.findOneAndUpdate(
        { guildId },
        { $set: { guildId, [field]: data } },
        { new: true, upsert: true }
    );
};

module.exports = model('Guild', GuildSchema);

/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */
