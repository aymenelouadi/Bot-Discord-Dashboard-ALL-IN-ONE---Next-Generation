'use strict';

const { Schema, model } = require('mongoose');

/**
 * Global bot configuration — replaces writing to settings.json at runtime.
 *
 * One document per `key` (e.g. 'global_settings').
 * On startup, the JSON baseline is loaded first, then MongoDB overrides are
 * deep-merged on top so user commands modify storage without touching the file.
 */
const GlobalConfigSchema = new Schema({
    key:  { type: String, required: true, unique: true },
    data: { type: Schema.Types.Mixed, default: {} },
}, {
    timestamps: true,
    versionKey: false,
    collection: 'global_config',
});

module.exports = model('GlobalConfig', GlobalConfigSchema);
