/*
 * Next Generation — Schemas Index
 * ─────────────────────────────────────────────────────────────────────────────
 * Central entry point for all Mongoose models.
 *
 * Usage:
 *   const db = require('./systems/schemas');
 *   await db.connect();
 *   const doc = await db.AFK.findOne({ userId });
 */

'use strict';

const mongoose = require('mongoose');
const logger   = require('../../utils/logger');

/** Connect to MongoDB Atlas using the MONGODB env variable */
async function connect() {
    if (mongoose.connection.readyState >= 1) return; // already connected/connecting

    const uri = process.env.MONGODB;
    if (!uri) {
        logger.error('MONGODB environment variable is not set!', { category: 'db' });
        process.exit(1);
    }

    try {
        await mongoose.connect(uri, {
            serverSelectionTimeoutMS: 15_000,
            socketTimeoutMS:          60_000,
            connectTimeoutMS:         15_000,
            heartbeatFrequencyMS:     10_000,
            retryWrites:              true,
            retryReads:               true,
            maxPoolSize:              10,
        });
        logger.db('Connected to MongoDB Atlas');
    } catch (err) {
        logger.error('MongoDB connection error', { category: 'db', error: err.message, stack: err.stack });
        process.exit(1);
    }

    mongoose.connection.on('disconnected', () =>
        logger.warn('MongoDB disconnected — will auto-reconnect', { category: 'db' })
    );
    mongoose.connection.on('reconnected', () =>
        logger.db('MongoDB reconnected')
    );
    mongoose.connection.on('error', err => {
        // Suppress noisy transient errors (monitor timeouts, brief network resets)
        if (/timeout|monitor|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(err.message)) return;
        logger.error('MongoDB connection error', { category: 'db', error: err.message });
    });
}

// ── Connection lifecycle helpers ──────────────────────────────────────────────

/** Gracefully close all MongoDB connections. Call on process exit. */
async function disconnect() {
    if (mongoose.connection.readyState === 0) return;
    await mongoose.connection.close();
    logger.db('MongoDB connection closed');
}

/** @returns {boolean} true only when the connection is fully established (state = 1) */
function isConnected() {
    return mongoose.connection.readyState === 1;
}

/**
 * Run `fn` inside a MongoDB multi-document ACID transaction.
 *
 * Requires a replica set (MongoDB Atlas M0+ or local replica).
 * Aborts automatically on error and always ends the session.
 *
 * @param {(session: import('mongoose').ClientSession) => Promise<*>} fn
 * @returns {Promise<*>}
 *
 * @example
 *   await db.withTransaction(async (session) => {
 *       await db.Warning.addCase(guildId, userId, name, caseData, { session });
 *       await db.Guild.patchField(guildId, 'stats.totalWarns',
 *           (await db.Guild.getField(guildId, 'stats.totalWarns') ?? 0) + 1,
 *           { session }
 *       );
 *   });
 */
async function withTransaction(fn) {
    const session = await mongoose.startSession();
    try {
        session.startTransaction();
        const result = await fn(session);
        await session.commitTransaction();
        return result;
    } catch (err) {
        await session.abortTransaction();
        throw err;
    } finally {
        session.endSession();
    }
}

/**
 * Execute `fn` with automatic exponential-backoff retry on transient MongoDB
 * errors (primary failover, network blip, HostUnreachable, etc.).
 *
 * Non-transient errors (validation errors, duplicate key, etc.) are re-thrown
 * immediately — no retry is attempted.
 *
 * @param {() => Promise<*>} fn
 * @param {{ maxRetries?: number, delayMs?: number }} [opts]
 * @returns {Promise<*>}
 *
 * @example
 *   const doc = await db.withRetry(() => db.Guild.findOrCreate(guildId));
 *   const top  = await db.withRetry(
 *       () => db.StaffScore.getLeaderboard(guildId, 5),
 *       { maxRetries: 5, delayMs: 100 }
 *   );
 */
async function withRetry(fn, { maxRetries = 3, delayMs = 250 } = {}) {
    // Well-known MongoDB transient error codes (driver + server)
    const TRANSIENT = new Set([
        6,     // HostUnreachable
        7,     // HostNotFound
        63,    // StaleConfig
        89,    // NetworkTimeout
        91,    // ShutdownInProgress
        150,   // ConfigurationInProgress
        189,   // PrimarySteppedDown
        262,   // ExceededTimeLimit
        10058, // ConnectionReset
        10107, // NotPrimary
        13435, // NotPrimaryNoSecondaryOk
        13436, // NotPrimaryOrSecondary
    ]);

    let lastErr;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (!TRANSIENT.has(err.code)) throw err; // non-transient → fail fast
            const wait = delayMs * 2 ** attempt;
            logger.warn(`MongoDB transient error — retrying`, {
                category: 'db',
                code:     err.code,
                attempt:  attempt + 1,
                maxRetries,
                retryInMs: wait,
            });
            await new Promise(r => setTimeout(r, wait));
        }
    }
    throw lastErr;
}

// ── Lazy model exports ───────────────────────────────────────────────────────
// Models are required lazily so this file can be imported before connect() is
// called without triggering Mongoose "model not registered" errors.

module.exports = {
    connect,
    disconnect,
    isConnected,
    withTransaction,
    withRetry,

    get Guild()            { return require('./Guild'); },
    get AFK()              { return require('./AFK'); },
    get Warning()          { return require('./Warning'); },
    get Jail()             { return require('./Moderation').Jail; },
    get Mute()             { return require('./Moderation').Mute; },
    get TempRole()         { return require('./TempRole'); },
    get MemberLevel()      { return require('./MemberLevel'); },
    get Ticket()           { return require('./Ticket'); },
    get TicketFeedback()   { return require('./TicketFeedback'); },
    get Suggestion()       { return require('./Suggestion'); },
    get StaffScore()       { return require('./StaffScore'); },
    get InteractionScore() { return require('./InteractionScore'); },
    get DashboardLog()     { return require('./DashboardLog'); },
    get AutomationLink()   { return require('./AutomationLink'); },
    get WelcomeJoin()      { return require('./WelcomeJoin'); },
    get WelcomeImage()     { return require('./WelcomeImage'); },
    get GlobalConfig()     { return require('./GlobalConfig'); },
    get Ban()              { return require('./BanAction'); },
    get Kick()             { return require('./KickAction'); },

    /** Re-export plugins for use in new schemas */
    plugins: {
        get guildScoped() { return require('./plugins/guildScoped'); },
        get softDelete()  { return require('./plugins/softDelete');  },
    },
};

/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */
