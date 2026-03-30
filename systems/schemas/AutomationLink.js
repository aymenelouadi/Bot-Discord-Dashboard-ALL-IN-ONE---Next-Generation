'use strict';

/**
 * AutomationLink — Cross-message automation links.
 *
 * Links a button click on a source message (EmbedMessage or ComponentMessage)
 * to trigger sending a target message (the other type or same type).
 *
 * sourceButtonId = '' means ANY button/select in the source document triggers the link.
 * sourceButtonId = specific customId means only that button triggers the link.
 */

const { Schema, model } = require('mongoose');

const AutomationLinkSchema = new Schema({
    guildId:        { type: String, required: true },
    name:           { type: String, default: 'Untitled Link' },
    sourceKind:     { type: String, enum: ['embed', 'component'], required: true },
    sourceId:       { type: String, required: true },
    sourceButtonId: { type: String, default: '' }, // '' = any button in the source doc
    targetKind:     { type: String, enum: ['embed', 'component'], required: true },
    targetId:       { type: String, required: true },
    sendMode:       {
        type:    String,
        enum:    ['reply', 'reply_ephemeral', 'new_message', 'update_message'],
        default: 'reply',
    },
    enabled:   { type: Boolean, default: true },
    createdBy: { type: String, default: '' },
}, {
    timestamps: true,
});

AutomationLinkSchema.index({ guildId: 1 });
AutomationLinkSchema.index({ sourceId: 1, enabled: 1 });

module.exports = model('AutomationLink', AutomationLinkSchema);

/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */
