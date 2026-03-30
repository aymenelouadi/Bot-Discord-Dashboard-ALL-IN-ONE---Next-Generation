/*
 * Next Generation — ComponentMessage Schema
 * ─────────────────────────────────────────────────────────────────────────────
 * Stores Discord Components v2 messages: text content + interactive component
 * rows (buttons, select menus) with action pipelines for each interaction.
 *
 * Design:
 *   • One document per saved component message (name + guildId unique).
 *   • `content`    — plain message text (up to 2000 chars).
 *   • `components` — ordered array of action rows (buttons / select menus).
 *   • `actions`    — map of customId → action pipeline definition.
 *   • `messageId`  / `channelId` — set after first send; used to edit.
 */

'use strict';

const { Schema, model } = require('mongoose');

// ── Button sub-schema ───────────────────────────────────────────────────────
const ButtonSchema = new Schema({
    customId:  { type: String, required: true },
    label:     { type: String, default: 'Button' },
    style:     { type: String, enum: ['Primary', 'Secondary', 'Success', 'Danger', 'Link'], default: 'Primary' },
    emoji:     { type: String, default: '' },
    url:       { type: String, default: '' },
    disabled:  { type: Boolean, default: false },
}, { _id: false });

// ── Select menu option sub-schema ───────────────────────────────────────────
const SelectOptionSchema = new Schema({
    label:       { type: String, default: 'Option' },
    value:       { type: String, required: true },
    description: { type: String, default: '' },
    emoji:       { type: String, default: '' },
    default:     { type: Boolean, default: false },
}, { _id: false });

// ── Select menu sub-schema ──────────────────────────────────────────────────
const SelectMenuSchema = new Schema({
    customId:    { type: String, required: true },
    placeholder: { type: String, default: 'Select an option…' },
    minValues:   { type: Number, default: 1 },
    maxValues:   { type: Number, default: 1 },
    disabled:    { type: Boolean, default: false },
    options:     { type: [SelectOptionSchema], default: [] },
}, { _id: false });

// ── Container child sub-schema (no nesting — same fields minus 'container') ──
const ContainerChildSchema = new Schema({
    id:          { type: String, required: true },
    type:        { type: String, enum: ['buttons', 'select', 'text_display', 'separator', 'image'], required: true },
    buttons:     { type: [ButtonSchema], default: [] },
    select:      { type: SelectMenuSchema, default: null },
    text:        { type: String, default: '' },
    divider:     { type: Boolean, default: true },
    spacing:     { type: String, enum: ['Small', 'Large'], default: 'Small' },
    url:         { type: String, default: '' },
    description: { type: String, default: '' },
}, { _id: false });

// ── Component row sub-schema ────────────────────────────────────────────────
const ComponentRowSchema = new Schema({
    id:          { type: String, required: true },
    type:        { type: String, enum: ['buttons', 'select', 'text_display', 'separator', 'container', 'image'], required: true },
    buttons:     { type: [ButtonSchema], default: [] },
    select:      { type: SelectMenuSchema, default: null },
    // text_display
    text:        { type: String, default: '' },
    // separator
    divider:     { type: Boolean, default: true },
    spacing:     { type: String, enum: ['Small', 'Large'], default: 'Small' },
    // container
    accentColor: { type: String, default: '' },
    children:    { type: [ContainerChildSchema], default: [] },
    // image
    url:         { type: String, default: '' },
    description: { type: String, default: '' },
}, { _id: false });

// ── Action step sub-schema ──────────────────────────────────────────────────
const ActionStepSchema = new Schema({
    type: {
        type: String,
        enum: [
            'reply',              // reply in channel (ephemeral or not)
            'send_dm',            // DM the user
            'send_to_channel',    // send to a specific channel
            'add_role',           // grant a role
            'remove_role',        // remove a role
            'toggle_role',        // toggle role on/off
            'edit_message',       // edit the original message
            'disable_component',  // disable the clicked component
            'enable_component',   // re-enable a component
        ],
        required: true,
    },
    /** Reply / DM / send-to-channel text content */
    content:   { type: String, default: '' },
    /** Whether the reply is ephemeral */
    ephemeral: { type: Boolean, default: true },
    /** Target channel ID for send_to_channel */
    channelId: { type: String, default: '' },
    /** Target role ID for add/remove/toggle role */
    roleId:    { type: String, default: '' },
    /** Target customId for disable/enable component */
    targetId:  { type: String, default: '' },
}, { _id: false });

