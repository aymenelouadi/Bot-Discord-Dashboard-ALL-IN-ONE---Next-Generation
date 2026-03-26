/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  Central Validation Layer — Powered by Zod                              │
 * │                                                                          │
 * │  Usage:                                                                  │
 * │    const validators = require('../utils/validators');                    │
 * │                                                                          │
 * │    const v = validators.BanArgs.safeParse({ userId, reason, duration }); │
 * │    if (!v.success) return reply(validators.formatError(v.error));        │
 * │    const { reason: cleanReason, duration } = v.data; // sanitized ✓     │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const { z } = require('zod');

// ══════════════════════════════════════════════════════════════════════════════
// Primitive schemas — reusable building blocks
// ══════════════════════════════════════════════════════════════════════════════

/** Discord snowflake ID — 17 to 20 decimal digits */
const snowflake = z
    .string()
    .regex(/^\d{17,20}$/, 'Must be a valid Discord snowflake ID (17–20 digits)');

/** 6-digit hex colour, e.g. #6366f1 */
const hexColor = z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a hex colour in #RRGGBB format');

/** 8-char uppercase alphanumeric case identifier */
const caseId = z
    .string()
    .regex(/^[A-Z0-9]{8}$/, 'Case ID must be 8 uppercase alphanumeric characters');

/** Bot command prefix — 1–3 non-whitespace characters */
const prefix = z
    .string()
    .trim()
    .min(1, 'Prefix cannot be empty')
    .max(3, 'Prefix cannot be longer than 3 characters')
    .regex(/^\S+$/, 'Prefix cannot contain spaces');

/** Moderation reason — trimmed, 1–512 characters */
const reason = z
    .string()
    .trim()
    .min(1, 'Reason cannot be empty')
    .max(512, 'Reason cannot exceed 512 characters');

/**
 * Generic duration string.
 * Accepts: 5m · 2h · 7d · 2w · 0 · permanent
 * Used by ban and jail where '0'/'permanent' means indefinite.
 */
const durationStr = z
    .string()
    .regex(
        /^(\d+[smhdw]|0|permanent)$/i,
        'Invalid duration — use e.g. 5m, 1h, 7d, 2w, 0, or permanent'
    )
    .transform(s => s.toLowerCase());

/**
 * Mute duration — short unit format only (m/h/d/w), max 28 days.
 * '0' and 'permanent' are rejected: Discord timeouts must have an end time.
 */
const muteDuration = z
    .string()
    .regex(
        /^\d+[mhdw]$/i,
        'Invalid mute duration — use e.g. 5m, 1h, 1d, 7d (max 28d)'
    )
    .transform(s => s.toLowerCase())
    .refine(s => {
        const [, n, u] = s.match(/^(\d+)([mhdw])$/) ?? [];
        if (!u) return false;
        const toMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
        return parseInt(n) * toMs[u] <= 28 * 86_400_000;
    }, { message: 'Mute duration cannot exceed 28 days' });

// ══════════════════════════════════════════════════════════════════════════════
// Command argument schemas
// ══════════════════════════════════════════════════════════════════════════════

/**
 * !ban / /ban
 * @example { userId: '1234567890123456789', reason: 'Spam', duration: '7d' }
 */
const BanArgs = z.object({
    userId:   snowflake,
    reason:   reason,
    duration: z
        .union([durationStr, z.literal('permanent'), z.literal('0')])
        .optional()
        .default('permanent'),
});

/**
 * !warn / /warn
 * @example { userId: '1234567890123456789', reason: 'Harassment' }
 */
const WarnArgs = z.object({
    userId: snowflake,
    reason: reason,
});

/**
 * !mute / /mute
 * @example { userId: '1234567890123456789', duration: '1h', reason: 'Flooding' }
 */
const MuteArgs = z.object({
    userId:   snowflake,
    duration: muteDuration,
    reason:   reason,
});

/**
 * !jail / /jail
 * @example { userId: '1234567890123456789', duration: '1d', reason: 'Rule violation' }
 */
const JailArgs = z.object({
    userId:   snowflake,
    duration: durationStr,
    reason:   reason,
});

/** !prefix / /set_prefix */
const PrefixArgs = z.object({
    prefix: prefix,
});

// ══════════════════════════════════════════════════════════════════════════════
// settings.json config schemas
// ══════════════════════════════════════════════════════════════════════════════

/** Single action entry (warn, ban, mute, jail, etc.) in settings.json */
const ActionConfig = z.object({
    label:        z.string().optional(),
    aliases:      z.array(z.string()).optional(),
    emoji:        z.string().optional(),
    color:        hexColor.optional().nullable(),
    rolesAllowed: z.array(snowflake).optional(),
    enabled:      z.boolean().optional(),
    admin:        z.boolean().optional(),
    log:          z.boolean().optional(),
    saveRecord:   z.boolean().optional(),
    dm:           z.boolean().optional(),
}).passthrough(); // allow extra per-action keys (muteRole, durationOptions, etc.)

/** Single anti_* entry in settings.json protection section */
const ProtectionEntry = z.object({
    enable:          z.boolean().optional(),
    enabled:         z.boolean().optional(),
    limit:           z.number().int().min(0).optional(),
    action:          z.coerce.number().int().min(0).max(3).optional(),
    whitelist_roles: z.array(snowflake).optional(),
}).passthrough();

const SystemConfig = z.object({
    PREFIX:                z.string().max(3).optional(),
    ENABLE_SLASH_COMMANDS: z.boolean().optional(),
    COMMANDS:              z.object({ lang: z.enum(['en', 'ar']) }).passthrough().optional(),
}).passthrough();

const CourtConfig = z.object({
    name:       z.string().max(100).optional(),
    logo:       z.string().optional().nullable(),
    color:      hexColor.optional().nullable(),
    logChannel: snowflake.or(z.literal('')).optional().nullable(),
}).passthrough();

/**
 * Full settings.json schema.
 * Validation is warn-only — extra or unknown keys are always accepted via
 * .passthrough() so that older/extended configs never break on load.
 */
const SettingsSchema = z.object({
    system:     SystemConfig.optional(),
    court:      CourtConfig.optional(),
    actions:    z.record(z.string(), ActionConfig).optional(),
    protection: z.object({
        whitelist_roles: z.array(snowflake).optional(),
    }).passthrough().optional(),
}).passthrough();

// ══════════════════════════════════════════════════════════════════════════════
// Guild database write schemas  (used in guildDb.write)
// ══════════════════════════════════════════════════════════════════════════════

/** Per-guild settings persisted by the dashboard */
const GuildSettingsWrite = z.object({
    prefix:     prefix.optional(),
    lang:       z.enum(['en', 'ar']).optional(),
    logChannel: snowflake.or(z.literal('')).optional().nullable(),
}).passthrough();

/** Per-guild protection configuration */
const GuildProtectionWrite = z.object({
    whitelist_roles: z.array(snowflake).optional(),
}).catchall(
    z.union([ProtectionEntry, z.array(snowflake)])
);

/**
 * filename → Zod schema mapping.
 * Only filenames listed here are validated on write().
 * All others pass through silently.
 */
const GUILD_WRITE_SCHEMAS = Object.freeze({
    settings:   GuildSettingsWrite,
    protection: GuildProtectionWrite,
});

// ══════════════════════════════════════════════════════════════════════════════
// Utility helpers
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Format a ZodError into a short, user-facing message.
 * Shows only the first issue to keep replies concise.
 *
 * @param {import('zod').ZodError} err
 * @returns {string}
 *
 * @example
 *   validators.formatError(v.error)
 *   // → '[reason] Reason cannot be empty'
 */
function formatError(err) {
    // Zod v4 uses .issues; v3 used .errors — support both
    const first = (err.issues ?? err.errors)?.[0];
    if (!first) return 'Validation failed';
    const path = first.path?.length ? `[${first.path.join('.')}] ` : '';
    return `${path}${first.message}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// Exports
// ══════════════════════════════════════════════════════════════════════════════

module.exports = {
    // ── Primitives ────────────────────────────────────────────────────────
    snowflake,
    hexColor,
    caseId,
    prefix,
    reason,
    durationStr,
    muteDuration,

    // ── Command argument schemas ──────────────────────────────────────────
    BanArgs,
    WarnArgs,
    MuteArgs,
    JailArgs,
    PrefixArgs,

    // ── Config schemas ────────────────────────────────────────────────────
    ActionConfig,
    ProtectionEntry,
    SettingsSchema,

    // ── Guild DB write schemas ────────────────────────────────────────────
    GuildSettingsWrite,
    GuildProtectionWrite,
    GUILD_WRITE_SCHEMAS,

    // ── Utils ─────────────────────────────────────────────────────────────
    formatError,
};
