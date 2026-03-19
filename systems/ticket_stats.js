/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

'use strict';

/**
 * ticket_stats.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Centralised ticket-stats manager.
 *
 * Persisted file:  database/<guildId>/ticket_stats.json
 * Shape:
 * {
 *   avg_response_ms : number,   — rolling average open→close duration (ms)
 *   total_closed    : number,   — lifetime counter used for rolling average
 *   last_reset_date : string,   — ISO date string of last midnight reset (for closed_today)
 *   closed_today    : number    — tickets closed since midnight (UTC)
 * }
 *
 * Public API:
 *   onTicketOpen  (guildId, record)          — called after a ticket is opened
 *   onTicketClose (guildId, record, closedAt)— called after a ticket is closed
 *   onTicketClaim (guildId, record)          — called after a ticket is claimed
 *   onTicketUnclaim(guildId, record)         — called after unclaim (noop for now, extensible)
 *   getStats      (guildId, openTickets)     — returns live stats object for the dashboard API
 */

const guildDb = require('../dashboard/utils/guildDb');

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Read stats file, auto-resetting closed_today when the UTC date has changed.
 */
function _read(guildId) {
    const stats = guildDb.read(guildId, 'ticket_stats', {
        avg_response_ms: 0,
        total_closed:    0,
        last_reset_date: '',
        closed_today:    0,
    });
    const todayStr = new Date().toISOString().slice(0, 10);
    if (stats.last_reset_date !== todayStr) {
        stats.closed_today    = 0;
        stats.last_reset_date = todayStr;
    }
    return stats;
}

function _write(guildId, stats) {
    guildDb.write(guildId, 'ticket_stats', stats);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Called right after a new ticket record is written to open_tickets.
 * Currently a no-op hook — extend later (e.g. daily open counter).
 * @param {string} guildId
 * @param {object} record  — the new ticket record
 */
function onTicketOpen(guildId, record) {
    try {
        // Placeholder — stats for opens can be added here
        void record;
        _emitUpdate(guildId);
    } catch (_e) { /* non-critical */ }
}

/**
 * Called right after a ticket's status is changed to 'closed' and persisted.
 * Updates:
 *   • rolling avg_response_ms  (open→close duration)
 *   • closed_today counter
 * @param {string} guildId
 * @param {object} record     — original (pre-close) record containing `openedAt`
 * @param {string} closedAt   — ISO timestamp of closure
 */
function onTicketClose(guildId, record, closedAt) {
    try {
        const stats = _read(guildId);

        // ── closed_today ──────────────────────────────────────────────────
        stats.closed_today = (stats.closed_today || 0) + 1;

        // ── rolling average response time ─────────────────────────────────
        if (record.openedAt && closedAt) {
            const responseMs = new Date(closedAt) - new Date(record.openedAt);
            if (responseMs > 0) {
                const n = (stats.total_closed || 0) + 1;
                stats.avg_response_ms = Math.round(
                    ((stats.avg_response_ms || 0) * (n - 1) + responseMs) / n
                );
                stats.total_closed = n;
            }
        }

        _write(guildId, stats);
        _emitUpdate(guildId);
    } catch (_e) { /* non-critical — never crash the close flow */ }
}

/**
 * Called right after a ticket is claimed.
 * No-op for now — hook for future per-staff stats.
 * @param {string} guildId
 * @param {object} record
 */
function onTicketClaim(guildId, record) {
    try {
        void guildId;
        void record;
    } catch (_e) { /* non-critical */ }
}

/**
 * Called right after a ticket is unclaimed.
 * @param {string} guildId
 * @param {object} record
 */
function onTicketUnclaim(guildId, record) {
    try {
        void guildId;
        void record;
    } catch (_e) { /* non-critical */ }
}

/**
 * Compute the full live stats object used by the dashboard `/tickets/stats` API.
 * @param {string}   guildId
 * @param {object[]} openTickets — array from open_tickets.json
 * @returns {{ open, claimed, closed_today, avg_response_ms, avg_display, total_closed }}
 */
function getStats(guildId, openTickets) {
    const tickets  = Array.isArray(openTickets) ? openTickets : [];
    const stats    = _read(guildId);

    const open         = tickets.filter(t => t.status === 'open').length;
    const claimed      = tickets.filter(t => t.status === 'open' && t.claimedBy).length;
    const closed_today = stats.closed_today || 0;
    const avgMs        = stats.avg_response_ms || 0;

    let avg_display = '—';
    if (avgMs > 0) {
        if      (avgMs < 60000)    avg_display = Math.round(avgMs / 1000)    + 's';
        else if (avgMs < 3600000)  avg_display = Math.round(avgMs / 60000)   + 'm';
        else                       avg_display = (avgMs / 3600000).toFixed(1) + 'h';
    }

    return {
        open,
        claimed,
        closed_today,
        avg_response_ms: avgMs,
        avg_display,
        total_closed: stats.total_closed || 0,
    };
}

module.exports = { onTicketOpen, onTicketClose, onTicketClaim, onTicketUnclaim, getStats };


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */