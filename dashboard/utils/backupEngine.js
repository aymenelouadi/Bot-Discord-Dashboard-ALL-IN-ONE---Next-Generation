/*
 * Next Generation — Auto Backup Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Supports three backup strategies:
 *   1. Change Stream  — real-time CDC; every write is mirrored instantly
 *   2. Queue System   — queued CDC with exponential-backoff retry
 *   3. Scheduled      — periodic full sync (1 min – 1 month interval)
 *
 * Security:
 *   • Backup URIs are encrypted with AES-256-GCM using the SESSION secret.
 *   • URIs are never logged or returned to clients in plaintext.
 *   • Webhook tokens are masked in API responses.
 *
 * Discord notifications use Components V2 (flags: 1<<15) — no embeds.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');
const http   = require('http');
const logger = require('../../utils/logger');

const SETTINGS_PATH = path.join(__dirname, '../../settings.json');

/* ═══════════════════════════════════════════════════════════════════════════
   AES-256-GCM helper — encrypt / decrypt target URIs
   ═══════════════════════════════════════════════════════════════════════════ */

function _getKey() {
    const secret = process.env.SESSION || 'nexus-secret-key';
    return crypto.createHash('sha256').update(secret).digest(); // 32 bytes
}

function encryptUri(uri) {
    const key    = _getKey();
    const iv     = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc    = Buffer.concat([cipher.update(uri, 'utf8'), cipher.final()]);
    const tag    = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptUri(encB64) {
    try {
        const key      = _getKey();
        const buf      = Buffer.from(encB64, 'base64');
        const iv       = buf.subarray(0, 12);
        const tag      = buf.subarray(12, 28);
        const data     = buf.subarray(28);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return decipher.update(data).toString('utf8') + decipher.final('utf8');
    } catch (_) { return null; }
}

/** Replace credentials in a MongoDB URI with *** for safe display */
function maskUri(uri) {
    if (!uri) return '';
    return uri.replace(/(mongodb(?:\+srv)?:\/\/)([^:@]*):([^@]*)@/, '$1***:***@');
}

/** Mask the token portion of a Discord webhook URL */
function maskWebhook(url) {
    if (!url) return '';
    return url.replace(/(\/api\/webhooks\/\d+\/)(.+)$/, '$1***');
}

/* ═══════════════════════════════════════════════════════════════════════════
   Settings helpers (standalone — no circular dep with server.js)
   ═══════════════════════════════════════════════════════════════════════════ */

function _readCfg() {
    try {
        const raw = fs.readFileSync(SETTINGS_PATH, 'utf8').replace(/^\uFEFF/, '');
        return JSON.parse(raw);
    } catch (_) { return {}; }
}

function _writeCfg(cfg) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(cfg, null, 4), 'utf8');
}

function _getTargets() {
    const cfg = _readCfg();
    return Array.isArray(cfg.BACKUP?.targets) ? cfg.BACKUP.targets : [];
}

function _saveTargets(targets) {
    const cfg = _readCfg();
    if (!cfg.BACKUP) cfg.BACKUP = {};
    cfg.BACKUP.targets = targets;
    _writeCfg(cfg);
}

/* ═══════════════════════════════════════════════════════════════════════════
   CV2 Discord Webhook notification
   Uses flags: 1<<15 (IS_COMPONENTS_V2) — no embeds, no content
   ═══════════════════════════════════════════════════════════════════════════ */

