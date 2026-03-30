'use strict';

/*
 * Next Generation — WelcomeJoin Schema
 * ─────────────────────────────────────────────────────────────────────────────
 * Stores the welcome-message-on-join configuration for each guild.
 *
 * Design:
 *   • One document per guildId (unique).
 *   • Templates array holds every configured message (text / embed / component).
 *   • `findOrCreate` ensures a defaults doc always exists before reading.
 *   • `getConfig` returns a lean plain object for lightweight reading.
 */

const { Schema, model } = require('mongoose');

// ── Sub-schema: activity log entry ───────────────────────────────────────────
const LogEntrySchema = new Schema({
    sentAt:       { type: Date, default: Date.now },
    userId:       { type: String, required: true },
    username:     { type: String, default: '' },
    displayName:  { type: String, default: '' },
    avatarUrl:    { type: String, default: '' },
    templateName: { type: String, default: '' },
    channelId:    { type: String, default: '' },
    type:         { type: String, enum: ['text', 'embed', 'component', 'dm'], default: 'text' },
    status:       { type: String, enum: ['ok', 'error'], default: 'ok' },
    errorMsg:     { type: String, default: '' },
}, { _id: false });

// ── Sub-schema: a randomized group of templates ────────────────────────────
const GroupSchema = new Schema({
    id:            { type: String, required: true },
    name:          { type: String, default: 'Group', trim: true, maxlength: 100 },
    enabled:       { type: Boolean, default: true },
    templateNames: { type: [String], default: [] },
}, { _id: false });

// ── Sub-schema: a single template ────────────────────────────────────────────
const TemplateSchema = new Schema({
    name:          { type: String, default: 'Template', trim: true, maxlength: 100 },
    channelId:     { type: String, required: true },
    type:          { type: String, enum: ['text', 'embed', 'component'], default: 'text' },
    content:       { type: String, default: '', maxlength: 2000 },
    embed: {
        title:       { type: String, default: '' },
        description: { type: String, default: '' },
        thumbnail:   { type: String, default: '' },
        color:       { type: String, default: '#7c3aed' },
        footer:      { type: String, default: '' },
    },
    componentJson: { type: String, default: '' },
    waitRules:     { type: Boolean, default: false },
    ignoreBots:    { type: Boolean, default: false },
    ignoreUsers:   { type: Boolean, default: false },
    sendDelay:     { type: Number,  default: 0, min: 0, max: 300 },
    deleteDelay:   { type: Number,  default: 0, min: 0, max: 3600 },
    enabled:       { type: Boolean, default: true },
}, { _id: false });

// ── Main schema ───────────────────────────────────────────────────────────────
const WelcomeJoinSchema = new Schema({

    /** Discord guild (server) ID */
    guildId: { type: String, required: true },

    /** Master enable/disable switch */
    enabled:     { type: Boolean, default: false },

    /** Show a plain welcome text above the template message */
    welcomeText: { type: Boolean, default: false },

    /** Send a DM to the joining member */
    dmWelcome:   { type: Boolean, default: false },
    dmMessage:   { type: String,  default: '', maxlength: 1024 },

    /** Global delays (seconds) applied when no per-template value is set */
    sendDelay:   { type: Number, default: 0, min: 0, max: 300 },
    deleteDelay: { type: Number, default: 0, min: 0, max: 3600 },

    /** Wait for the member to pass membership screening before sending */
    waitRules:   { type: Boolean, default: false },

    /** Skip sending for bots / regular users */
    ignoreBots:  { type: Boolean, default: false },
    ignoreUsers: { type: Boolean, default: false },

    /** Configured message templates */
    templates: { type: [TemplateSchema], default: [] },

    /** Activity log — capped at 200 entries via pushLog() */
    activityLog: { type: [LogEntrySchema], default: [] },

    /** Randomized groups — each group picks one random template per join */
    groups: { type: [GroupSchema], default: [] },

    updatedAt: { type: Date, default: Date.now },

}, {
    versionKey: false,
    collection: 'welcome_join_configs',
});

// ── Indexes ───────────────────────────────────────────────────────────────────
WelcomeJoinSchema.index({ guildId: 1 }, { unique: true, name: 'welcome_join_guild' });

// ── Statics ───────────────────────────────────────────────────────────────────

/**
 * Return the guild's config doc, creating it with defaults if it doesn't exist.
 * @param {string} guildId
 * @returns {Promise<import('mongoose').Document>}
 */
WelcomeJoinSchema.statics.findOrCreate = async function (guildId) {
    const doc = await this.findOneAndUpdate(
        { guildId },
        { $setOnInsert: { guildId } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return doc;
};

/**
 * Return a lean plain object for the guild config (fast, read-only).
 * Returns safe defaults if no document exists yet.
 * @param {string} guildId
 * @returns {Promise<object>}
 */
WelcomeJoinSchema.statics.getConfig = async function (guildId) {
    return (await this.findOne({ guildId }).lean()) || {
        guildId,
        enabled:     false,
        welcomeText: false,
        dmWelcome:   false,
        dmMessage:   '',
        sendDelay:   0,
        deleteDelay: 0,
        waitRules:   false,
        ignoreBots:  false,
        ignoreUsers: false,
        templates:   [],
        groups:      [],
    };
};

/**
 * Append a log entry, keeping only the last 200.
 * @param {string} guildId
 * @param {object} entry  — LogEntrySchema-shaped object
 */
WelcomeJoinSchema.statics.pushLog = async function (guildId, entry) {
    return this.updateOne(
        { guildId },
        { $push: { activityLog: { $each: [entry], $slice: -200 } } },
        { upsert: true }
    );
};

/**
 * Patch the guild config with the given fields.
 * @param {string} guildId
 * @param {object} patch
 * @returns {Promise<object>} updated lean doc
 */
WelcomeJoinSchema.statics.patch = async function (guildId, patch) {
    return this.findOneAndUpdate(
        { guildId },
        { $set: { ...patch, updatedAt: new Date() } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
};

module.exports = model('WelcomeJoin', WelcomeJoinSchema);