// ── Action pipeline sub-schema ──────────────────────────────────────────────
const ActionPipelineSchema = new Schema({
    customId: { type: String, required: true },
    /** New format: array of conditional rule groups, each with steps */
    rules:    { type: [Schema.Types.Mixed], default: [] },
    /** Legacy flat format kept for backward compatibility */
    steps:    { type: [ActionStepSchema], default: [] },
}, { _id: false, strict: false });

// ── Trigger sub-schema ──────────────────────────────────────────────────────
const TriggerSchema = new Schema({
    id:     { type: String, required: true },
    type:   { type: String, required: true },
    params: { type: Schema.Types.Mixed, default: {} },
}, { _id: false });

// ── Sent-log entry sub-schema ────────────────────────────────────────────────
const SentLogSchema = new Schema({
    channelId:  { type: String, default: '' },
    messageId:  { type: String, default: '' },
    sentAt:     { type: Date, default: Date.now },
}, { _id: false });
// ── State sub-schema (one snapshot in a multi-state flow) ───────────────────
const StateSchema = new Schema({
    id:         { type: String, required: true },
    label:      { type: String, default: 'State' },
    color:      { type: String, default: '#5865f2' },
    content:    { type: String, default: '', maxlength: 4000 },
    components: { type: [ComponentRowSchema], default: [] },
    actions:    { type: [ActionPipelineSchema], default: [] },
}, { _id: false, strict: false });
// ── Root ComponentMessage schema ────────────────────────────────────────────
const ComponentMessageSchema = new Schema({
    guildId:   { type: String, required: true },
    name:      { type: String, required: true, maxlength: 100 },
    content:   { type: String, default: '', maxlength: 2000 },
    channelId: { type: String, default: '' },
    channelIds:{ type: [String], default: [] },
    messageId: { type: String, default: null },

    components: { type: [ComponentRowSchema], default: [] },
    actions:    { type: [ActionPipelineSchema], default: [] },

    /** Multi-state machine: each state has its own content + components + actions */
    states:         { type: [StateSchema],  default: [] },
    initialStateId: { type: String, default: '' },
    /** Shared active-state for non-multiUser flows (updated on each interaction) */
    activeStateId:  { type: String, default: '' },

    /** Flat index of all customIds for O(1) interaction lookup */
    componentIds: { type: [String], default: [] },

    /** Automation flow metadata */
    triggers:      { type: [TriggerSchema], default: [] },
    scheduledAt:   { type: Date, default: null },
    multiUser:     { type: Boolean, default: false },
    timeout:       { type: Number, default: 0 },
    preMentions:   { type: [Schema.Types.Mixed], default: [] },  // [{type:'role'|'special', id, label}]
    sendMode:      { type: String, enum: ['new', 'edit'], default: 'new' },

    /** Log of all Discord messages sent by this automation */
    sentLog: { type: [SentLogSchema], default: [] },

    createdBy: { type: String, default: '' },
    updatedBy: { type: String, default: '' },
}, {
    timestamps: true,
    versionKey: false,
    collection: 'component_messages',
});

ComponentMessageSchema.index({ guildId: 1 });
ComponentMessageSchema.index({ guildId: 1, name: 1 }, { unique: true });
ComponentMessageSchema.index({ guildId: 1, channelId: 1 });
ComponentMessageSchema.index({ guildId: 1, componentIds: 1 });
ComponentMessageSchema.index({ 'triggers.type': 1 });

module.exports = model('ComponentMessage', ComponentMessageSchema);