async function sendWebhookCV2(webhookUrl, result) {
    const { targetName, mode, status, collections, totalDocs, duration, error } = result;
    const isSuccess   = status === 'success';
    const accentColor = isSuccess ? 0x22c55e : 0xef4444;

    const modeLabel = {
        changestream: 'Change Stream (Real-time)',
        queue:        'Queue System',
        schedule:     'Scheduled Sync',
    }[mode] || mode;

    const nowTs       = Math.floor(Date.now() / 1000);
    const durationStr = duration != null ? `${(duration / 1000).toFixed(2)}s` : '—';
    const statusIcon  = isSuccess ? '✅' : '❌';
    const statusText  = isSuccess ? 'Success' : `Failed — \`${String(error || 'Unknown').slice(0, 100)}\``;

    const bodyLines = [
        `**Target:** \`${targetName}\``,
        `**Mode:** \`${modeLabel}\``,
        `${statusIcon} **Status:** ${statusText}`,
    ];
    if (isSuccess) {
        if (collections != null) bodyLines.push(`**Collections:** \`${collections}\``);
        if (totalDocs   != null) bodyLines.push(`**Documents synced:** \`${Number(totalDocs).toLocaleString('en-US')}\``);
    }
    bodyLines.push(`**Duration:** \`${durationStr}\``);
    bodyLines.push(`**Timestamp:** <t:${nowTs}:F>`);

    const dashBase = (() => {
        const link = process.env.QAUTH_LINK || '';
        return link ? link.replace(/\/auth\/.*/, '') : 'http://localhost:2000';
    })();

    const payload = {
        flags: 1 << 15, // IS_COMPONENTS_V2
        components: [
            {
                type: 17, // Container
                accent_color: accentColor,
                components: [
                    {
                        type: 10, // Text Display
                        content: '## 🗄️ MongoDB Auto-Backup Report',
                    },
                    { type: 14, divider: true, spacing: 1 }, // Separator
                    {
                        type: 10, // Text Display
                        content: bodyLines.join('\n'),
                    },
                    { type: 14, divider: false, spacing: 1 },
                    {
                        type: 1, // Action Row
                        components: [
                            {
                                type: 2,  // Button
                                style: 5, // Link
                                label: 'Open Settings',
                                url:   `${dashBase}/settings`,
                            },
                        ],
                    },
                ],
            },
        ],
    };

    return new Promise((resolve) => {
        try {
            const url  = new URL(webhookUrl);
            const data = JSON.stringify(payload);
            const lib  = url.protocol === 'https:' ? https : http;
            const opts = {
                hostname: url.hostname,
                port:     url.port || (url.protocol === 'https:' ? 443 : 80),
                path:     url.pathname + url.search,
                method:   'POST',
                headers: {
                    'Content-Type':   'application/json',
                    'Content-Length': Buffer.byteLength(data),
                },
            };
            const req = lib.request(opts, res => {
                res.resume();
                resolve(res.statusCode);
            });
            req.on('error', () => resolve(null));
            req.setTimeout(10000, () => { req.destroy(); resolve(null); });
            req.write(data);
            req.end();
        } catch (_) { resolve(null); }
    });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Full sync: copy every collection from source → target (upsert by _id)
   ═══════════════════════════════════════════════════════════════════════════ */

async function _fullSync(sourceDb, targetDb) {
    const colls = await sourceDb.listCollections().toArray();
    let totalDocs = 0;

    for (const col of colls) {
        const name = col.name;
        if (name.startsWith('system.')) continue;

        const sourceColl = sourceDb.collection(name);
        const targetColl = targetDb.collection(name);
        const docs       = await sourceColl.find({}, { allowDiskUse: true }).toArray();
        if (!docs.length) continue;

        totalDocs += docs.length;
        const ops = docs.map(doc => ({
            replaceOne: {
                filter:      { _id: doc._id },
                replacement: doc,
                upsert:      true,
            },
        }));
        await targetColl.bulkWrite(ops, { ordered: false });
    }

    return { collections: colls.length, totalDocs };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Replicate a single change stream event to the target DB
   ═══════════════════════════════════════════════════════════════════════════ */

async function _replicateChange(targetDb, change) {
    const ns = change.ns?.coll;
    if (!ns) return;

    const coll = targetDb.collection(ns);
    const { operationType, fullDocument, documentKey, updateDescription } = change;

    if (operationType === 'insert' || operationType === 'replace') {
        if (fullDocument) {
            await coll.replaceOne({ _id: documentKey._id }, fullDocument, { upsert: true });
        }
    } else if (operationType === 'update') {
        if (fullDocument) {
            await coll.replaceOne({ _id: documentKey._id }, fullDocument, { upsert: true });
        } else if (updateDescription) {
            const upd = {};
            const set   = updateDescription.updatedFields   || {};
            const unset = updateDescription.removedFields   || [];
            if (Object.keys(set).length)   upd.$set   = set;
            if (unset.length)              upd.$unset  = Object.fromEntries(unset.map(f => [f, 1]));
            if (Object.keys(upd).length)   await coll.updateOne({ _id: documentKey._id }, upd, { upsert: true });
        }
    } else if (operationType === 'delete') {
        await coll.deleteOne({ _id: documentKey._id });
    } else if (operationType === 'drop') {
        await coll.drop().catch(() => {});
    } else if (operationType === 'rename') {
        // Best-effort: copy to new name
        const { to } = change;
        if (to?.coll) {
            const docs = await targetDb.collection(ns).find({}).toArray();
            if (docs.length) await targetDb.collection(to.coll).insertMany(docs, { ordered: false }).catch(() => {});
            await targetDb.collection(ns).drop().catch(() => {});
        }
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   BackupQueue — for "queue" mode with retry
   ═══════════════════════════════════════════════════════════════════════════ */

class BackupQueue {
    constructor(target, targetConn, engine) {
        this._target      = target;
        this._targetConn  = targetConn;
        this._engine      = engine;
        this._queue       = [];
        this._stopped     = false;
        this._processing  = false;
        // Exponential back-off delays (ms)
        this._retryDelays = [2000, 5000, 15000, 30000, 60000];
    }

    push(op) {
        if (this._stopped) return;
        this._queue.push({ op, attempts: 0 });
        if (!this._processing) this._process();
    }

    async _process() {
        if (this._processing || this._stopped) return;
        this._processing = true;
        while (this._queue.length && !this._stopped) {
            const item = this._queue[0];
            try {
                await _replicateChange(this._targetConn.db, item.op);
                this._queue.shift();
            } catch (e) {
                item.attempts++;
                if (item.attempts > this._retryDelays.length) {
                    logger.warn(`BackupQueue: discarding op after ${item.attempts} retries`, {
                        category: 'backup',
                        target:   this._target.name,
                        error:    e.message,
                    });
                    this._queue.shift();
                } else {
                    const delay = this._retryDelays[item.attempts - 1] || 60000;
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        }
        this._processing = false;
    }

    async runFullSync() {
        if (!this._engine._sourceConn) return;
        const st = this._engine._stats.get(this._target.id)
            || { success: 0, failed: 0, totalDocs: 0, lastRun: null, lastStatus: null };
        const t0 = Date.now();
        try {
            const { collections, totalDocs } = await _fullSync(
                this._engine._sourceConn.db, this._targetConn.db,
            );
            st.success++;
            st.totalDocs  = totalDocs;
            st.lastRun    = new Date().toISOString();
            st.lastStatus = 'success';
            this._engine._stats.set(this._target.id, st);
            await this._engine._notify(this._target, {
                status: 'success', collections, totalDocs,
                duration: Date.now() - t0, mode: 'queue',
            });
        } catch (e) {
            st.failed++;
            st.lastRun    = new Date().toISOString();
            st.lastStatus = 'failed';
            this._engine._stats.set(this._target.id, st);
            await this._engine._notify(this._target, {
                status: 'failed', error: e.message,
                duration: Date.now() - t0, mode: 'queue',
            });
        }

        // Also attach change stream to feed this queue (so subsequent changes are queued)
        if (this._engine._sourceConn && !this._engine._changeStreams.has(this._target.id)) {
            try {
                const stream = this._engine._sourceConn.db.watch([], {
                    fullDocument: 'updateLookup',
                });
                stream.on('change', (change) => { if (!this._stopped) this.push(change); });
                stream.on('error', () => {
                    if (!this._stopped) {
                        setTimeout(() => this.runFullSync().catch(() => {}), 10_000);
                    }
                });
                this._engine._changeStreams.set(this._target.id, stream);
            } catch (_) {
                // Change streams not supported (standalone MongoDB) — queue mode
                // will only do the initial full sync; subsequent changes won't be tracked.
                logger.warn(`BackupQueue: change streams unavailable for target "${this._target.name}" — only initial sync performed`, { category: 'backup' });
            }
        }
    }

    stop() {
        this._stopped = true;
        this._queue   = [];
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   BackupEngine — main orchestrator
   ═══════════════════════════════════════════════════════════════════════════ */

class BackupEngine {
    constructor() {
        this._sourceConn   = null;
        this._targetConns  = new Map(); // id → mongoose.Connection
        this._schedulers   = new Map(); // id → { timer, nextAt }
        this._changeStreams = new Map(); // id → ChangeStream
        this._queues       = new Map(); // id → BackupQueue
        this._stats        = new Map(); // id → { success, failed, totalDocs, lastRun, lastStatus }
    }

    /* ── Start engine ──────────────────────────────────────────────────── */
    async init(sourceUri) {
        if (!sourceUri) {
            logger.warn('BackupEngine: No source URI — backup engine disabled', { category: 'backup' });
            return;
        }
        try {
            const mongoose   = require('mongoose');
            this._sourceConn = mongoose.createConnection(sourceUri, {
                serverSelectionTimeoutMS: 15000,
                maxPoolSize: 3,
            });
            await this._sourceConn.asPromise();
            logger.info('BackupEngine: connected to source MongoDB', { category: 'backup' });
        } catch (e) {
            logger.error('BackupEngine: source connection failed', { category: 'backup', error: e.message });
            return;
        }

        const targets = _getTargets();
        for (const t of targets) {
            if (!t.enabled) continue;
            await this._startTarget(t).catch(err =>
                logger.error(`BackupEngine: failed to start target "${t.name}"`, {
                    category: 'backup', error: err.message,
                }),
            );
        }
    }

    /* ── Start a single target ─────────────────────────────────────────── */
    async _startTarget(target) {
        await this._stopTarget(target.id); // stop any existing instance

        const uri = target.uri_enc ? decryptUri(target.uri_enc) : null;
        if (!uri) throw new Error('Cannot decrypt backup target URI');

        const mongoose = require('mongoose');
        const conn     = mongoose.createConnection(uri, {
            serverSelectionTimeoutMS: 10000,
            maxPoolSize: 3,
        });
        await conn.asPromise();
        this._targetConns.set(target.id, conn);

        if (!this._stats.has(target.id)) {
            this._stats.set(target.id, {
                success: 0, failed: 0, totalDocs: 0,
                lastRun: null, lastStatus: null,
            });
        }

        if      (target.mode === 'changestream') await this._setupChangeStream(target, conn);
        else if (target.mode === 'queue')         await this._setupQueue(target, conn);
        else if (target.mode === 'schedule')      this._setupScheduler(target, conn);

        logger.info(`BackupEngine: started target "${target.name}" [${target.mode}]`, { category: 'backup' });
    }

    /* ── Stop a target completely ──────────────────────────────────────── */
    async _stopTarget(id) {
        const cs = this._changeStreams.get(id);
        if (cs) { try { await cs.close(); } catch (_) {} this._changeStreams.delete(id); }

        const sched = this._schedulers.get(id);
        if (sched) { clearTimeout(sched.timer); this._schedulers.delete(id); }

        const q = this._queues.get(id);
        if (q) { q.stop(); this._queues.delete(id); }

        const conn = this._targetConns.get(id);
        if (conn) { try { await conn.close(); } catch (_) {} this._targetConns.delete(id); }
    }

    /* ── Change Stream mode ────────────────────────────────────────────── */
    async _setupChangeStream(target, targetConn) {
        if (!this._sourceConn) return;

        // 1. Initial full sync
        const st = this._stats.get(target.id);
        const t0 = Date.now();
        try {
            const { collections, totalDocs } = await _fullSync(
                this._sourceConn.db, targetConn.db,
            );
            st.success++;
            st.totalDocs  = totalDocs;
            st.lastRun    = new Date().toISOString();
            st.lastStatus = 'success';
            await this._notify(target, {
                status: 'success', collections, totalDocs,
                duration: Date.now() - t0, mode: 'changestream',
            });
        } catch (e) {
            st.failed++;
            st.lastRun    = new Date().toISOString();
            st.lastStatus = 'failed';
            await this._notify(target, {
                status: 'failed', error: e.message,
                duration: Date.now() - t0, mode: 'changestream',
            });
        }

        // 2. Watch for incremental changes
        try {
            const stream = this._sourceConn.db.watch([], {
                fullDocument:             'updateLookup',
                fullDocumentBeforeChange: 'whenAvailable',
            });

            // Batch notifications — one message per 30-second window
            let batchTimer = null;
            let batchDocs  = 0;

            stream.on('change', async (change) => {
                try {
                    await _replicateChange(targetConn.db, change);
                    batchDocs++;
                } catch (_) {}

                if (!batchTimer) {
                    const capturedBatchRef = { docs: 0 };
                    batchTimer = setTimeout(async () => {
                        const docs = batchDocs;
                        batchDocs  = 0;
                        batchTimer = null;
                        st.success++;
                        st.totalDocs += docs;
                        st.lastRun    = new Date().toISOString();
                        st.lastStatus = 'success';
                        await this._notify(target, {
                            status: 'success', collections: '⚡ Live', totalDocs: docs,
                            duration: 0, mode: 'changestream',
                        });
                        void capturedBatchRef;
                    }, 30_000);
                }
            });

            stream.on('error', async (e) => {
                logger.warn(`BackupEngine: change stream error — "${target.name}"`, {
                    category: 'backup', error: e.message,
                });
                st.failed++;
                st.lastRun    = new Date().toISOString();
                st.lastStatus = 'failed';
                this._changeStreams.delete(target.id);
                // Reconnect after 15 s
                setTimeout(() => {
                    this._startTarget(target).catch(err =>
                        logger.warn(`BackupEngine: reconnect failed for "${target.name}"`, {
                            category: 'backup', error: err.message,
                        }),
                    );
                }, 15_000);
            });

            this._changeStreams.set(target.id, stream);
        } catch (e) {
            logger.warn(
                `BackupEngine: change streams unavailable for "${target.name}" (${e.message}) — no incremental sync`,
                { category: 'backup' },
            );
        }
    }

    /* ── Queue System mode ─────────────────────────────────────────────── */
    async _setupQueue(target, targetConn) {
        if (!this._sourceConn) return;
        const q = new BackupQueue(target, targetConn, this);
        this._queues.set(target.id, q);
        await q.runFullSync();
    }

    /* ── Scheduled mode ────────────────────────────────────────────────── */
    _setupScheduler(target, targetConn) {
        const ms = target.scheduleMs || 3_600_000; // fallback 1 h

        const _tick = async () => {
            const st = this._stats.get(target.id);
            const t0 = Date.now();
            try {
                const { collections, totalDocs } = await _fullSync(
                    this._sourceConn.db, targetConn.db,
                );
                st.success++;
                st.totalDocs  = totalDocs;
                st.lastRun    = new Date().toISOString();
                st.lastStatus = 'success';
                await this._notify(target, {
                    status: 'success', collections, totalDocs,
                    duration: Date.now() - t0, mode: 'schedule',
                });
            } catch (e) {
                st.failed++;
                st.lastRun    = new Date().toISOString();
                st.lastStatus = 'failed';
                await this._notify(target, {
                    status: 'failed', error: e.message,
                    duration: Date.now() - t0, mode: 'schedule',
                });
            }
            // Schedule next run
            const sched = this._schedulers.get(target.id);
            if (sched) {
                sched.nextAt = Date.now() + ms;
                sched.timer  = setTimeout(_tick, ms);
            }
        };

        this._schedulers.set(target.id, {
            timer: setTimeout(_tick, ms),
            nextAt: Date.now() + ms,
        });
    }

    /* ── Send CV2 Discord notification ─────────────────────────────────── */
    async _notify(target, result) {
        const webhooks = Array.isArray(target.notifyWebhooks) ? target.notifyWebhooks : [];
        for (const wh of webhooks) {
            if (wh && wh.startsWith('https://discord.com/api/webhooks/')) {
                await sendWebhookCV2(wh, { ...result, targetName: target.name })
                    .catch(() => {});
            }
        }
    }

    /* ── Public: run a manual full backup ──────────────────────────────── */
    async runNow(targetId) {
        const target = _getTargets().find(t => t.id === targetId);
        if (!target) throw new Error('Target not found');

        const uri = target.uri_enc ? decryptUri(target.uri_enc) : null;
        if (!uri)  throw new Error('Cannot decrypt target URI');

        if (!this._sourceConn || this._sourceConn.readyState !== 1) {
            throw new Error('Source MongoDB connection is not ready');
        }

        // Ensure target connection
        let conn = this._targetConns.get(targetId);
        if (!conn || conn.readyState !== 1) {
            const mongoose = require('mongoose');
            conn = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 10000 });
            await conn.asPromise();
            this._targetConns.set(targetId, conn);
        }

        const t0 = Date.now();
        const st = this._stats.get(targetId)
            || { success: 0, failed: 0, totalDocs: 0, lastRun: null, lastStatus: null };
        try {
            const { collections, totalDocs } = await _fullSync(this._sourceConn.db, conn.db);
            st.success++;
            st.totalDocs  = totalDocs;
            st.lastRun    = new Date().toISOString();
            st.lastStatus = 'success';
            this._stats.set(targetId, st);
            await this._notify(target, {
                status: 'success', collections, totalDocs,
                duration: Date.now() - t0, mode: target.mode,
            });
            return { success: true, collections, totalDocs, duration: Date.now() - t0 };
        } catch (e) {
            st.failed++;
            st.lastRun    = new Date().toISOString();
            st.lastStatus = 'failed';
            this._stats.set(targetId, st);
            await this._notify(target, {
                status: 'failed', error: e.message,
                duration: Date.now() - t0, mode: target.mode,
            });
            throw e;
        }
    }

    /* ── Public: test connection without saving ─────────────────────────── */
    async testConnection(uri) {
        let conn;
        try {
            const mongoose = require('mongoose');
            conn = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 8000 });
            await conn.asPromise();
            const colls = await conn.db.listCollections().toArray();
            await conn.close();
            return { success: true, collections: colls.length };
        } catch (e) {
            if (conn) await conn.close().catch(() => {});
            throw e;
        }
    }

    /* ── Public: reload a target after edit ─────────────────────────────── */
    async reloadTarget(targetId) {
        const target = _getTargets().find(t => t.id === targetId);
        if (!target || !target.enabled) {
            await this._stopTarget(targetId);
            return;
        }
        await this._startTarget(target);
    }

    /* ── Public: stop all ───────────────────────────────────────────────── */
    async shutdown() {
        for (const id of [...this._targetConns.keys()]) await this._stopTarget(id);
        if (this._sourceConn) await this._sourceConn.close().catch(() => {});
    }

    /* ── Public: stats snapshot ─────────────────────────────────────────── */
    getStats() {
        const out = {};
        for (const [id, st] of this._stats) out[id] = { ...st };
        return out;
    }

    /* ── Public: next scheduled run timestamp ───────────────────────────── */
    getSchedulerNextAt(id) {
        return this._schedulers.get(id)?.nextAt ?? null;
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Singleton engine instance
   ═══════════════════════════════════════════════════════════════════════════ */
const _engine = new BackupEngine();

module.exports = {
    engine:       _engine,
    BackupEngine,
    BackupQueue,
    encryptUri,
    decryptUri,
    maskUri,
    maskWebhook,
    _getTargets,
    _saveTargets,
};
