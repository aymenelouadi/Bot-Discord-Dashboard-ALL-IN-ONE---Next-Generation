'use strict';

/*
 * Next Generation — WelcomeImage Schema
 * ─────────────────────────────────────────────────────────────────────────────
 * Stores the visual welcome-image editor config for each guild.
 * Each layer has a type (text | image) and transform/style properties.
 * The node-canvas renderer reads this to produce PNGs on member join.
 */

const { Schema, model } = require('mongoose');

// ── Layer sub-schema ──────────────────────────────────────────────────────────
const LayerSchema = new Schema({
    id:         { type: String, required: true },
    type:       { type: String, enum: ['text', 'image', 'background'], required: true },
    name:       { type: String, default: '' },
    locked:     { type: Boolean, default: false },
    visible:    { type: Boolean, default: true },

    // Geometry
    x:        { type: Number, default: 0 },
    y:        { type: Number, default: 0 },
    width:    { type: Number, default: 100 },
    height:   { type: Number, default: 40 },
    rotation: { type: Number, default: 0 },   // degrees
    opacity:  { type: Number, default: 1, min: 0, max: 1 },

    // ── Image layer ─────────
    src:          { type: String, default: '' }, // URL or 'dynamic:avatar' | 'dynamic:guild_icon' | 'dynamic:banner'
    borderRadius: { type: Number, default: 0 },  // 0-50 % of min(w,h)
    shape:        { type: String, enum: ['square', 'circle', 'custom'], default: 'square' },
    fit:          { type: String, enum: ['cover', 'contain', 'fill'], default: 'cover' },

    // ── Text layer ──────────
    content:    { type: String, default: '' },   // supports [variables]
    fontSize:   { type: Number, default: 24 },
    fontFamily: { type: String, default: 'Inter' },
    fontWeight: { type: String, default: 'normal' },
    fontStyle:  { type: String, default: 'normal' },
    color:      { type: String, default: '#ffffff' },
    align:      { type: String, enum: ['left', 'center', 'right'], default: 'center' },
    stroke:     { type: String, default: '' },
    strokeWidth:{ type: Number, default: 0 },
    shadow:     { type: Boolean, default: false },
    shadowColor:{ type: String, default: 'rgba(0,0,0,0.7)' },

}, { _id: false });

// ── Main schema ───────────────────────────────────────────────────────────────
const WelcomeImageSchema = new Schema({

    guildId: { type: String, required: true, unique: true },

    enabled: { type: Boolean, default: false },

    /** Which channel to send this image to (channelId or 'dm') */
    channelId: { type: String, default: '' },

    /** Canvas dimensions */
    width:  { type: Number, default: 500 },
    height: { type: Number, default: 350 },

    /** Background fill color (behind all layers) */
    bgColor: { type: String, default: '#060018' },

    /** Ordered layers (index 0 = bottom/background) */
    layers: { type: [LayerSchema], default: [] },

    /** How to deliver: attach a standalone image, put inside embed, or component v2 */
    sendMode: { type: String, enum: ['attachment', 'embed', 'component'], default: 'embed' },

    /** Embed wrapper options (used when sendMode = embed) */
    embedOptions: {
        title:       { type: String, default: '' },
        description: { type: String, default: '' },
        color:       { type: String, default: '#7c3aed' },
        footer:      { type: String, default: '' },
    },

    /** Text content sent above the image when sendMode = component (Component v2) */
    componentText:  { type: String, default: '' },

    /** Optional message text sent alongside the image when sendMode = attachment */
    attachmentText: { type: String, default: '' },

    /** Name of the linked template (embed/component modes inject image into this template's channel) */
    linkedTemplateId: { type: String, default: '' },

    /** URL of an uploaded background image (stored in public/uploads/wi-bg/<guildId>/) */
    uploadedBgUrl: { type: String, default: '' },

    updatedAt: { type: Date, default: Date.now },

}, {
    versionKey: false,
    collection: 'welcome_image_configs',
});

WelcomeImageSchema.index({ guildId: 1 }, { unique: true });

// ── Statics ────────────────────────────────────────────────────────────────────

WelcomeImageSchema.statics.getConfig = async function (guildId) {
    return (await this.findOne({ guildId }).lean()) || {
        guildId,
        enabled:    false,
        channelId:  '',
        width:      500,
        height:     350,
        bgColor:    '#060018',
        layers:     [],
        sendMode:   'embed',
        embedOptions: { title: '', description: '', color: '#7c3aed', footer: '' },
    };
};

WelcomeImageSchema.statics.patch = async function (guildId, patch) {
    return this.findOneAndUpdate(
        { guildId },
        { $set: { ...patch, updatedAt: new Date() } },
        { upsert: true, new: true, lean: true, setDefaultsOnInsert: true }
    );
};

module.exports = model('WelcomeImage', WelcomeImageSchema);
