/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express       = require('express');
const http          = require('http');
const { Server: SocketServer } = require('socket.io');
const logger        = require('../utils/logger');

/* ── settings.json helpers ── */
let _cfgCache = null, _cfgCacheAt = 0;
const _cfgTTL = 4000; // 4 s — fast enough for live edits
function readSettingsCfg() {
    const now = Date.now();
    if (_cfgCache && (now - _cfgCacheAt) < _cfgTTL) return _cfgCache;
    try {
        let raw = require('fs').readFileSync(require('path').join(__dirname, '../settings.json'), 'utf8');
        raw = raw.replace(/^\uFEFF/, '');
        _cfgCache   = JSON.parse(raw);
        _cfgCacheAt = now;
        return _cfgCache;
    } catch (_) { return _cfgCache || {}; }
}
function writeSettingsCfg(cfg) {
    require('fs').writeFileSync(require('path').join(__dirname, '../settings.json'), JSON.stringify(cfg, null, 4), 'utf8');
    _cfgCache   = cfg;           // keep cache in sync
    _cfgCacheAt = Date.now();
}
function getIsShip(userId) {
    const cfg   = readSettingsCfg();
    const ships = (cfg.DASHBOARD && Array.isArray(cfg.DASHBOARD.SHIPS)) ? cfg.DASHBOARD.SHIPS : [];
    return ships.includes(String(userId));
}
const compression = require('compression');
const session    = require('express-session');
const path       = require('path');
const fs         = require('fs');
const multer     = require('multer');
const requestIp  = require('request-ip');
const geoip      = require('geoip-lite');
const helmet     = require('helmet');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const authRouter = require('./routes/auth');
const { langMiddleware } = require('./utils/lang');
const dashLogs = require('./utils/dashboardLogs');

// Ensure uploads directory exists (served as static under /uploads/)
const UPLOADS_ROOT = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS_ROOT)) fs.mkdirSync(UPLOADS_ROOT, { recursive: true });

const app        = express();
const httpServer = http.createServer(app);
const PORT    = parseInt(process.env.DASHBOARD_PORT, 10) || 2000;
const IS_PROD = (process.env.QAUTH_LINK || '').startsWith('https://');

// Restrict Socket.io to the dashboard's own origin in production
const _wsOrigin = IS_PROD
    ? (() => { try { return new URL(process.env.QAUTH_LINK).origin; } catch (_) { return false; } })()
    : `http://localhost:${PORT}`;

const io         = new SocketServer(httpServer, {
    cors: { origin: _wsOrigin, methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'],
});

// ── Socket.io: clients join a room per guildId ────────────────────────────
io.on('connection', socket => {
    socket.on('join:guild', guildId => {
        if (typeof guildId === 'string' && /^\d+$/.test(guildId)) {
            socket.join(`guild:${guildId}`);
        }
    });
});

// Trust reverse proxy when running behind HTTPS (e.g. nginx / Cloudflare tunnel)
if (IS_PROD) app.set('trust proxy', 1);

/* ── Middleware ─────────────────────────────────────── */
// Security headers (X-Frame-Options, X-Content-Type-Options, HSTS, etc.)
app.use(helmet({
    contentSecurityPolicy: false, // managed per-page via EJS meta tags
    crossOriginEmbedderPolicy: false,
}));
// Real IP detection (handles X-Forwarded-For safely)
app.use(requestIp.mw());
// Gzip / Brotli compression — reduces HTML/JS/CSS size by ~65%
app.use(compression({ level: 6 }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
// Static assets with aggressive browser caching (7 days for JS/CSS/images)
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '7d',
    etag: true,
    lastModified: true,
}));

app.use(session({
    secret: (() => {
        const s = process.env.SESSION;
        if (!s) {
            if (IS_PROD) logger.error('SESSION env variable is not set — sessions are unprotected!', { category: 'security' });
            else logger.warn('SESSION env not set — using insecure fallback. Add SESSION=<random> to .env', { category: 'security' });
        }
        return s || 'nexus-secret-key';
    })(),
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: IS_PROD,      // true over HTTPS proxy, false on localhost
        sameSite: 'lax',     // 'strict' breaks OAuth redirects (Discord drops the cookie on cross-site nav)
        maxAge: 1000 * 60 * 60 * 24
    }
}));

/* ── Language middleware ─────────────────────────────── */
app.use(langMiddleware);

// ── Serve ApexCharts locally (avoids CDN dependency) ─────────────────────
try {
    app.get('/apexcharts.js', (_req, res) => {
        res.set('Cache-Control', 'public, max-age=604800'); // 7 days
        res.sendFile(require.resolve('apexcharts/dist/apexcharts.min.js'));
    });
} catch (_e) { /* apexcharts not in node_modules, CDN fallback used */ }

/* ── View engine ────────────────────────────────────── */
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
// Cache compiled EJS templates (avoids re-parsing on every request)
app.enable('view cache');

/* ── Routes ─────────────────────────────────────────── */
app.use('/auth', authRouter);

/* ── INTRO (temporary hype landing) ──────────────────── */
app.get('/intro', (req, res) => {
    // If already seen, skip straight to root
    if (req.session?.introSeen) return res.redirect('/');
    res.render('intro');
});

app.post('/intro/done', (req, res) => {
    req.session.introSeen = true;
    req.session.save(() => res.json({ ok: true }));
});
/* ─────────────────────────────────────────────────────── */

app.get('/', (req, res) => {
    const cfg       = readSettingsCfg();
    const showIntro = cfg.DASHBOARD?.INTRO !== false;
    if (showIntro && !req.session?.introSeen) return res.redirect('/intro');
    if (req.session?.user?.verified) return res.redirect('/dashboard');
    if (req.session?.user && !req.session.user.verified) {
        if (cfg.DASHBOARD?.CODE_ACCESS === false) {
            req.session.user.verified = true;
            return req.session.save(() => res.redirect('/dashboard'));
        }
        return res.redirect('/verify');
    }
    const error = req.query.error || null;
    res.render('login', { error, t: req.t, lang: req.lang, supported: res.locals.supported });
});

/* ── Verify routes ───────────────────────────────────── */
app.get('/verify', (req, res) => {
    if (!req.session?.user) return res.redirect('/?error=unauthorized');
    if (req.session.user.verified) return res.redirect('/dashboard');
    const error = req.query.error || null;
    res.render('verify', { user: req.session.user, error, t: req.t, lang: req.lang, supported: res.locals.supported });
});

// Rate-limit: max 10 code attempts per 15 min per IP
const _verifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.clientIp || req.ip),
    handler: (_req, res) => res.status(429).render('verify', {
        user: _req.session?.user || {},
        error: 'too_many_attempts',
        t: _req.t,
        lang: _req.lang,
        supported: res.locals?.supported,
    }),
});

app.post('/verify', _verifyLimiter, (req, res) => {
    if (!req.session?.user) return res.redirect('/?error=unauthorized');
    if (req.session.user.verified) return res.redirect('/dashboard');
    const { code } = req.body;
    const _vcfg    = readSettingsCfg();
    const expected = (_vcfg.DASHBOARD?.CODE || process.env.CODE || '').trim();
    if (!code || code.trim() !== expected) {
        const error = req.query.error || null;
        return res.render('verify', { user: req.session.user, error: 'wrong_code', t: req.t, lang: req.lang, supported: res.locals.supported });
    }
    req.session.user.verified = true;
    req.session.save(() => res.render('verify', {
        user:     req.session.user,
        error:    null,
        success:  true,
        t:        req.t,
        lang:     req.lang,
        supported: res.locals.supported,
    }));
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

/* ── System Settings page (SHIPS only) ── */
app.get('/settings', require('./middleware/auth'), (req, res) => {
    const userId = req.session.user?.id;
    if (!getIsShip(userId)) return res.status(403).redirect('/dashboard');
    const cfg = readSettingsCfg();
    const srv = cfg.DASHBOARD?.SERVERS || {};
    const wh  = cfg.DASHBOARD?.WEBHOOK_LOG || {};
    res.render('system_settings', {
        user:    req.session.user,
        t:       req.t,
        lang:    req.lang,
        isShip:  true,
        dashCfg: {
            INTRO:       cfg.DASHBOARD?.INTRO !== false,
            CODE_ACCESS: cfg.DASHBOARD?.CODE_ACCESS !== false,
            CODE:        cfg.DASHBOARD?.CODE || '',
        },
        serversCfg: {
            ADD_BOT_ON_MANY_SERVER: srv.ADD_BOT_ON_MANY_SERVER !== false,
            SERVER_ALLOWED:        Array.isArray(srv.SERVER_ALLOWED) ? srv.SERVER_ALLOWED : [],
            LEAVE_AUTO:            srv.LEAVE_AUTO === true,
        },
        webhookCfg: {
            URL:   wh.URL   || '',
            COLOR: wh.COLOR || '#7c3aed',
        },
        shipsCfg: {
            SHIPS: Array.isArray(cfg.DASHBOARD?.SHIPS) ? cfg.DASHBOARD.SHIPS : [],
        },
        ownersCfg: {
            OWNERS: Array.isArray(cfg.DASHBOARD?.OWNERS) ? cfg.DASHBOARD.OWNERS : [],
        },
    });
});

/* ── POST /settings/webhook-config (SHIPS only) ── */
app.post('/settings/webhook-config', require('./middleware/auth'), express.json(), async (req, res) => {
    if (!getIsShip(req.session.user?.id)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const cfg = readSettingsCfg();
        if (!cfg.DASHBOARD) cfg.DASHBOARD = {};
        if (!cfg.DASHBOARD.WEBHOOK_LOG) cfg.DASHBOARD.WEBHOOK_LOG = {};
        const { URL: url, COLOR: color, test: doTest } = req.body;
        if (typeof url   === 'string') cfg.DASHBOARD.WEBHOOK_LOG.URL   = url.trim();
        if (typeof color === 'string') cfg.DASHBOARD.WEBHOOK_LOG.COLOR = color.trim();
        writeSettingsCfg(cfg);
        // Send test message
        if (doTest && cfg.DASHBOARD.WEBHOOK_LOG.URL) {
            const dashLogs = require('./utils/dashboardLogs');
            dashLogs.addEntry({
                type:        'login',
                userId:      req.session.user?.id,
                username:    req.session.user?.username,
                displayName: req.session.user?.displayName,
                avatar:      req.session.user?.avatar,
                ip:          'test',
            });
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── GET /settings/active-sessions (SHIPS only) ── */
app.get('/settings/active-sessions', require('./middleware/auth'), (req, res) => {
    if (!getIsShip(req.session.user?.id)) return res.status(403).json({ error: 'Forbidden' });
    const cfg   = readSettingsCfg();
    const ships = new Set((cfg.DASHBOARD?.SHIPS || []).map(String));
    req.sessionStore.all((err, sessions) => {
        if (err || !sessions) return res.json([]);
        const result = Object.entries(sessions)
            .filter(([, sess]) => sess.user && ships.has(String(sess.user.id)))
            .map(([sid, sess]) => ({
                sid,
                userId:      sess.user.id,
                username:    sess.user.username,
                displayName: sess.user.displayName,
                avatar:      sess.user.avatar,
                ip:          sess.user.ip || 'unknown',
                loginAt:     sess.user.loginAt || null,
                isSelf:      sid === req.sessionID,
            }));
        res.json(result);
    });
});

/* ── DELETE /settings/active-sessions/:sid (SHIPS only) ── */
app.delete('/settings/active-sessions/:sid', require('./middleware/auth'), (req, res) => {
    if (!getIsShip(req.session.user?.id)) return res.status(403).json({ error: 'Forbidden' });
    const { sid } = req.params;
    if (sid === req.sessionID) return res.status(400).json({ error: 'Cannot terminate your own session' });
    req.sessionStore.destroy(sid, err => {
        if (err) return res.status(500).json({ error: 'Failed to destroy session' });
        res.json({ success: true });
    });
});

/* ── POST /settings/ships (SHIPS only) – add ship ── */
app.post('/settings/ships', require('./middleware/auth'), express.json(), (req, res) => {
    if (!getIsShip(req.session.user?.id)) return res.status(403).json({ error: 'Forbidden' });
    const { userId } = req.body;
    if (!userId || !/^\d{10,20}$/.test(String(userId))) return res.status(400).json({ error: 'Invalid user ID' });
    const cfg = readSettingsCfg();
    if (!cfg.DASHBOARD) cfg.DASHBOARD = {};
    if (!Array.isArray(cfg.DASHBOARD.SHIPS)) cfg.DASHBOARD.SHIPS = [];
    const id = String(userId);
    if (!cfg.DASHBOARD.SHIPS.includes(id)) cfg.DASHBOARD.SHIPS.push(id);
    writeSettingsCfg(cfg);
    res.json({ success: true, ships: cfg.DASHBOARD.SHIPS });
});

/* ── DELETE /settings/ships/:userId (SHIPS only) – remove ship ── */
app.delete('/settings/ships/:userId', require('./middleware/auth'), (req, res) => {
    if (!getIsShip(req.session.user?.id)) return res.status(403).json({ error: 'Forbidden' });
    const id  = String(req.params.userId);
    if (id === String(req.session.user?.id)) return res.status(400).json({ error: 'Cannot remove yourself' });
    const cfg = readSettingsCfg();
    if (cfg.DASHBOARD?.SHIPS) cfg.DASHBOARD.SHIPS = cfg.DASHBOARD.SHIPS.filter(s => s !== id);
    writeSettingsCfg(cfg);
    res.json({ success: true, ships: cfg.DASHBOARD?.SHIPS || [] });
});

/* ── POST /settings/owners (SHIPS only) – add owner ── */
app.post('/settings/owners', require('./middleware/auth'), express.json(), (req, res) => {
    if (!getIsShip(req.session.user?.id)) return res.status(403).json({ error: 'Forbidden' });
    const { userId } = req.body;
    if (!userId || !/^\d{10,20}$/.test(String(userId))) return res.status(400).json({ error: 'Invalid user ID' });
    const cfg = readSettingsCfg();
    if (!cfg.DASHBOARD) cfg.DASHBOARD = {};
    if (!Array.isArray(cfg.DASHBOARD.OWNERS)) cfg.DASHBOARD.OWNERS = [];
    const id = String(userId);
    if (!cfg.DASHBOARD.OWNERS.includes(id)) cfg.DASHBOARD.OWNERS.push(id);
    writeSettingsCfg(cfg);
    res.json({ success: true, owners: cfg.DASHBOARD.OWNERS });
});

/* ── DELETE /settings/owners/:userId (SHIPS only) – remove owner ── */
app.delete('/settings/owners/:userId', require('./middleware/auth'), (req, res) => {
    if (!getIsShip(req.session.user?.id)) return res.status(403).json({ error: 'Forbidden' });
    const id  = String(req.params.userId);
    const cfg = readSettingsCfg();
    if (cfg.DASHBOARD?.OWNERS) cfg.DASHBOARD.OWNERS = cfg.DASHBOARD.OWNERS.filter(o => o !== id);
    writeSettingsCfg(cfg);
    res.json({ success: true, owners: cfg.DASHBOARD?.OWNERS || [] });
});

/* ── GET /settings/geo (SHIPS only) – IP geolocation ── */
app.get('/settings/geo', require('./middleware/auth'), (req, res) => {
    if (!getIsShip(req.session.user?.id)) return res.status(403).json({ error: 'Forbidden' });
    const ip  = String(req.query.ip || '');
    if (!ip)   return res.json(null);
    const geo = geoip.lookup(ip);
    res.json(geo || null);
});

/* ── POST /settings/dashboard-config (SHIPS only) ── */
app.post('/settings/dashboard-config', require('./middleware/auth'), express.json(), (req, res) => {
    if (!getIsShip(req.session.user?.id)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const cfg = readSettingsCfg();
        if (!cfg.DASHBOARD) cfg.DASHBOARD = {};
        if (!cfg.DASHBOARD.SERVERS) cfg.DASHBOARD.SERVERS = {};
        const { INTRO, CODE_ACCESS, CODE, ADD_BOT_ON_MANY_SERVER, SERVER_ALLOWED, LEAVE_AUTO } = req.body;
        cfg.DASHBOARD.INTRO       = Boolean(INTRO);
        cfg.DASHBOARD.CODE_ACCESS = Boolean(CODE_ACCESS);
        if (typeof CODE === 'string' && CODE.trim()) cfg.DASHBOARD.CODE = CODE.trim();
        // SERVERS block
        const addOnMany = Boolean(ADD_BOT_ON_MANY_SERVER);
        cfg.DASHBOARD.SERVERS.ADD_BOT_ON_MANY_SERVER = addOnMany;
        cfg.DASHBOARD.SERVERS.SERVER_ALLOWED = Array.isArray(SERVER_ALLOWED) ? SERVER_ALLOWED.map(String) : [];
        // If ADD_BOT_ON_MANY_SERVER is true, LEAVE_AUTO is forced false
        cfg.DASHBOARD.SERVERS.LEAVE_AUTO = addOnMany ? false : Boolean(LEAVE_AUTO);
        writeSettingsCfg(cfg);
        res.json({ success: true, serversCfg: cfg.DASHBOARD.SERVERS });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ── GET /settings/bot-guilds (SHIPS only) ── */
app.get('/settings/bot-guilds', require('./middleware/auth'), async (req, res) => {
    if (!getIsShip(req.session.user?.id)) return res.status(403).json({ error: 'Forbidden' });
    const { getClient } = require('./utils/botClient');
    const botClient = getClient();
    if (!botClient) return res.json({ guilds: [] });
    const cfg = readSettingsCfg();
    const allowed = (cfg.DASHBOARD?.SERVERS?.SERVER_ALLOWED) || [];
    const guilds = [];
    for (const [, guild] of botClient.guilds.cache) {
        let ownerTag = guild.ownerId;
        try {
            const owner = await guild.members.fetch(guild.ownerId).catch(() => null);
            if (owner) ownerTag = owner.user.displayName || owner.user.username;
        } catch (_) {}
        guilds.push({
            id:          guild.id,
            name:        guild.name,
            icon:        guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64` : null,
            memberCount: guild.memberCount,
            ownerId:     guild.ownerId,
            ownerTag,
            inAllowed:   allowed.includes(guild.id),
        });
    }
    guilds.sort((a, b) => b.memberCount - a.memberCount);
    res.json({ guilds });
});

/* ── POST /settings/guild-leave (SHIPS only) ── */
app.post('/settings/guild-leave', require('./middleware/auth'), express.json(), async (req, res) => {
    if (!getIsShip(req.session.user?.id)) return res.status(403).json({ error: 'Forbidden' });
    const { guildId, deleteData } = req.body;
    if (!guildId || !/^\d{17,20}$/.test(String(guildId))) return res.status(400).json({ error: 'Invalid guildId' });
    const { getClient } = require('./utils/botClient');
    const botClient = getClient();
    if (!botClient) return res.status(503).json({ error: 'Bot not available' });
    const guild = botClient.guilds.cache.get(String(guildId));
    if (!guild) return res.status(404).json({ error: 'Guild not found in bot cache' });
    try {
        await guild.leave();
        if (deleteData) {
            const dbPath = path.join(__dirname, 'database', String(guildId));
            if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { recursive: true, force: true });
        }
        // Log the leave event
        try {
            dashLogs.addEntry({
                type:        'guild_leave',
                guildId:     guild.id,
                guildName:   guild.name,
                guildIcon:   guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64` : null,
                byUserId:    req.session.user?.id,
                byUsername:  req.session.user?.username,
                deleteData:  !!deleteData,
            });
        } catch (_) {}
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ── GET /settings/logs (SHIPS only) ── */
app.get('/settings/logs', require('./middleware/auth'), (req, res) => {
    if (!getIsShip(req.session.user?.id)) return res.status(403).json({ error: 'Forbidden' });
    const data = dashLogs.getAll();
    // Attach ships list so UI knows who needs to approve
    const cfg   = readSettingsCfg();
    const ships = (cfg.DASHBOARD?.SHIPS || []).map(String);
    res.json({ entries: data.entries, clearRequest: data.clearRequest, ships });
});

/* ── POST /settings/logs/clear-request (SHIPS only) ── */
app.post('/settings/logs/clear-request', require('./middleware/auth'), express.json(), (req, res) => {
    if (!getIsShip(req.session.user?.id)) return res.status(403).json({ error: 'Forbidden' });
    const cfg   = readSettingsCfg();
    const ships = (cfg.DASHBOARD?.SHIPS || []).map(String);
    const user  = req.session.user;
    const existing = dashLogs.getAll().clearRequest;
    if (existing) return res.status(409).json({ error: 'already_pending', clearRequest: existing });
    const clearRequest = dashLogs.requestClear(user.id, user.username || user.displayName, ships);
    res.json({ success: true, clearRequest });
});

/* ── POST /settings/logs/clear-vote (SHIPS only) ── */
app.post('/settings/logs/clear-vote', require('./middleware/auth'), express.json(), (req, res) => {
    if (!getIsShip(req.session.user?.id)) return res.status(403).json({ error: 'Forbidden' });
    const { approve } = req.body;
    const result = dashLogs.vote(req.session.user.id, !!approve);
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

/* ── POST /settings/logs/clear-cancel (SHIPS only) ── */
app.post('/settings/logs/clear-cancel', require('./middleware/auth'), express.json(), (req, res) => {
    if (!getIsShip(req.session.user?.id)) return res.status(403).json({ error: 'Forbidden' });
    const result = dashLogs.cancelRequest(req.session.user.id);
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

/* ═══════════════════════════════════════════════════════════════════════════
   Auto Backup MongoDB — /settings/backup (SHIPS only)
   ═══════════════════════════════════════════════════════════════════════════ */
const _backupEng = require('./utils/backupEngine');
// Initialise once server is ready (non-blocking)
setImmediate(() => {
    const sourceUri = process.env.MONGODB;
    if (sourceUri) {
        _backupEng.engine.init(sourceUri).catch(e =>
            logger.warn('BackupEngine init failed', { category: 'backup', error: e.message }),
        );
    }
});

/* GET /settings/backup — list targets (URIs always masked) */
app.get('/settings/backup', require('./middleware/auth'), (req, res) => {
    if (!getIsShip(req.session.user?.id)) return res.status(403).json({ error: 'Forbidden' });
    const { _getTargets, decryptUri, maskUri, maskWebhook } = _backupEng;
    const stats   = _backupEng.engine.getStats();
    const targets = _getTargets().map(t => {
        const st = stats[t.id] || {};
        return {
            id:             t.id,
            name:           t.name,
            uriMasked:      t.uri_enc ? maskUri(decryptUri(t.uri_enc) || '') : '(unreadable)',
            mode:           t.mode,
            scheduleMs:     t.scheduleMs || null,
            enabled:        t.enabled,
            notifyWebhooks: (t.notifyWebhooks || []).map(w => maskWebhook(w)),
            lastRun:        st.lastRun    || t.lastRun    || null,
            lastStatus:     st.lastStatus || t.lastStatus || null,
            stats: {
                success:   st.success   || 0,
                failed:    st.failed    || 0,
                totalDocs: st.totalDocs || 0,
            },
            nextAt: _backupEng.engine.getSchedulerNextAt(t.id),
        };
    });
    res.json({ targets });
});

/* POST /settings/backup — add a new backup target */
app.post('/settings/backup', require('./middleware/auth'), express.json(), async (req, res) => {
    if (!getIsShip(req.session.user?.id)) return res.status(403).json({ error: 'Forbidden' });
    const { name, uri, mode, scheduleMs, enabled, notifyWebhooks } = req.body;

    if (!name || typeof name !== 'string' || !name.trim() || name.trim().length > 80)
        return res.status(400).json({ error: 'Name must be 1–80 characters' });
    if (!uri || typeof uri !== 'string' || !/^mongodb(\+srv)?:\/\//.test(uri.trim()))
        return res.status(400).json({ error: 'Invalid MongoDB URI' });
    if (!['changestream', 'queue', 'schedule'].includes(mode))
        return res.status(400).json({ error: 'Invalid mode' });
    if (mode === 'schedule') {
        const ms = Number(scheduleMs);
        if (!ms || ms < 60_000 || ms > 30 * 24 * 3600_000)
            return res.status(400).json({ error: 'scheduleMs must be 60 000 – 2 592 000 000 ms' });
    }

    const { encryptUri, _getTargets, _saveTargets } = _backupEng;
    const id = require('crypto').randomBytes(8).toString('hex');
    const target = {
        id,
        name:           name.trim(),
        uri_enc:        encryptUri(uri.trim()),
        mode,
        scheduleMs:     mode === 'schedule' ? Number(scheduleMs) : null,
        enabled:        enabled !== false,
        notifyWebhooks: Array.isArray(notifyWebhooks)
            ? notifyWebhooks
                .filter(w => typeof w === 'string' && /^https:\/\/discord\.com\/api\/webhooks\//.test(w))
                .slice(0, 20)
            : [],
        lastRun:    null,
        lastStatus: null,
    };
    const targets = _getTargets();
    targets.push(target);
    _saveTargets(targets);

    if (target.enabled) {
        _backupEng.engine._startTarget(target).catch(e =>
            logger.warn(`BackupEngine: failed to start target "${target.name}"`, {
                category: 'backup', error: e.message,
            }),
        );
    }
    res.json({ success: true, id });
});

/* PUT /settings/backup/:id — update an existing target */
app.put('/settings/backup/:id', require('./middleware/auth'), express.json(), async (req, res) => {
    if (!getIsShip(req.session.user?.id)) return res.status(403).json({ error: 'Forbidden' });
    const { id } = req.params;
    if (!/^[0-9a-f]{16}$/.test(id)) return res.status(400).json({ error: 'Invalid id' });

    const { encryptUri, _getTargets, _saveTargets } = _backupEng;
    const targets = _getTargets();
    const idx     = targets.findIndex(t => t.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Target not found' });

    const t = { ...targets[idx] };
    const { name, uri, mode, scheduleMs, enabled, notifyWebhooks, webhooksAppend, webhooksRemove } = req.body;

    if (name !== undefined) {
        if (typeof name !== 'string' || !name.trim() || name.trim().length > 80)
            return res.status(400).json({ error: 'Name must be 1–80 characters' });
        t.name = name.trim();
    }
    if (uri && typeof uri === 'string' && uri.trim()) {
        if (!/^mongodb(\+srv)?:\/\//.test(uri.trim()))
            return res.status(400).json({ error: 'Invalid MongoDB URI' });
        t.uri_enc = encryptUri(uri.trim());
    }
    if (mode !== undefined) {
        if (!['changestream', 'queue', 'schedule'].includes(mode))
            return res.status(400).json({ error: 'Invalid mode' });
        t.mode = mode;
    }
    if (scheduleMs !== undefined) {
        const ms = Number(scheduleMs);
        if (t.mode === 'schedule' && (ms < 60_000 || ms > 30 * 24 * 3600_000))
            return res.status(400).json({ error: 'scheduleMs out of range' });
        t.scheduleMs = ms || null;
    }
    if (enabled !== undefined) t.enabled = Boolean(enabled);

    // Webhooks: remove by index, then append new ones
    if (Array.isArray(webhooksRemove) && webhooksRemove.length) {
        const removeSet = new Set(webhooksRemove.map(Number).filter(n => !isNaN(n)));
        t.notifyWebhooks = (t.notifyWebhooks || []).filter((_, i) => !removeSet.has(i));
    }
    if (Array.isArray(webhooksAppend)) {
        const valid = webhooksAppend.filter(w =>
            typeof w === 'string' && /^https:\/\/discord\.com\/api\/webhooks\//.test(w));
        t.notifyWebhooks = [...(t.notifyWebhooks || []), ...valid].slice(0, 20);
    }
    if (Array.isArray(notifyWebhooks)) {
        t.notifyWebhooks = notifyWebhooks
            .filter(w => typeof w === 'string' && /^https:\/\/discord\.com\/api\/webhooks\//.test(w))
            .slice(0, 20);
    }

    targets[idx] = t;
    _saveTargets(targets);
    _backupEng.engine.reloadTarget(id).catch(() => {});
    res.json({ success: true });
});

/* DELETE /settings/backup/:id — remove a target */
app.delete('/settings/backup/:id', require('./middleware/auth'), async (req, res) => {
    if (!getIsShip(req.session.user?.id)) return res.status(403).json({ error: 'Forbidden' });
    const { id } = req.params;
    if (!/^[0-9a-f]{16}$/.test(id)) return res.status(400).json({ error: 'Invalid id' });
    const { _getTargets, _saveTargets } = _backupEng;
    const targets = _getTargets();
    const idx     = targets.findIndex(t => t.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Target not found' });
    await _backupEng.engine._stopTarget(id).catch(() => {});
    targets.splice(idx, 1);
    _saveTargets(targets);
    res.json({ success: true });
});

/* POST /settings/backup/test — test a URI (can be called before saving) */
app.post('/settings/backup/test', require('./middleware/auth'), express.json(), async (req, res) => {
    if (!getIsShip(req.session.user?.id)) return res.status(403).json({ error: 'Forbidden' });
    const { uri, id } = req.body;
    let resolvedUri = uri;
    if (!resolvedUri && id) {
        if (!/^[0-9a-f]{16}$/.test(id)) return res.status(400).json({ error: 'Invalid id' });
        const { _getTargets, decryptUri } = _backupEng;
        const target = _getTargets().find(t => t.id === id);
        if (!target) return res.status(404).json({ error: 'Target not found' });
        resolvedUri = target.uri_enc ? decryptUri(target.uri_enc) : null;
        if (!resolvedUri) return res.status(400).json({ error: 'Cannot decrypt URI' });
    }
    if (!resolvedUri || !/^mongodb(\+srv)?:\/\//.test(resolvedUri))
        return res.status(400).json({ error: 'Invalid MongoDB URI' });
    try {
        const result = await _backupEng.engine.testConnection(resolvedUri);
        res.json(result);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

/* POST /settings/backup/:id/run — trigger an immediate full backup */
app.post('/settings/backup/:id/run', require('./middleware/auth'), async (req, res) => {
    if (!getIsShip(req.session.user?.id)) return res.status(403).json({ error: 'Forbidden' });
    const { id } = req.params;
    if (!/^[0-9a-f]{16}$/.test(id)) return res.status(400).json({ error: 'Invalid id' });
    try {
        const result = await _backupEng.engine.runNow(id);
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/dashboard', require('./middleware/auth'), (req, res) => {
    const { getClient }  = require('./utils/botClient');
    const guildDb        = require('./utils/guildDb');
    const botClient      = getClient();
    const raw            = req.session.guilds || [];

    const guilds = raw.map(g => {
        const inBot = botClient ? botClient.guilds.cache.has(g.id) : guildDb.exists(g.id);
        return { ...g, inBot };
    });

    res.render('home', {
        user:     req.session.user,
        guilds,
        clientId: process.env.CLIENT_ID || '',
        t:        req.t,
        lang:     req.lang,
        isShip:   getIsShip(req.session.user?.id),
    });
});

// ── Guild activity stats API ───────────────────────────────────────────────
app.get('/dashboard/:guildId/stats/activity', require('./middleware/auth'), (req, res) => {
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const tracker = require('./utils/activityTracker');
        return res.json(tracker.getLast24h(guildId));
    } catch (_) {
        return res.json({ joins: [], leaves: [], messages: [], voice: [], labels: [] });
    }
});

/* ── Guild banner middleware — injects guildBanner into res.locals for ALL
 *    /dashboard/:guildId/* pages so the sidebar server card always works.  ── */
app.use('/dashboard/:guildId', (req, res, next) => {
    const { getClient } = require('./utils/botClient');
    const botClient = getClient();
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    const guildInfo = raw.find(g => g.id === guildId);
    const discordGuild = botClient ? botClient.guilds.cache.get(guildId) : null;
    res.locals.guildBanner  = discordGuild?.banner || guildInfo?.banner || null;
    res.locals.memberCount  = discordGuild ? discordGuild.memberCount : null;
    res.locals.onlineCount  = discordGuild
        ? discordGuild.members.cache.filter(m => m.presence && m.presence.status !== 'offline').size || null
        : null;
    next();
});

app.get('/dashboard/:guildId', require('./middleware/auth'), (req, res) => {
    const guildDb   = require('./utils/guildDb');
    const { getClient } = require('./utils/botClient');
    const getUnicodeFlagIcon = require('country-flag-icons/unicode').default;
    const botClient = getClient();
    const { guildId } = req.params;

    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.redirect('/dashboard');

    const inBot = botClient ? botClient.guilds.cache.has(guildId) : guildDb.exists(guildId);
    if (!inBot) return res.redirect('/dashboard');

    const guildInfo = raw.find(g => g.id === guildId);
    const data      = guildDb.read(guildId, 'settings');

    // All guilds the user has admin perms in (for nav sidebar) — include bot status
    const guilds = raw.map(g => ({
        ...g,
        inBot: botClient ? botClient.guilds.cache.has(g.id) : guildDb.exists(g.id),
    }));

    // Levels data for this guild
    const levelsData = guildDb.read(guildId, 'levels', {});
    const userId     = req.session.user.id;
    const userLevel  = levelsData[userId] || null;
    let rank = null;
    if (userLevel) {
        const sorted = Object.entries(levelsData)
            .map(([id, d]) => ({ id, xp: d.xp || 0 }))
            .sort((a, b) => b.xp - a.xp);
        const idx = sorted.findIndex(u => u.id === userId);
        rank = idx >= 0 ? idx + 1 : null;
    }

    // Country flag emojis

    // Server stats from Discord cache
    const discordGuild  = botClient ? botClient.guilds.cache.get(guildId) : null;
    const memberCount   = discordGuild ? discordGuild.memberCount : null;
    const channelCount  = discordGuild ? discordGuild.channels.cache.size : null;
    const roleCount     = discordGuild ? discordGuild.roles.cache.size : null;
    const botPing       = botClient ? Math.round(botClient.ws.ping) : null;
    // Banner: try from cache first, fallback to OAuth guildInfo
    const guildBanner   = discordGuild?.banner || guildInfo?.banner || null;
    // Gateway status: ws.status === 0 = READY
    const gatewayOnline = botClient ? (botClient.ws.status === 0) : false;
    // Online member count (only if presences cached)
    const onlineCount   = discordGuild
        ? discordGuild.members.cache.filter(m => m.presence && m.presence.status !== 'offline').size || null
        : null;

    // Module status from DB
    const ticketsData  = guildDb.read(guildId, 'tickets', {});
    const panelCount   = Object.keys((ticketsData && ticketsData.panels) || {}).length;

    // protection lives in dashboard DB (written by both bot system and dashboard)
    const protData     = guildDb.read(guildId, 'protection', null);

    // Read module configs via guildDb (syncs to MongoDB)
    const autoRoleEntry      = guildDb.read(guildId, 'auto_role', null);
    const autoResponderEntry = guildDb.read(guildId, 'auto_responder', null);
    const suggestionsEntry   = guildDb.read(guildId, 'suggestions_config', null);
    const staffPointsData    = guildDb.read(guildId, 'staff_points', null);
    const interactionPtsData = guildDb.read(guildId, 'interaction_points', null);

    const moduleStatus = {
        protection:        !!(protData && Object.keys(protData).length > 0),
        tickets:           panelCount > 0,
        autoRoles:         !!(autoRoleEntry && autoRoleEntry.enabled === true),
        levels:            Object.keys(levelsData).length > 0,
        autoResponder:     !!(autoResponderEntry && autoResponderEntry.enabled === true),
        suggestions:       !!(suggestionsEntry && suggestionsEntry.enabled === true),
        staffPoints:       !!(staffPointsData && staffPointsData.enabled === true),
        interactionPoints: !!(interactionPtsData && interactionPtsData.enabled === true),
    };

    res.render('guild', {
        user:       req.session.user,
        guildInfo,
        guilds,
        data,
        userLevel,
        rank,
        t:          req.t,
        lang:       req.lang,
        guildId,
        isShip:     getIsShip(req.session.user?.id),
        memberCount,
        channelCount,
        roleCount,
        botPing,
        guildBanner,
        gatewayOnline,
        onlineCount,
        moduleStatus,
    });
});

app.get('/dashboard/:guildId/setting', require('./middleware/auth'), async (req, res) => {
    const guildDb   = require('./utils/guildDb');
    const { getClient } = require('./utils/botClient');
    const getUnicodeFlagIcon = require('country-flag-icons/unicode').default;
    const botClient = getClient();
    const { guildId } = req.params;

    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.redirect('/dashboard');

    const inBot = botClient ? botClient.guilds.cache.has(guildId) : guildDb.exists(guildId);
    if (!inBot) return res.redirect('/dashboard');

    const guildInfo = raw.find(g => g.id === guildId);
    const guilds = raw.map(g => ({
        ...g,
        inBot: botClient ? botClient.guilds.cache.has(g.id) : guildDb.exists(g.id),
    }));


    // System settings
    const settingsData   = guildDb.read(guildId, 'settings', {});
    const systemSettings = settingsData.system && settingsData.system.COMMANDS
        ? { PREFIX: settingsData.system.PREFIX || '!', COMMANDS: settingsData.system.COMMANDS }
        : { PREFIX: '!', COMMANDS: { ENABLE_PREFIX: true, ENABLE_SLASH_COMMANDS: true, ACTIVITY_TYPE: 'none', ACTIVITY_NAME: '', STATUS: 'ONLINE' } };

    // Bot profile info
    let botInfo = { id: '', username: '', avatar: null, banner: null, description: '' };
    if (botClient && botClient.user) {
        const u = botClient.user;
        // Fetch application to get description
        let appDesc = '';
        try {
            if (botClient.application) {
                await botClient.application.fetch();
                appDesc = botClient.application.description || '';
            }
        } catch (_) {}
        botInfo = {
            id: u.id,
            username: u.username,
            avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=256` : null,
            banner: u.banner ? `https://cdn.discordapp.com/banners/${u.id}/${u.banner}.png?size=480` : null,
            description: appDesc,
        };
    }

    // Protection page access permissions
    const guildProtData  = guildDb.read(guildId, 'protection', null);
    const globalProtCfg  = (readSettingsCfg().protection) || {};
    const protUserPerms  = ((guildProtData || globalProtCfg).user_permissions || []).map(String);
    const protOwners     = ((readSettingsCfg().DASHBOARD || {}).OWNERS || []).map(String);
    const actorId        = String(req.session.user?.id || '');
    const isOwner        = protUserPerms.length === 0
        ? protOwners.includes(actorId)
        : protUserPerms[0] === actorId || protOwners.includes(actorId);

    // Resolve user info for perm list
    let protectionPerms = [];
    if (botClient && protUserPerms.length > 0) {
        for (const uid of protUserPerms) {
            try {
                const u = await botClient.users.fetch(uid);
                protectionPerms.push({
                    id:          u.id,
                    username:    u.username,
                    displayName: u.displayName || u.globalName || u.username,
                    avatar:      u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : null,
                });
            } catch (_) {
                protectionPerms.push({ id: uid, username: uid, displayName: uid, avatar: null });
            }
        }
    }

    res.render('setting', {
        user: req.session.user,
        guildInfo,
        guilds,
        t:        req.t,
        lang:     req.lang,
        guildId,
        systemSettings,
        botInfo,
        isShip: getIsShip(req.session.user?.id),
        protectionPerms,
        isOwner,
    });
});

/* ── Setting: Save system command settings ── */
app.post('/dashboard/:guildId/setting/save', require('./middleware/auth'), (req, res) => {
    try {
        const guildDb   = require('./utils/guildDb');
        const { guildId } = req.params;
        const { getClient } = require('./utils/botClient');
        const botClient = getClient();

        const settingsData = guildDb.read(guildId, 'settings', {});
        settingsData.system = settingsData.system || {};
        settingsData.system.COMMANDS = req.body.COMMANDS || req.body;

        // Validate and save PREFIX
        const rawPrefix = req.body.PREFIX !== undefined ? req.body.PREFIX : (req.body.COMMANDS && req.body.COMMANDS.PREFIX);
        if (rawPrefix !== undefined) {
            const prefix = String(rawPrefix);
            const allowedPrefixes = ['!', '#', '$', '%', '&', '?'];
            if (!allowedPrefixes.includes(prefix)) {
                return res.status(400).json({ error: 'Invalid PREFIX. Allowed values: ! # $ % & ?' });
            }
            settingsData.system.PREFIX = prefix;
        }

        guildDb.write(guildId, 'settings', settingsData);

        // Apply presence/status to live bot if available
        if (botClient && botClient.user) {
            const cmds    = settingsData.system.COMMANDS;
            const status  = (cmds.STATUS || 'ONLINE').toLowerCase();
            const actType = cmds.ACTIVITY_TYPE || 'none';
            const actName = cmds.ACTIVITY_NAME || '';
            const ActivityType = {
                Playing: 0, Streaming: 1, Listening: 2, Watching: 3, Custom: 4, Competing: 5,
            };
            const presenceOptions = { status };
            if (actType !== 'none' && actName) {
                presenceOptions.activities = [{ name: actName, type: ActivityType[actType] ?? 0 }];
            } else {
                presenceOptions.activities = [];
            }
            try { botClient.user.setPresence(presenceOptions); } catch (_) {}
        }

        res.json({ success: true });
    } catch (err) {
        logger.error('setting/save failed', { category: 'dashboard', error: err.message, stack: err.stack });
        res.status(500).json({ error: err.message });
    }
});

/* ── Setting: Change bot description ── */
app.post('/dashboard/:guildId/setting/bot-description', require('./middleware/auth'), async (req, res) => {
    try {
        const { getClient } = require('./utils/botClient');
        const botClient = getClient();
        if (!botClient || !botClient.user) return res.status(503).json({ error: 'Bot offline' });

        const description = (req.body.description ?? '').trim().slice(0, 400);
        await botClient.rest.patch('/applications/@me', { body: { description } });
        if (botClient.application) await botClient.application.fetch();
        res.json({ success: true, description });
    } catch (err) {
        logger.error('setting/bot-description failed', { category: 'dashboard', error: err.message, stack: err.stack });
        res.status(500).json({ error: err.message });
    }
});

/* ── Setting: Change bot username ── */
app.post('/dashboard/:guildId/setting/bot-username', require('./middleware/auth'), async (req, res) => {
    try {
        const { getClient } = require('./utils/botClient');
        const botClient = getClient();
        if (!botClient || !botClient.user) return res.status(503).json({ error: 'Bot offline' });

        const username = (req.body.username || '').trim();
        if (!username || username.length < 2 || username.length > 32)
            return res.status(400).json({ error: 'Username must be 2-32 characters' });

        await botClient.user.setUsername(username);
        res.json({ success: true, username: botClient.user.username });
    } catch (err) {
        logger.error('setting/bot-username failed', { category: 'dashboard', error: err.message, stack: err.stack });
        res.status(500).json({ error: err.message });
    }
});

/* ── Setting: Change bot avatar ── */
const multerMemAvatar = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
app.post('/dashboard/:guildId/setting/bot-avatar', require('./middleware/auth'), multerMemAvatar.single('file'), async (req, res) => {
    try {
        const { getClient } = require('./utils/botClient');
        const botClient = getClient();
        if (!botClient || !botClient.user) return res.status(503).json({ error: 'Bot offline' });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        await botClient.user.setAvatar(req.file.buffer);
        const u = botClient.user;
        const avatar = u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=256` : null;
        res.json({ success: true, avatar });
    } catch (err) {
        logger.error('setting/bot-avatar failed', { category: 'dashboard', error: err.message, stack: err.stack });
        res.status(500).json({ error: err.message });
    }
});

/* ── Setting: Change bot banner ── */
const multerMemBanner = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
app.post('/dashboard/:guildId/setting/bot-banner', require('./middleware/auth'), multerMemBanner.single('file'), async (req, res) => {
    try {
        const { getClient } = require('./utils/botClient');
        const botClient = getClient();
        if (!botClient || !botClient.user) return res.status(503).json({ error: 'Bot offline' });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        await botClient.user.setBanner(req.file.buffer);
        const u = botClient.user;
        const banner = u.banner ? `https://cdn.discordapp.com/banners/${u.id}/${u.banner}.png?size=480` : null;
        res.json({ success: true, banner });
    } catch (err) {
        if (err.code === 50035 && err.rawError?.errors?.banner) {
            const bannerErr = err.rawError.errors.banner;
            const isRateLimit = JSON.stringify(bannerErr).includes('BANNER_RATE_LIMIT');
            if (isRateLimit) {
                logger.warn('setting/bot-banner rate-limited by Discord', { category: 'dashboard' });
                return res.status(429).json({ error: 'You are changing the banner too fast. Please wait a moment and try again.' });
            }
        }
        logger.error('setting/bot-banner failed', { category: 'dashboard', error: err.message, stack: err.stack });
        res.status(500).json({ error: err.message });
    }
});

/* ── Automation Hub ─────────────────────────────────── */
app.get('/dashboard/:guildId/automations', require('./middleware/auth'), async (req, res) => {
    const guildDb   = require('./utils/guildDb');
    const { getClient } = require('./utils/botClient');
    const EmbedMessage     = require('../systems/schemas/EmbedMessage');
    const ComponentMessage = require('../systems/schemas/ComponentMessage');
    const AutomationLink   = require('../systems/schemas/AutomationLink');
    const botClient = getClient();
    const { guildId } = req.params;

    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.redirect('/dashboard');
    const inBot = botClient ? botClient.guilds.cache.has(guildId) : guildDb.exists(guildId);
    if (!inBot) return res.redirect('/dashboard');

    const guildInfo = raw.find(g => g.id === guildId);
    const guilds    = raw.map(g => ({ ...g, inBot: botClient ? botClient.guilds.cache.has(g.id) : guildDb.exists(g.id) }));
    const botInfo   = botClient?.user
        ? { username: botClient.user.username, avatar: botClient.user.displayAvatarURL({ size: 64 }) }
        : { username: 'Bot', avatar: null };

    let embedMessages = [], componentMessages = [], automationLinks = [];
    try { embedMessages     = await EmbedMessage.find({ guildId }).sort({ updatedAt: -1 }).lean(); } catch (_) {}
    try { componentMessages = await ComponentMessage.find({ guildId }).sort({ updatedAt: -1 }).lean(); } catch (_) {}
    try { automationLinks   = await AutomationLink.find({ guildId }).sort({ createdAt: -1 }).lean(); } catch (_) {}

    // Resolve source/target names for display in the UI
    const docMap = {};
    [...embedMessages, ...componentMessages].forEach(d => { docMap[d._id.toString()] = d; });
    automationLinks = automationLinks.map(link => ({
        ...link,
        sourceName: docMap[link.sourceId]?.name || link.sourceId,
        targetName: docMap[link.targetId]?.name || link.targetId,
    }));

    res.render('automations', {
        user: req.session.user,
        guildInfo,
        guilds,
        botInfo,
        guildId,
        embedMessages,
        componentMessages,
        automationLinks,
        t: req.t,
        lang: req.lang,
        isShip: getIsShip(req.session.user?.id),
    });
});

/* ── Automations: Link CRUD ─────────────────────────── */

app.post('/dashboard/:guildId/automations/links/save', require('./middleware/auth'), async (req, res) => {
    const AutomationLink = require('../systems/schemas/AutomationLink');
    const { guildId } = req.params;

    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'forbidden' });

    try {
        const { name, sourceKind, sourceId, sourceButtonId, targetKind, targetId, sendMode } = req.body;
        if (!sourceKind || !sourceId || !targetKind || !targetId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        const link = await AutomationLink.create({
            guildId,
            name:           (name || '').trim() || 'Untitled Link',
            sourceKind,
            sourceId,
            sourceButtonId: (sourceButtonId || '').trim(),
            targetKind,
            targetId,
            sendMode:       sendMode || 'reply',
            createdBy:      req.session.user?.id || '',
        });
        res.json({ ok: true, link });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch('/dashboard/:guildId/automations/links/:id/toggle', require('./middleware/auth'), async (req, res) => {
    const AutomationLink = require('../systems/schemas/AutomationLink');
    const { guildId, id } = req.params;

    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'forbidden' });

    try {
        const link = await AutomationLink.findOne({ _id: id, guildId });
        if (!link) return res.status(404).json({ error: 'Not found' });
        link.enabled = !link.enabled;
        await link.save();
        res.json({ ok: true, enabled: link.enabled });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/dashboard/:guildId/automations/links/:id', require('./middleware/auth'), async (req, res) => {
    const AutomationLink = require('../systems/schemas/AutomationLink');
    const { guildId, id } = req.params;

    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'forbidden' });

    try {
        const result = await AutomationLink.deleteOne({ _id: id, guildId });
        if (!result.deletedCount) return res.status(404).json({ error: 'Not found' });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch('/dashboard/:guildId/automations/links/:id/update', require('./middleware/auth'), async (req, res) => {
    const AutomationLink = require('../systems/schemas/AutomationLink');
    const { guildId, id } = req.params;

    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'forbidden' });

    try {
        const { name, sourceKind, sourceId, sourceButtonId, targetKind, targetId, sendMode } = req.body;
        if (!sourceKind || !sourceId || !targetKind || !targetId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        const link = await AutomationLink.findOneAndUpdate(
            { _id: id, guildId },
            {
                name:           (name || '').trim() || 'Untitled Link',
                sourceKind,
                sourceId,
                sourceButtonId: (sourceButtonId || '').trim(),
                targetKind,
                targetId,
                sendMode:       sendMode || 'reply',
            },
            { new: true }
        );
        if (!link) return res.status(404).json({ error: 'Not found' });
        res.json({ ok: true, link });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ── Messaging: Embed Messages ──────────────────────── */
app.get('/dashboard/:guildId/embeds', require('./middleware/auth'), async (req, res) => {
    const guildDb   = require('./utils/guildDb');
    const { getClient } = require('./utils/botClient');
    const EmbedMessage = require('../systems/schemas/EmbedMessage');
    const botClient = getClient();
    const { guildId } = req.params;

    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.redirect('/dashboard');
    const inBot = botClient ? botClient.guilds.cache.has(guildId) : guildDb.exists(guildId);
    if (!inBot) return res.redirect('/dashboard');

    const guildInfo = raw.find(g => g.id === guildId);
    const guilds    = raw.map(g => ({ ...g, inBot: botClient ? botClient.guilds.cache.has(g.id) : guildDb.exists(g.id) }));

    // Fetch channels from bot
    let guildChannels = [];
    if (botClient) {
        const guild = botClient.guilds.cache.get(guildId);
        if (guild) {
            guildChannels = guild.channels.cache
                .filter(c => c.type === 0)
                .map(c => ({ id: c.id, name: c.name }))
                .sort((a, b) => a.name.localeCompare(b.name));
        }
    }

    // Load saved embed messages for this guild
    let embedMessages = [];
    try {
        embedMessages = await EmbedMessage.find({ guildId }).sort({ updatedAt: -1 }).lean();
    } catch (_) {}

    // Guild emojis for emoji picker
    let guildEmojis = [];
    if (botClient) {
        const guild = botClient.guilds.cache.get(guildId);
        if (guild) {
            guildEmojis = guild.emojis.cache
                .map(e => ({ id: e.id, name: e.name, animated: e.animated, url: `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? 'gif' : 'png'}?size=32` }))
                .sort((a, b) => a.name.localeCompare(b.name));
        }
    }
    const botInfo = botClient?.user
        ? { username: botClient.user.username, avatar: botClient.user.displayAvatarURL({ size: 64 }) }
        : { username: 'Bot', avatar: null };

    // Guild roles for permissions system
    let guildRoles = [];
    if (botClient) {
        const guild = botClient.guilds.cache.get(guildId);
        if (guild) {
            guildRoles = guild.roles.cache
                .filter(r => !r.managed && r.name !== '@everyone')
                .map(r => ({ id: r.id, name: r.name, color: r.hexColor || '#99aab5', position: r.rawPosition, icon: r.iconURL() || null, unicodeEmoji: r.unicodeEmoji || null }))
                .sort((a, b) => b.position - a.position);
        }
    }

    res.render('embeds', {
        user: req.session.user, guildInfo, guilds,
        guildChannels, embedMessages,
        guildEmojis, botInfo, guildRoles,
        t: req.t, lang: req.lang, guildId,
        isShip: getIsShip(req.session.user?.id)
    });
});

/* ── Embeds API: list ────────────────────────────────── */
app.get('/dashboard/:guildId/embeds/api/list', require('./middleware/auth'), async (req, res) => {
    const EmbedMessage = require('../systems/schemas/EmbedMessage');
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const list = await EmbedMessage.find({ guildId }).sort({ updatedAt: -1 }).lean();
        res.json({ success: true, data: list });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ── Embed Templates: list ───────────────────────────── */
app.get('/dashboard/:guildId/embeds/api/templates', require('./middleware/auth'), async (req, res) => {
    const EmbedTemplate = require('../systems/schemas/EmbedTemplate');
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const list = await EmbedTemplate.find({ guildId }).sort({ createdAt: -1 }).lean();
        res.json({ success: true, data: list });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Embed Templates: save ───────────────────────────── */
app.post('/dashboard/:guildId/embeds/api/templates', require('./middleware/auth'), express.json(), async (req, res) => {
    const EmbedTemplate = require('../systems/schemas/EmbedTemplate');
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    const { name, description, machine } = req.body || {};
    if (!name || !machine) return res.status(400).json({ error: 'name and machine are required' });
    if (!machine.states || !machine.initial) return res.status(400).json({ error: 'machine must have states and initial' });
    try {
        const stateCount = Object.keys(machine.states).length;
        const doc = await EmbedTemplate.create({
            guildId,
            name:        String(name).trim().slice(0, 100),
            description: String(description || '').trim().slice(0, 200),
            machine,
            stateCount,
            createdBy:   req.session.userId || '',
        });
        res.json({ success: true, data: doc });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Embed Templates: delete ─────────────────────────── */
app.delete('/dashboard/:guildId/embeds/api/templates/:tid', require('./middleware/auth'), async (req, res) => {
    const EmbedTemplate = require('../systems/schemas/EmbedTemplate');
    const { guildId, tid } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const doc = await EmbedTemplate.findOneAndDelete({ _id: tid, guildId });
        if (!doc) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Embeds Trash: list ──────────────────────────────── */
app.get('/dashboard/:guildId/embeds/api/trash', require('./middleware/auth'), async (req, res) => {
    const EmbedTrash = require('../systems/schemas/EmbedTrash');
    const { guildId } = req.params;
    if (!( req.session.guilds || []).find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const list = await EmbedTrash.find({ guildId }).sort({ createdAt: -1 }).lean();
        res.json({ success: true, data: list });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Embeds Trash: restore ───────────────────────────── */
app.post('/dashboard/:guildId/embeds/api/trash/:tid/restore', require('./middleware/auth'), async (req, res) => {
    const EmbedTrash    = require('../systems/schemas/EmbedTrash');
    const EmbedMessage  = require('../systems/schemas/EmbedMessage');
    const { guildId, tid } = req.params;
    if (!(req.session.guilds || []).find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const trash = await EmbedTrash.findOne({ _id: tid, guildId }).lean();
        if (!trash) return res.status(404).json({ error: 'Not found in trash' });
        // Restore — use a new name if original name is taken
        let name = trash.name;
        const existing = await EmbedMessage.findOne({ guildId, name }).lean();
        if (existing) name = name + ' (restored)';
        // Rebuild componentIds from machine
        const componentIds = [];
        if (trash.machine?.states) {
            for (const s of Object.values(trash.machine.states)) {
                for (const row of (s.components || [])) {
                    if (row.type === 'buttons') {
                        for (const btn of (row.buttons || [])) { if (btn.customId) componentIds.push(btn.customId); }
                    } else if (row.type === 'select' && row.select?.customId) {
                        componentIds.push(row.select.customId);
                    }
                }
            }
        }
        const initialState      = trash.machine?.states?.[trash.machine?.initial] || {};
        const doc = await EmbedMessage.create({
            guildId,
            name,
            channelId:    trash.channelId  || '',
            messageId:    trash.messageId  || null,
            machine:      trash.machine    || null,
            epTheme:      !!trash.epTheme,
            componentIds,
            embeds:       initialState.embeds     || [],
            components:   initialState.components || [],
            createdBy:    req.session.user?.id || '',
        });
        await EmbedTrash.findByIdAndDelete(tid);
        res.json({ success: true, data: doc });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Embeds Trash: permanent delete ─────────────────── */
app.delete('/dashboard/:guildId/embeds/api/trash/:tid', require('./middleware/auth'), async (req, res) => {
    const EmbedTrash = require('../systems/schemas/EmbedTrash');
    const { guildId, tid } = req.params;
    if (!(req.session.guilds || []).find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const doc = await EmbedTrash.findOneAndDelete({ _id: tid, guildId });
        if (!doc) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Embeds Versions: list ───────────────────────────── */
app.get('/dashboard/:guildId/embeds/api/:id/versions', require('./middleware/auth'), async (req, res) => {
    const EmbedVersion = require('../systems/schemas/EmbedVersion');
    const { guildId, id } = req.params;
    if (!(req.session.guilds || []).find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const list = await EmbedVersion.find({ docId: id, guildId }).sort({ version: -1 }).lean();
        res.json({ success: true, data: list });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Embeds Versions: create manual snapshot ────────── */
app.post('/dashboard/:guildId/embeds/api/:id/versions', require('./middleware/auth'), express.json(), async (req, res) => {
    const EmbedVersion = require('../systems/schemas/EmbedVersion');
    const EmbedMessage = require('../systems/schemas/EmbedMessage');
    const { guildId, id } = req.params;
    if (!(req.session.guilds || []).find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const doc = await EmbedMessage.findOne({ _id: id, guildId }).lean();
        if (!doc) return res.status(404).json({ error: 'Not found' });
        const { label } = req.body || {};
        const lastVer = await EmbedVersion.findOne({ docId: id }).sort({ version: -1 }).lean();
        const version = await EmbedVersion.create({
            guildId,
            docId:       id,
            version:     (lastVer?.version || 0) + 1,
            label:       String(label || '').trim().slice(0, 80),
            machineName: doc.name,
            machine:     doc.machine,
            savedBy:     req.session.user?.id || '',
            autoSave:    false,
        });
        res.json({ success: true, data: version });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Embeds Versions: rollback ───────────────────────── */
app.post('/dashboard/:guildId/embeds/api/:id/versions/:vid/rollback', require('./middleware/auth'), async (req, res) => {
    const EmbedVersion = require('../systems/schemas/EmbedVersion');
    const EmbedMessage = require('../systems/schemas/EmbedMessage');
    const { guildId, id, vid } = req.params;
    if (!(req.session.guilds || []).find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const ver = await EmbedVersion.findOne({ _id: vid, docId: id, guildId }).lean();
        if (!ver) return res.status(404).json({ error: 'Version not found' });
        // Snapshot current before rollback
        const current = await EmbedMessage.findOne({ _id: id, guildId }).lean();
        if (current?.machine) {
            const last = await EmbedVersion.findOne({ docId: id }).sort({ version: -1 }).lean();
            await EmbedVersion.create({
                guildId, docId: id,
                version:     (last?.version || 0) + 1,
                label:       'Before rollback to v' + ver.version,
                machineName: current.name,
                machine:     current.machine,
                savedBy:     req.session.user?.id || '',
                autoSave:    true,
            });
        }
        const updated = await EmbedMessage.findOneAndUpdate(
            { _id: id, guildId },
            { $set: { machine: ver.machine, updatedBy: req.session.user?.id || '' } },
            { new: true }
        );
        if (!updated) return res.status(404).json({ error: 'Message not found' });
        try { require('../systems/emped').invalidateTriggerCache(); } catch (_) {}
        res.json({ success: true, data: updated });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Embeds Versions: delete one version ────────────── */
app.delete('/dashboard/:guildId/embeds/api/:id/versions/:vid', require('./middleware/auth'), async (req, res) => {
    const EmbedVersion = require('../systems/schemas/EmbedVersion');
    const { guildId, id, vid } = req.params;
    if (!(req.session.guilds || []).find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const doc = await EmbedVersion.findOneAndDelete({ _id: vid, docId: id, guildId });
        if (!doc) return res.status(404).json({ error: 'Version not found' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Embeds API: get one ─────────────────────────────── */
app.get('/dashboard/:guildId/embeds/api/:id', require('./middleware/auth'), async (req, res) => {
    const EmbedMessage = require('../systems/schemas/EmbedMessage');
    const { guildId, id } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const doc = await EmbedMessage.findOne({ _id: id, guildId }).lean();
        if (!doc) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true, data: doc });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ── Embeds API: save (create / update) ─────────────── */
app.post('/dashboard/:guildId/embeds/api/save', require('./middleware/auth'), express.json(), async (req, res) => {
    const EmbedMessage = require('../systems/schemas/EmbedMessage');
    const { getClient } = require('./utils/botClient');
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });

    const { _id, name, channelId, epTheme, machine, forceNew } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!channelId) return res.status(400).json({ error: 'Channel is required' });

    // ── Compute flat componentIds index from machine definition ──────────────
    // Includes all button.customId + selectMenu.customId values for fast lookup.
    const componentIds = [];
    if (machine?.states) {
        for (const s of Object.values(machine.states)) {
            for (const row of (s.components || [])) {
                if (row.type === 'buttons') {
                    for (const btn of (row.buttons || [])) {
                        if (btn.customId) componentIds.push(btn.customId);
                    }
                } else if (row.type === 'select' && row.select?.customId) {
                    componentIds.push(row.select.customId);
                }
            }
        }
    }

    // ── Get initial state's embeds + components for Discord send ─────────────
    const initialState = machine?.states?.[machine?.initial] || {};
    const initialEmbeds     = initialState.embeds     || [];
    const initialComponents = initialState.components || [];

    try {
        let doc;
        const updateData = {
            name: name.trim(), channelId,
            epTheme: !!epTheme,
            machine: machine || null,
            componentIds,
            // Keep legacy fields in sync with initial state for backward compat
            embeds:     initialEmbeds,
            components: initialComponents,
            updatedBy:  req.session.user?.id || '',
        };

        if (_id) {
            // ── Auto-snapshot the current machine before overwriting ──────────
            try {
                const EmbedVersion = require('../systems/schemas/EmbedVersion');
                const existing = await EmbedMessage.findOne({ _id, guildId }).lean();
                if (existing?.machine) {
                    const lastVer = await EmbedVersion.findOne({ docId: _id.toString() }).sort({ version: -1 }).lean();
                    await EmbedVersion.create({
                        guildId,
                        docId:       _id.toString(),
                        version:     (lastVer?.version || 0) + 1,
                        label:       '',
                        machineName: existing.name,
                        machine:     existing.machine,
                        savedBy:     req.session.user?.id || '',
                        autoSave:    true,
                    });
                    // Prune: keep only the 10 most recent auto-snapshots
                    const all = await EmbedVersion.find({ docId: _id.toString(), autoSave: true })
                        .sort({ version: -1 }).lean();
                    if (all.length > 10) {
                        const pruneIds = all.slice(10).map(v => v._id);
                        await EmbedVersion.deleteMany({ _id: { $in: pruneIds } });
                    }
                }
            } catch (verErr) {
                logger.warn('embeds/save version snapshot failed', { error: verErr.message });
            }
            // ─────────────────────────────────────────────────────────────────
            doc = await EmbedMessage.findOneAndUpdate(
                { _id, guildId },
                { $set: updateData },
                { new: true }
            );
            if (!doc) return res.status(404).json({ error: 'Message not found' });
        } else {
            doc = await EmbedMessage.create({
                guildId,
                ...updateData,
                createdBy: req.session.user?.id || '',
            });
        }

        // ── Try to send or edit the live Discord message ─────────────────────
        const botClient = getClient();
        if (botClient && channelId && initialEmbeds.length) {
            try {
                const channel = await botClient.channels.fetch(channelId).catch(() => null);
                if (channel) {
                    const { buildDiscordPayload } = require('./utils/embedBuilder');
                    const payload = buildDiscordPayload({
                        embeds:     initialEmbeds,
                        components: initialComponents,
                    });
                    // forceNew=true → always send a new message, clear the old messageId reference
                    if (!forceNew && doc.messageId) {
                        const msg = await channel.messages.fetch(doc.messageId).catch(() => null);
                        if (msg) {
                            await msg.edit(payload);
                        } else {
                            const sent = await channel.send(payload);
                            await EmbedMessage.findByIdAndUpdate(doc._id, { $set: { messageId: sent.id } });
                            doc = doc.toObject ? doc.toObject() : { ...doc };
                            doc.messageId = sent.id;
                        }
                    } else {
                        const sent = await channel.send(payload);
                        await EmbedMessage.findByIdAndUpdate(doc._id, { $set: { messageId: sent.id } });
                        doc = doc.toObject ? doc.toObject() : { ...doc };
                        doc.messageId = sent.id;
                    }
                }
            } catch (botErr) {
                logger.warn('embeds/save bot send failed', { error: botErr.message });
            }
        }

        // Bust smart trigger cache so any new/changed triggers take effect immediately
        try { require('../systems/emped').invalidateTriggerCache(); } catch (_) {}
        res.json({ success: true, data: doc });
    } catch (e) {
        if (e.code === 11000) return res.status(409).json({ error: 'A message with this name already exists' });
        res.status(500).json({ error: e.message });
    }
});

/* ── Embeds API: delete (soft — moves to trash) ──────── */
app.delete('/dashboard/:guildId/embeds/api/:id', require('./middleware/auth'), async (req, res) => {
    const EmbedMessage = require('../systems/schemas/EmbedMessage');
    const EmbedTrash   = require('../systems/schemas/EmbedTrash');
    const { guildId, id } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const doc = await EmbedMessage.findOneAndDelete({ _id: id, guildId });
        if (!doc) return res.status(404).json({ error: 'Not found' });
        // Move to trash — auto-expires in 30 days
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 30);
        await EmbedTrash.create({
            guildId,
            originalId: doc._id.toString(),
            name:       doc.name       || '',
            channelId:  doc.channelId  || '',
            messageId:  doc.messageId  || null,
            machine:    doc.machine    || null,
            epTheme:    !!doc.epTheme,
            deletedBy:  req.session.user?.id || '',
            expiresAt,
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ── Messaging: Components Messages ─────────────────── */
app.get('/dashboard/:guildId/components', require('./middleware/auth'), async (req, res) => {
    const guildDb   = require('./utils/guildDb');
    const { getClient } = require('./utils/botClient');
    const ComponentMessage = require('../systems/schemas/ComponentMessage');
    const botClient = getClient();
    const { guildId } = req.params;

    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.redirect('/dashboard');
    const inBot = botClient ? botClient.guilds.cache.has(guildId) : guildDb.exists(guildId);
    if (!inBot) return res.redirect('/dashboard');

    const guildInfo = raw.find(g => g.id === guildId);
    const guilds    = raw.map(g => ({ ...g, inBot: botClient ? botClient.guilds.cache.has(g.id) : guildDb.exists(g.id) }));

    let guildChannels = [];
    let guildCategories = [];
    if (botClient) {
        const guild = botClient.guilds.cache.get(guildId);
        if (guild) {
            guildChannels = guild.channels.cache
                .filter(c => c.type === 0)
                .map(c => ({ id: c.id, name: c.name, parentId: c.parentId || null }))
                .sort((a, b) => a.name.localeCompare(b.name));
            guildCategories = guild.channels.cache
                .filter(c => c.type === 4)
                .map(c => ({ id: c.id, name: c.name }))
                .sort((a, b) => a.name.localeCompare(b.name));
        }
    }

    let guildRoles = [];
    if (botClient) {
        const guild = botClient.guilds.cache.get(guildId);
        if (guild) {
            guildRoles = guild.roles.cache
                .filter(r => !r.managed && r.name !== '@everyone')
                .map(r => ({ id: r.id, name: r.name, color: r.hexColor || '#99aab5', position: r.rawPosition }))
                .sort((a, b) => b.position - a.position);
        }
    }

    let guildEmojis = [];
    if (botClient) {
        const guild = botClient.guilds.cache.get(guildId);
        if (guild) {
            guildEmojis = guild.emojis.cache
                .map(e => ({ id: e.id, name: e.name, animated: e.animated, url: `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? 'gif' : 'png'}?size=32` }))
                .sort((a, b) => a.name.localeCompare(b.name));
        }
    }

    const botInfo = botClient?.user
        ? { username: botClient.user.username, avatar: botClient.user.displayAvatarURL({ size: 64 }) }
        : { username: 'Bot', avatar: null };

    let savedMessages = [];
    try { savedMessages = await ComponentMessage.find({ guildId }).sort({ updatedAt: -1 }).lean(); } catch (_) {}

    res.render('components_messages', {
        user: req.session.user, guildInfo, guilds,
        guildChannels, guildCategories, guildRoles, guildEmojis, botInfo,
        savedMessages,
        t: req.t, lang: req.lang, guildId,
        isShip: getIsShip(req.session.user?.id)
    });
});

/* ── Components API: list ────────────────────────────── */
app.get('/dashboard/:guildId/components/api/list', require('./middleware/auth'), async (req, res) => {
    const ComponentMessage = require('../systems/schemas/ComponentMessage');
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const list = await ComponentMessage.find({ guildId }).sort({ updatedAt: -1 }).lean();
        res.json({ success: true, data: list });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Components API: get single ──────────────────────── */
app.get('/dashboard/:guildId/components/api/:id', require('./middleware/auth'), async (req, res) => {
    const ComponentMessage = require('../systems/schemas/ComponentMessage');
    const { guildId, id } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const doc = await ComponentMessage.findOne({ _id: id, guildId }).lean();
        if (!doc) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true, data: doc });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Components API: save (create / update) ──────────── */
app.post('/dashboard/:guildId/components/api/save', require('./middleware/auth'), express.json(), async (req, res) => {
    const ComponentMessage = require('../systems/schemas/ComponentMessage');
    const { getClient } = require('./utils/botClient');
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });

    const { _id, name, content, channelId, channelIds, components, actions,
            triggers, scheduledAt, multiUser, timeout, preMentions, sendMode,
            states, initialStateId } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    // channelId is fully optional — triggers or runtime context supply it when absent

    // Extract all customIds across every state (so O(1) interaction lookup works)
    const componentIds = [];
    function extractIds(rows) {
        for (const row of (rows || [])) {
            if (row.type === 'buttons') {
                for (const btn of (row.buttons || [])) {
                    if (btn.customId && btn.style !== 'Link') componentIds.push(btn.customId);
                }
            } else if (row.type === 'select' && row.select?.customId) {
                componentIds.push(row.select.customId);
            } else if (row.type === 'container') {
                extractIds(row.children || []);
            }
        }
    }
    // Root-level components (initial state flat compat)
    extractIds(components || []);
    // All states
    for (const st of (states || [])) extractIds(st.components || []);

    try {
        let doc;
        const updateData = {
            name: name.trim(),
            content: (content || '').slice(0, 2000),
            channelId: channelId || '',
            channelIds: Array.isArray(channelIds) ? channelIds : (channelId ? [channelId] : []),
            components: components || [],
            actions: actions || [],
            /** Persist full multi-state flow */
            states: (states || []).map(st => ({
                id: st.id, label: st.label || 'State', color: st.color || '#5865f2',
                content: (st.content || '').slice(0, 4000),
                components: st.components || [],
                actions: (st.actions || []),
            })),
            initialStateId: initialStateId || '',
            componentIds: [...new Set(componentIds)],  // deduplicate
            triggers: (triggers || []).map(t => ({ id: t.id || String(Date.now()), type: t.type, params: t.params || {} })),
            scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
            multiUser: !!multiUser,
            timeout: parseInt(timeout, 10) || 0,
            preMentions: Array.isArray(preMentions) ? preMentions : [],
            sendMode: sendMode === 'edit' ? 'edit' : 'new',
            updatedBy: req.session.user?.id || '',
        };

        if (_id) {
            doc = await ComponentMessage.findOneAndUpdate(
                { _id, guildId },
                { $set: updateData },
                { new: true }
            );
            if (!doc) return res.status(404).json({ error: 'Message not found' });
        } else {
            doc = await ComponentMessage.create({
                guildId,
                ...updateData,
                createdBy: req.session.user?.id || '',
            });
        }

        // Send to Discord: use initial state's content, loop over all channelIds
        const botClient = getClient();
        const allChannelIds = Array.isArray(channelIds) && channelIds.length
            ? channelIds
            : (channelId ? [channelId] : []);

        if (botClient && allChannelIds.length) {
            try {
                const { buildComponentPayload } = require('./utils/componentBuilder');
                // Use initial state content if available
                const initState = (states || []).find(s => s.id === initialStateId) || (states || [])[0];
                const sendContent    = initState?.content    ?? doc.content    ?? '';
                const sendComponents = initState?.components ?? doc.components ?? [];
                const payload = buildComponentPayload({ content: sendContent, components: sendComponents });

                if (!payload.components.length && !payload.content) {
                    logger.warn('components/save: payload is empty, skipping Discord send');
                } else {
                    // Send preMentions as a separate ping message first
                    const mentions = Array.isArray(preMentions) ? preMentions : [];
                    const pingText = mentions.map(m => {
                        if (!m) return '';
                        if (typeof m === 'string') return m;
                        if (m.type === 'special') return `@${m.id}`;
                        if (m.type === 'role')    return `<@&${m.id}>`;
                        return '';
                    }).filter(Boolean).join(' ');

                    for (const cid of allChannelIds) {
                        try {
                            const channel = await botClient.channels.fetch(cid).catch(() => null);
                            if (!channel) continue;

                            if (pingText) {
                                await channel.send({ content: pingText, allowedMentions: { parse: ['roles', 'everyone', 'here'] } }).catch(() => null);
                            }

                            if (sendMode === 'edit' && doc.messageId && cid === (channelId || allChannelIds[0])) {
                                // Edit mode: update the primary channel's existing message
                                const existingMsg = await channel.messages.fetch(doc.messageId).catch(() => null);
                                if (existingMsg) {
                                    await existingMsg.edit(payload);
                                    continue;
                                }
                            }
                            // New mode: send fresh
                            const sent = await channel.send(payload);
                            const isPrimary = cid === (channelId || allChannelIds[0]);
                            const dbUpdate = {
                                $push: { sentLog: { channelId: channel.id, messageId: sent.id, sentAt: new Date() } },
                            };
                            if (isPrimary) dbUpdate.$set = { messageId: sent.id };
                            await ComponentMessage.findByIdAndUpdate(doc._id, dbUpdate);
                            if (isPrimary) {
                                doc = doc.toObject ? doc.toObject() : { ...doc };
                                doc.messageId = sent.id;
                            }
                        } catch (chErr) {
                            logger.warn('components/save: channel send failed', { channelId: cid, error: chErr.message });
                        }
                    }
                }
            } catch (botErr) {
                logger.warn('components/save bot send failed', { error: botErr.message });
            }
        }

        res.json({ success: true, data: doc });
    } catch (e) {
        if (e.code === 11000) return res.status(409).json({ error: 'A message with this name already exists' });
        res.status(500).json({ error: e.message });
    }
});

/* ── Components API: delete ──────────────────────────── */
app.delete('/dashboard/:guildId/components/api/:id', require('./middleware/auth'), async (req, res) => {
    const ComponentMessage = require('../systems/schemas/ComponentMessage');
    const { guildId, id } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const doc = await ComponentMessage.findOneAndDelete({ _id: id, guildId });
        if (!doc) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Components Webhook Trigger ─────────────────────────────────────────────
 *  POST /api/webhook/components/:guildId/:triggerId?token=xxx
 *  Public endpoint (no session auth) — secured by per-trigger token.
 */
app.post('/api/webhook/components/:guildId/:triggerId', express.json({ limit: '64kb' }), async (req, res) => {
    const ComponentMessage = require('../systems/schemas/ComponentMessage');
    const { getClient } = require('./utils/botClient');
    const { guildId, triggerId } = req.params;
    const token = req.query.token || req.body?.token;

    if (!token || typeof token !== 'string' || token.length < 8)
        return res.status(401).json({ error: 'Missing or invalid token' });

    try {
        const doc = await ComponentMessage.findOne({
            guildId,
            triggers: { $elemMatch: { id: triggerId, type: 'webhook', 'params.token': token } },
        }).lean();

        if (!doc) return res.status(404).json({ error: 'Webhook not found' });

        const botClient = getClient();
        if (!botClient) return res.status(503).json({ error: 'Bot not connected' });

        const allChannelIds = doc.channelIds?.length ? doc.channelIds : (doc.channelId ? [doc.channelId] : []);
        if (!allChannelIds.length)
            return res.status(422).json({ error: 'No target channel configured for this automation' });

        const { buildComponentPayload } = require('./utils/componentBuilder');
        const state = (doc.states?.find(s => s.id === doc.initialStateId) || doc.states?.[0])
            || { content: doc.content, components: doc.components };
        const payload = buildComponentPayload({ content: state.content || doc.content || '', components: state.components || doc.components || [] });

        if (!payload.components.length && !payload.content)
            return res.status(422).json({ error: 'Automation payload is empty' });

        const sentChannels = [];
        for (const cid of allChannelIds) {
            try {
                const channel = await botClient.channels.fetch(cid).catch(() => null);
                if (!channel) continue;
                const sent = await channel.send(payload);
                await ComponentMessage.findByIdAndUpdate(doc._id, {
                    $push: { sentLog: { channelId: channel.id, messageId: sent.id, sentAt: new Date() } },
                });
                sentChannels.push(channel.id);
            } catch (chErr) {
                logger.warn('components/webhook: channel send failed', { channelId: cid, error: chErr.message });
            }
        }
        res.json({ success: true, sent: sentChannels.length });
    } catch (e) {
        logger.error('components/webhook: error', { error: e.message });
        res.status(500).json({ error: e.message });
    }
});

app.get('/dashboard/:guildId/levels', require('./middleware/auth'), (req, res) => {
    const guildDb   = require('./utils/guildDb');
    const { getClient } = require('./utils/botClient');
    const getUnicodeFlagIcon = require('country-flag-icons/unicode').default;
    const botClient = getClient();
    const { guildId } = req.params;

    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.redirect('/dashboard');

    const inBot = botClient ? botClient.guilds.cache.has(guildId) : guildDb.exists(guildId);
    if (!inBot) return res.redirect('/dashboard');

    const guildInfo = raw.find(g => g.id === guildId);
    const settingsData = guildDb.read(guildId, 'settings', {});
    const levelSettings = settingsData.LEVEL_SYSTEM || {
        ENABLE: true,
        TEXT_ACTIVITY: { ENABLE: true, TRACK_MODE: 'MESSAGES', XP_PER_MESSAGE_MIN: 15, XP_PER_MESSAGE_MAX: 25, COOLDOWN_SECONDS: 60, IGNORE_ROLES: [], IGNORE_CHANNELS: [] },
        VOICE_ACTIVITY: { ENABLE: true, TRACK_MODE: 'XP', XP_PER_MINUTE: 10, IGNORE_MUTED: true, IGNORE_DEAFENED: true },
        REWARD_ROLES: [],
        REWARD_SETTINGS: { REMOVE_PREVIOUS_ROLES: true, DISABLE_REWARDS: false, REMOVE_ON_RESET: true, GIVE_HIGHEST_ROLE_ONLY: true },
        LEVELUP_CHANNEL: '',
        LEVELUP_MESSAGE_ENABLED: true
    };
    // ensure REWARD_ROLES exists (migration from old format)
    if (!levelSettings.REWARD_ROLES) levelSettings.REWARD_ROLES = [];

    // All guilds the user has admin perms in (for nav sidebar)
    const guilds = raw.map(g => ({
        ...g,
        inBot: botClient ? botClient.guilds.cache.has(g.id) : guildDb.exists(g.id),
    }));

    // Fetch guild roles and channels from bot
    let guildRoles = [];
    let guildChannels = [];
    if (botClient) {
        const guild = botClient.guilds.cache.get(guildId);
        if (guild) {
            guildRoles = guild.roles.cache
                .filter(r => !r.managed && r.id !== guildId && !r.permissions.has('Administrator'))
                .map(r => ({
                    id: r.id,
                    name: r.name,
                    position: r.position,
                    color: r.color ? '#' + r.color.toString(16).padStart(6, '0') : null,
                    icon: r.icon ? `https://cdn.discordapp.com/role-icons/${r.id}/${r.icon}.png?size=32` : null
                }))
                .sort((a, b) => b.position - a.position);
            guildChannels = guild.channels.cache
                .filter(c => c.type === 0) // text channels
                .map(c => ({ id: c.id, name: c.name }))
                .sort((a, b) => a.name.localeCompare(b.name));
        }
    }

    // Bot user info for preview
    let botUser = { name: 'Bot', avatar: null, isVerified: false };
    if (botClient && botClient.user) {
        botUser = {
            name: botClient.user.username,
            avatar: botClient.user.displayAvatarURL({ size: 64, extension: 'png' }),
            isVerified: botClient.user.flags ? botClient.user.flags.has('VerifiedBot') : false,
        };
    }

    // Guild custom emojis
    let guildEmojis = [];
    if (botClient) {
        const guild = botClient.guilds.cache.get(guildId);
        if (guild) {
            guildEmojis = guild.emojis.cache
                .filter(e => !e.animated)
                .map(e => ({ id: e.id, name: e.name, url: e.imageURL({ size: 32 }) }))
                .slice(0, 200);
        }
    }

    // Country flag emojis

    res.render('levels', {
        user: req.session.user,
        guildInfo,
        guilds,
        levelSettings,
        guildRoles,
        guildChannels,
        guildEmojis,
        botUser,
        t: req.t,
        lang: req.lang,
        guildId,
        isShip: getIsShip(req.session.user?.id),
    });
});

app.post('/dashboard/:guildId/levels/save', require('./middleware/auth'), express.json(), (req, res) => {
    const guildDb = require('./utils/guildDb');
    const { guildId } = req.params;

    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });

    const settingsData = guildDb.read(guildId, 'settings', {});
    settingsData.LEVEL_SYSTEM = req.body;
    guildDb.write(guildId, 'settings', settingsData);

    res.json({ success: true });
});

/* ── Tickets helpers ─────────────────────────────────── */

function _defaultTicketData() {
    return {
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        general: {
            LANGUAGE: 'server_default',
            TICKET_LIMIT_PER_USER: 1,
            ALLOW_USER_CLOSE: true,
            CLOSE_CONFIRMATION: true,
            ENABLE_FEEDBACK: false,
            ANONYMISE_RESPONSES: false,
            THREAD_MODE: false,
            DISABLE_OPEN_COMMAND: false,
            NOTIFICATION_CHANNEL: null,
            TRANSCRIPTS_CHANNEL: null,
            CHANNEL_CATEGORY: null,
            OVERFLOW_CATEGORY: null,
            NAMING_SCHEME: 'ticket-{number}',
            WELCOME_MESSAGE: 'Thank you for contacting support.\nPlease describe your issue.',
            CLAIM_SUPPORT_VIEW: true,
            CLAIM_SUPPORT_TYPE: true,
            AUTO_CLOSE_ON_LEAVE: false,
            AC_NO_RESPONSE_ENABLED: false,
            AC_NO_RESPONSE_DAYS: 0,
            AC_NO_RESPONSE_HOURS: 0,
            AC_NO_RESPONSE_MINS: 0,
            AC_LAST_MSG_ENABLED: false,
            AC_LAST_MSG_DAYS: 0,
            AC_LAST_MSG_HOURS: 0,
            AC_LAST_MSG_MINS: 0,
            OPEN_PERMISSION: 'everyone',
            OPEN_PERMISSION_ROLE: null,
            ADD_MSG_SENDER: false,
            PERM_ATTACH_FILES: true,
            PERM_EMBED_LINKS: true,
            PERM_ADD_REACTIONS: true,
            COLOR_SUCCESS: '#22c55e',
            COLOR_FAILURE: '#ef4444',
            HIDE_CLOSE_BTN: false,
            HIDE_CLOSE_REASON_BTN: false,
            HIDE_CLAIM_BTN: false,
            RULES_BTN_ENABLED:    false,
            RULES_BTN_TEXT:       '',
            RULES_BTN_EMOJI:      '',
            RULES_BTN_LABEL:      '',
            RULES_BTN_STYLE:      2,
            ESCALATE_ENABLED:     false,
            ESCALATE_CATEGORIES:  [],
            ESCALATE_ROLES:       [],
        },
        panels: [],
        multiPanels: [],
    };
}

function _defaultPanelData() {
    const h = {};
    ['monday','tuesday','wednesday','thursday','friday','saturday','sunday']
        .forEach(d => { h[d] = { open: '08:00', close: '20:00' }; });
    return {
        mentionRole: null, transcriptChannel: 'global',
        deleteMentions: false, threadMode: false, threadNotifChannel: null,
        cooldown: 0, category: null, maxOpen: 0,
        hideClose: false, hideCloseReason: false, hideClaim: false,
        form: null, exitSurvey: null, awaitingCat: null,
        namingMode: 'global', namingCustom: 'ticket-{number}',
        panelTitle: '', panelChannel: null, disabled: false,
        bannerImage: '', description: '', accentColor: null,
        btnText: '', btnEmoji: '', btnColor: 1,
        useSelectMenu: false, selectMenuPlaceholder: '', selectMenuDesc: '',
        acl: [], alwaysOpen: true, timezone: 'UTC', hours: h,
        supportRoles: [],
    };
}

function _defaultMultiPanelData() {
    return {
        channel: null, panels: [], useDropdown: false,
        placeholder: 'Select a category...', bannerImage: '', accentColor: null,
    };
}

async function _ticketsCommon(req, res) {
    const guildDb            = require('./utils/guildDb');
    const { getClient }      = require('./utils/botClient');
    const getUnicodeFlagIcon = require('country-flag-icons/unicode').default;
    const botClient          = getClient();
    const { guildId }        = req.params;

    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) { res.redirect('/dashboard'); return null; }

    const inBot = botClient ? botClient.guilds.cache.has(guildId) : guildDb.exists(guildId);
    if (!inBot) { res.redirect('/dashboard'); return null; }

    const guildInfo = raw.find(g => g.id === guildId);

    // ── Load tickets.json; auto-migrate from old settings.json if first run ──
    let ticketData = await guildDb.readAsync(guildId, 'tickets', null);
    if (!ticketData) {
        ticketData = _defaultTicketData();
        const old = guildDb.read(guildId, 'settings', {});
        if (old.TICKET_SYSTEM) {
            const { ENABLE, ...gen } = old.TICKET_SYSTEM;
            ticketData.general = Object.assign({}, ticketData.general, gen);
            if (ENABLE !== undefined) ticketData.enabled = Boolean(ENABLE);
        }
        if (old.TICKET_PANELS) {
            const { multiPanel, ...pf } = old.TICKET_PANELS;
            const now = new Date().toISOString();
            ticketData.panels = [{
                id: 'panel_' + Date.now(), createdAt: now, updatedAt: now,
                name: pf.panelTitle || 'Panel', ..._defaultPanelData(), ...pf,
            }];
            if (multiPanel && (multiPanel.channel || multiPanel.panels?.length)) {
                ticketData.multiPanels = [{
                    id: 'mp_' + Date.now(), createdAt: now, updatedAt: now,
                    ..._defaultMultiPanelData(), ...multiPanel,
                }];
            }
        }
        guildDb.write(guildId, 'tickets', ticketData);
    }

    // Build flat ticketSettings for template back-compat
    const ticketSettings = Object.assign(
        { ENABLE: ticketData.enabled !== false },
        _defaultTicketData().general,
        ticketData.general || {}
    );
    ticketSettings.ENABLE = ticketData.enabled !== false;

    const ticketStats = guildDb.read(guildId, 'ticket_stats', {
        open: 0, claimed: 0, closed_today: 0, avg_response_ms: 0,
    });
    const avgMs = ticketStats.avg_response_ms || 0;
    let avgDisplay = '—';
    if (avgMs > 0) {
        if (avgMs < 60000)        avgDisplay = Math.round(avgMs / 1000) + 's';
        else if (avgMs < 3600000) avgDisplay = Math.round(avgMs / 60000) + 'm';
        else                      avgDisplay = (avgMs / 3600000).toFixed(1) + 'h';
    }

    const guilds = raw.map(g => ({
        ...g, inBot: botClient ? botClient.guilds.cache.has(g.id) : guildDb.exists(g.id),
    }));

    let guildChannels = [], guildCategories = [], guildRoles = [], guildEmojis = [];
    if (botClient) {
        const guild = botClient.guilds.cache.get(guildId);
        if (guild) {
            guildChannels   = guild.channels.cache.filter(c => c.type === 0)
                .map(c => ({ id: c.id, name: c.name })).sort((a,b) => a.name.localeCompare(b.name));
            guildCategories = guild.channels.cache.filter(c => c.type === 4)
                .map(c => ({ id: c.id, name: c.name })).sort((a,b) => a.name.localeCompare(b.name));
            guildRoles      = guild.roles.cache.filter(r => !r.managed && r.id !== guild.id)
                .map(r => ({ id: r.id, name: r.name })).sort((a,b) => b.position - a.position);
            guildEmojis     = guild.emojis.cache
                .filter(e => !e.animated)
                .map(e => ({ id: e.id, name: e.name, url: e.imageURL({ size: 32 }) }))
                .slice(0, 200);
        }
    }

    return {
        guildId, guildInfo, guilds,
        ticketData, ticketSettings, ticketStats, avgDisplay,
        guildChannels, guildCategories, guildRoles, guildEmojis,
        isShip: getIsShip(req.session.user?.id),
    };
}

app.get('/dashboard/:guildId/tickets', require('./middleware/auth'), async (req, res) => {
    const ctx = await _ticketsCommon(req, res);
    if (!ctx) return;
    res.render('tickets', { user: req.session.user, ...ctx, t: req.t, lang: req.lang });
});

// ── Quick enable/disable toggle (used by the overview page toggle switch) ─────────
app.post('/dashboard/:guildId/tickets/toggle', require('./middleware/auth'), express.json(), async (req, res) => {
    const guildDb    = require('./utils/guildDb');
    const { guildId } = req.params;
    if (!req.session.guilds?.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
    const ticketData = (await guildDb.readAsync(guildId, 'tickets', null)) || _defaultTicketData();
    if (!ticketData.general)      ticketData.general      = {};
    if (!ticketData.panels)       ticketData.panels       = [];
    if (!ticketData.multiPanels)  ticketData.multiPanels  = [];
    ticketData.enabled         = enabled;
    ticketData.general.ENABLE  = enabled;   // keep both fields in sync
    ticketData.updatedAt       = new Date().toISOString();
    guildDb.write(guildId, 'tickets', ticketData);
    res.json({ success: true, enabled });
});

app.get('/dashboard/:guildId/tickets/general', require('./middleware/auth'), async (req, res) => {
    const ctx = await _ticketsCommon(req, res);
    if (!ctx) return;
    res.render('tickets_general', { user: req.session.user, ...ctx, t: req.t, lang: req.lang });
});

app.post('/dashboard/:guildId/tickets/general/save', require('./middleware/auth'), express.json(), async (req, res) => {
    const guildDb = require('./utils/guildDb');
    const { guildId } = req.params;
    if (!req.session.guilds?.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });

    const now = new Date().toISOString();
    const { ENABLE, ...generalFields } = req.body;
    const ticketData = (await guildDb.readAsync(guildId, 'tickets', null)) || _defaultTicketData();
    ticketData.enabled   = ENABLE !== undefined ? Boolean(ENABLE) : (ticketData.enabled !== false);
    ticketData.general   = generalFields;
    ticketData.updatedAt = now;
    if (!ticketData.createdAt)   ticketData.createdAt   = now;
    if (!ticketData.panels)      ticketData.panels      = [];
    if (!ticketData.multiPanels) ticketData.multiPanels = [];
    guildDb.write(guildId, 'tickets', ticketData);
    res.json({ success: true });
});

app.get('/dashboard/:guildId/tickets/panels', require('./middleware/auth'), async (req, res) => {
    const ctx = await _ticketsCommon(req, res);
    if (!ctx) return;
    res.render('tickets_panels', { user: req.session.user, ...ctx, t: req.t, lang: req.lang });
});

app.post('/dashboard/:guildId/tickets/panels/save', require('./middleware/auth'), express.json(), async (req, res) => {
    const guildDb = require('./utils/guildDb');
    const { guildId } = req.params;
    if (!req.session.guilds?.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });

    const now = new Date().toISOString();
    const { panelId, multiPanel, ...panelFields } = req.body;
    const ticketData = (await guildDb.readAsync(guildId, 'tickets', null)) || _defaultTicketData();
    if (!ticketData.panels)      ticketData.panels      = [];
    if (!ticketData.multiPanels) ticketData.multiPanels = [];

    // ── Single panel: create or update ──────────────────────────────────────
    let savedPanelId;
    if (panelId) {
        const idx = ticketData.panels.findIndex(p => p.id === panelId);
        if (idx >= 0) {
            ticketData.panels[idx] = {
                ...ticketData.panels[idx], ...panelFields,
                id: panelId, name: panelFields.panelTitle || ticketData.panels[idx].name, updatedAt: now,
            };
        } else {
            ticketData.panels.push({
                id: panelId, createdAt: now, updatedAt: now,
                name: panelFields.panelTitle || 'Panel', ..._defaultPanelData(), ...panelFields,
            });
        }
        savedPanelId = panelId;
    } else {
        savedPanelId = 'panel_' + Date.now();
        ticketData.panels.push({
            id: savedPanelId, createdAt: now, updatedAt: now,
            name: panelFields.panelTitle || 'Panel', ..._defaultPanelData(), ...panelFields,
        });
    }

    // ── Multi-panel: create or update ───────────────────────────────────────
    let savedMpId = null;
    if (multiPanel) {
        const { mpId, ...mpFields } = multiPanel;
        if (mpId) {
            const idx = ticketData.multiPanels.findIndex(m => m.id === mpId);
            if (idx >= 0) {
                ticketData.multiPanels[idx] = { ...ticketData.multiPanels[idx], ...mpFields, id: mpId, updatedAt: now };
            } else {
                ticketData.multiPanels.push({ id: mpId, createdAt: now, updatedAt: now, ..._defaultMultiPanelData(), ...mpFields });
            }
            savedMpId = mpId;
        } else {
            savedMpId = 'mp_' + Date.now();
            ticketData.multiPanels.push({ id: savedMpId, createdAt: now, updatedAt: now, ..._defaultMultiPanelData(), ...mpFields });
        }
    }

    ticketData.updatedAt = now;
    if (!ticketData.createdAt) ticketData.createdAt = now;
    guildDb.write(guildId, 'tickets', ticketData);
    res.json({ success: true, panelId: savedPanelId, mpId: savedMpId });
});

// ─── Banner image upload ───────────────────────────────────────────────────
app.post('/dashboard/:guildId/tickets/upload-banner', require('./middleware/auth'), (req, res) => {
    const { guildId } = req.params;
    if (!req.session.guilds?.find(g => g.id === guildId))
        return res.status(403).json({ error: 'Forbidden' });

    const uploadDir = path.join(__dirname, 'public', 'uploads', guildId);
    fs.mkdirSync(uploadDir, { recursive: true });

    const storage = multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, uploadDir),
        filename:    (_req,  file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase() || '.png';
            cb(null, `banner_${Date.now()}${ext}`);
        },
    });
    const upload = multer({
        storage,
        limits: { fileSize: 20 * 1024 * 1024 },
        fileFilter: (_req, file, cb) =>
            cb(null, ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)),
    }).single('file');

    upload(req, res, (err) => {
        if (err)         return res.status(400).json({ error: err.message });
        if (!req.file)   return res.status(400).json({ error: 'Invalid or missing file (PNG/JPG/WEBP only)' });
        res.json({ url: `/uploads/${guildId}/${req.file.filename}` });
    });
});

app.post('/dashboard/:guildId/tickets/panels/send', require('./middleware/auth'), express.json(), async (req, res) => {
    const guildDb = require('./utils/guildDb');
    const { getClient } = require('./utils/botClient');
    const { guildId } = req.params;
    if (!req.session.guilds?.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });

    const { panelId, messageId, forceNew, channelId: reqChannelId } = req.body;
    if (!panelId) return res.status(400).json({ error: 'panelId required' });

    const client = getClient();
    if (!client) return res.status(503).json({ error: 'Bot not connected' });

    const ticketData = await guildDb.readAsync(guildId, 'tickets', null);
    if (!ticketData) return res.status(404).json({ error: 'No tickets data found' });

    const panel = ticketData.panels?.find(p => p.id === panelId);
    if (!panel) return res.status(404).json({ error: 'Panel not found' });

    // If channelId provided in request (e.g. user set channel then clicked Send without saving first),
    // persist it to the panel so sendPanel can use it
    if (reqChannelId && reqChannelId !== panel.panelChannel) {
        panel.panelChannel = reqChannelId;
        const idx = ticketData.panels.findIndex(p => p.id === panelId);
        if (idx >= 0) ticketData.panels[idx].panelChannel = reqChannelId;
        guildDb.write(guildId, 'tickets', ticketData);
    }

    try {
        const ticketsSystem = require('../systems/tickets');
        // forceNew=true → always send a new message (ignore any stored messageId)
        const msgToUse = forceNew ? null : (messageId !== undefined ? messageId : panel.messageId) || null;
        const newMessageId = await ticketsSystem.sendPanel(client, guildId, panel, msgToUse);

        // Persist the message ID back
        const idx = ticketData.panels.findIndex(p => p.id === panelId);
        if (idx >= 0) { ticketData.panels[idx].messageId = newMessageId; ticketData.panels[idx].messageSentAt = new Date().toISOString(); }
        guildDb.write(guildId, 'tickets', ticketData);
        res.json({ success: true, messageId: newMessageId });
    } catch (err) {
        logger.error('tickets/panels/send failed', { category: 'dashboard', error: err.message, stack: err.stack });
        res.status(500).json({ error: err.message || 'Send failed' });
    }
});

app.post('/dashboard/:guildId/tickets/multi-panels/send', require('./middleware/auth'), express.json(), async (req, res) => {
    const guildDb = require('./utils/guildDb');
    const { getClient } = require('./utils/botClient');
    const { guildId } = req.params;
    if (!req.session.guilds?.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });

    const { mpId, messageId, forceNew, channelId: reqChannelId, panels: reqPanels } = req.body;
    if (!mpId) return res.status(400).json({ error: 'mpId required' });

    const client = getClient();
    if (!client) return res.status(503).json({ error: 'Bot not connected' });

    const ticketData = await guildDb.readAsync(guildId, 'tickets', null);
    if (!ticketData) return res.status(404).json({ error: 'No tickets data found' });

    const mp = ticketData.multiPanels?.find(m => m.id === mpId);
    if (!mp) return res.status(404).json({ error: 'Multi-panel not found' });

    // If channelId is provided in the request, use it (and persist it)
    if (reqChannelId && reqChannelId !== mp.channel) {
        mp.channel = reqChannelId;
        const idx = ticketData.multiPanels.findIndex(m => m.id === mpId);
        if (idx >= 0) ticketData.multiPanels[idx].channel = reqChannelId;
        guildDb.write(guildId, 'tickets', ticketData);
    }

    // If panels provided in the request and stored mp.panels is empty, persist them first
    const panelSlots = (Array.isArray(reqPanels) && reqPanels.length > 0 && (!mp.panels || mp.panels.length === 0))
        ? reqPanels
        : (mp.panels || []);
    if (panelSlots !== (mp.panels || []) && panelSlots.length > 0) {
        const idx = ticketData.multiPanels.findIndex(m => m.id === mpId);
        if (idx >= 0) ticketData.multiPanels[idx].panels = panelSlots;
        guildDb.write(guildId, 'tickets', ticketData);
    }

    // Resolve panel data for each slot in the multi-panel
    // Match by panelId first, then fall back to matching by name
    const panels = panelSlots.map((slot, i) => {
        const full = (slot.panelId && ticketData.panels?.find(p => p.id === slot.panelId))
            || ticketData.panels?.find(p => (p.name || p.panelTitle) === slot.name);
        return full ? { ...full, ...slot, panelId: full.id } : { ...slot, _slotIndex: i };
    });

    try {
        const ticketsSystem = require('../systems/tickets');
        const msgToUse = forceNew ? null : (messageId !== undefined ? messageId : mp.messageId) || null;
        const newMessageId = await ticketsSystem.sendMultiPanel(client, guildId, mp, panels, msgToUse);

        const idx = ticketData.multiPanels.findIndex(m => m.id === mpId);
        if (idx >= 0) { ticketData.multiPanels[idx].messageId = newMessageId; ticketData.multiPanels[idx].messageSentAt = new Date().toISOString(); }
        guildDb.write(guildId, 'tickets', ticketData);
        res.json({ success: true, messageId: newMessageId });
    } catch (err) {
        logger.error('tickets/multi-panels/send failed', { category: 'dashboard', error: err.message, stack: err.stack });
        res.status(500).json({ error: err.message || 'Send failed' });
    }
});

// ── Delete single panel ────────────────────────────────────────────────────
app.delete('/dashboard/:guildId/tickets/panels/delete', require('./middleware/auth'), express.json(), async (req, res) => {
    const guildDb = require('./utils/guildDb');
    const { guildId } = req.params;
    if (!req.session.guilds?.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    const { panelId } = req.body;
    if (!panelId) return res.status(400).json({ error: 'panelId required' });
    const ticketData = await guildDb.readAsync(guildId, 'tickets', null);
    if (!ticketData) return res.status(404).json({ error: 'No tickets data' });
    const before = (ticketData.panels || []).length;
    ticketData.panels = (ticketData.panels || []).filter(p => p.id !== panelId);
    if (ticketData.panels.length === before) return res.status(404).json({ error: 'Panel not found' });
    guildDb.write(guildId, 'tickets', ticketData);
    res.json({ success: true });
});

// ── Delete single multi-panel ────────────────────────────────────────────────
app.delete('/dashboard/:guildId/tickets/multi-panels/delete', require('./middleware/auth'), express.json(), async (req, res) => {
    const guildDb = require('./utils/guildDb');
    const { guildId } = req.params;
    if (!req.session.guilds?.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    const { mpId } = req.body;
    if (!mpId) return res.status(400).json({ error: 'mpId required' });
    const ticketData = await guildDb.readAsync(guildId, 'tickets', null);
    if (!ticketData) return res.status(404).json({ error: 'No tickets data' });
    const before = (ticketData.multiPanels || []).length;
    ticketData.multiPanels = (ticketData.multiPanels || []).filter(m => m.id !== mpId);
    if (ticketData.multiPanels.length === before) return res.status(404).json({ error: 'Multi-panel not found' });
    guildDb.write(guildId, 'tickets', ticketData);
    res.json({ success: true });
});

// ── Reset all ticket data ────────────────────────────────────────────────────
app.post('/dashboard/:guildId/tickets/reset', require('./middleware/auth'), (req, res) => {
    const guildDb = require('./utils/guildDb');
    const fs      = require('fs');
    const path    = require('path');
    const { guildId } = req.params;
    if (!/^\d{17,20}$/.test(guildId)) return res.status(400).json({ error: 'Invalid guildId' });
    if (!req.session.guilds?.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    const files = ['tickets','open_tickets','ticket_feedback','ticket_cooldowns'];
    files.forEach(f => {
        try {
            const fp = path.join(__dirname, 'database', guildId, `${f}.json`);
            if (fs.existsSync(fp)) fs.unlinkSync(fp);
        } catch (e) { logger.warn(`tickets reset: could not delete ${f}.json`, { category: 'dashboard', guildId, error: e.message }); }
    });
    // Also clear transcripts folder if exists
    try {
        const tDir = path.join(__dirname, 'database', guildId, 'transcripts');
        if (fs.existsSync(tDir)) fs.rmSync(tDir, { recursive: true, force: true });
    } catch (e) { logger.warn('tickets reset: could not delete transcripts', { category: 'dashboard', guildId, error: e.message }); }
    res.json({ success: true });
});

// Reset panels + multi-panels (keeps feedback / transcripts)
app.post('/dashboard/:guildId/tickets/panels/reset', require('./middleware/auth'), (req, res) => {
    const guildDb = require('./utils/guildDb');
    const fs      = require('fs');
    const path    = require('path');
    const { guildId } = req.params;
    if (!req.session.guilds?.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    const db = guildDb.read(guildId, 'tickets');
    db.panels      = [];
    db.multiPanels = [];
    guildDb.write(guildId, 'tickets', db);
    ['open_tickets', 'ticket_cooldowns'].forEach(f => {
        try {
            const fp = path.join(__dirname, 'database', guildId, `${f}.json`);
            if (fs.existsSync(fp)) fs.unlinkSync(fp);
        } catch (e) { logger.warn(`panels/reset: could not delete ${f}.json`, { category: 'dashboard', guildId, error: e.message }); }
    });
    res.json({ success: true });
});

// Reset multi-panels only
app.post('/dashboard/:guildId/tickets/multi-panels/reset', require('./middleware/auth'), (req, res) => {
    const guildDb = require('./utils/guildDb');
    const { guildId } = req.params;
    if (!req.session.guilds?.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    const db = guildDb.read(guildId, 'tickets');
    db.multiPanels = [];
    guildDb.write(guildId, 'tickets', db);
    res.json({ success: true });
});

// ── Live ticket stats API ─────────────────────────────────────────────────
app.get('/dashboard/:guildId/tickets/stats', require('./middleware/auth'), (req, res) => {
    const guildDb     = require('./utils/guildDb');
    const ticketStats = require('../systems/ticket_stats');
    const { guildId } = req.params;
    if (!req.session.guilds?.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });

    const otDb  = guildDb.read(guildId, 'open_tickets', { tickets: [] });
    const stats = ticketStats.getStats(guildId, otDb.tickets);

    const ticketData = guildDb.read(guildId, 'tickets', null);
    stats.limit = ticketData?.general?.TICKET_LIMIT_PER_USER || 1;

    res.json(stats);
});

// ── Charts data API ───────────────────────────────────────────────────────
app.get('/dashboard/:guildId/tickets/charts', require('./middleware/auth'), async (req, res) => {
    const guildDb = require('./utils/guildDb');
    const { guildId } = req.params;
    if (!req.session.guilds?.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });

    const otDb      = guildDb.read(guildId, 'open_tickets', { tickets: [] });
    const tickets   = otDb.tickets || [];
    const ticketData = guildDb.read(guildId, 'tickets', null);
    const panels    = ticketData?.panels || [];

    // ── helpers ──────────────────────────────────────────────────────────
    const toDay = iso => {
        if (!iso) return null;
        const s = iso instanceof Date ? iso.toISOString() : String(iso);
        return s.slice(0, 10);
    };
    const last30 = Array.from({ length: 30 }, (_, i) => {
        const d = new Date(); d.setDate(d.getDate() - (29 - i));
        return d.toISOString().slice(0, 10);
    });

    // 1. Tickets Over Time (opened per day, last 30)
    const openedByDay = {};
    tickets.forEach(t => { const d = toDay(t.openedAt); if (d) openedByDay[d] = (openedByDay[d] || 0) + 1; });

    // 2. Open vs Closed
    const openCount   = tickets.filter(t => t.status === 'open').length;
    const closedCount = tickets.filter(t => t.status === 'closed').length;

    // 3. By Panel
    const byPanelMap = {};
    tickets.forEach(t => { byPanelMap[t.panelId] = (byPanelMap[t.panelId] || 0) + 1; });
    const byPanel = {
        labels: Object.keys(byPanelMap).map(id => panels.find(p => p.id === id)?.name || `#${id.slice(-4)}`),
        counts: Object.values(byPanelMap),
    };

    // 4. Heatmap: day-of-week × hour (all time)
    const dow   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const hmRaw = Array.from({ length: 7 }, () => new Array(24).fill(0));
    tickets.forEach(t => {
        if (!t.openedAt) return;
        const dt = new Date(t.openedAt);
        hmRaw[dt.getUTCDay()][dt.getUTCHours()]++;
    });
    const heatmap = dow.map((name, di) => ({ name, data: hmRaw[di].map((v, h) => ({ x: String(h).padStart(2,'0') + ':00', y: v })) }));

    // 5 & 7. Staff maps
    const staffMap = {};
    tickets.forEach(t => {
        if (t.status !== 'closed' || !t.closedBy || !t.openedAt || !t.closedAt) return;
        const ms = new Date(t.closedAt) - new Date(t.openedAt);
        if (!staffMap[t.closedBy]) staffMap[t.closedBy] = { ms: 0, n: 0 };
        staffMap[t.closedBy].ms += ms; staffMap[t.closedBy].n++;
    });

    // Resolve display names via botClient
    const { getClient } = require('./utils/botClient');
    const botClient = getClient();
    const nameOf = uid => {
        if (botClient) {
            const m = botClient.guilds.cache.get(guildId)?.members.cache.get(uid);
            if (m) return m.displayName || m.user?.username;
        }
        return `…${uid.slice(-4)}`;
    };

    const staffResponse = Object.entries(staffMap)
        .filter(([,v]) => v.n > 0)
        .map(([uid, v]) => ({ name: nameOf(uid), avgMin: +(v.ms / v.n / 60000).toFixed(1) }))
        .sort((a, b) => a.avgMin - b.avgMin).slice(0, 10);

    const staffTickets = Object.entries(staffMap)
        .map(([uid, v]) => ({ name: nameOf(uid), count: v.n }))
        .sort((a, b) => b.count - a.count).slice(0, 10);

    // 6. Resolution over time (avg min per day, last 30)
    const resByDay = {};
    tickets.forEach(t => {
        if (t.status !== 'closed' || !t.openedAt || !t.closedAt) return;
        const d = toDay(t.closedAt); const ms = new Date(t.closedAt) - new Date(t.openedAt);
        if (d && ms > 0) { if (!resByDay[d]) resByDay[d] = { s: 0, n: 0 }; resByDay[d].s += ms; resByDay[d].n++; }
    });

    // 8. Escalated vs Normal
    const escalatedCount = tickets.filter(t => t.escalated).length;

    // 9. Daily / Weekly / Monthly received
    const nowTs    = Date.now();
    const todayKey = new Date(nowTs).toISOString().slice(0, 10);
    const weekAgo  = new Date(nowTs - 7  * 86400000).toISOString().slice(0, 10);
    const monthAgo = new Date(nowTs - 30 * 86400000).toISOString().slice(0, 10);
    const daily    = tickets.filter(t => toDay(t.openedAt) === todayKey).length;
    const weekly   = tickets.filter(t => { const d = toDay(t.openedAt); return d && d >= weekAgo;  }).length;
    const monthly  = tickets.filter(t => { const d = toDay(t.openedAt); return d && d >= monthAgo; }).length;

    // ── Daily breakdown for the last 7 days (bar chart) ──────────────────
    const last7 = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(nowTs); d.setDate(d.getDate() - (6 - i));
        return d.toISOString().slice(0, 10);
    });

    // 10. Staff Received – ranked by tickets they claimed OR closed
    const staffRecMap = {};
    tickets.forEach(t => {
        const uid = t.claimedBy || t.closedBy;
        if (uid) staffRecMap[uid] = (staffRecMap[uid] || 0) + 1;
    });
    const staffReceived = Object.entries(staffRecMap)
        .map(([uid, n]) => ({ name: nameOf(uid), count: n }))
        .sort((a, b) => b.count - a.count).slice(0, 12);

    // ── Feedback / Rating charts ──────────────────────────────────────────
    const fbDb      = guildDb.read(guildId, 'ticket_feedback', { entries: [] });
    const fbEntries = Array.isArray(fbDb.entries) ? fbDb.entries : [];

    // 11. Star rating distribution (1–5)
    const starDist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    fbEntries.forEach(e => { if (e.rating >= 1 && e.rating <= 5) starDist[e.rating]++; });
    const totalFb = Object.values(starDist).reduce((a, b) => a + b, 0);

    // 12. Avg rating per staff (match ticketId → closedBy / claimedBy from open_tickets)
    const staffRatingMap = {};
    const ticketById = {};
    tickets.forEach(t => { ticketById[t.id] = t; });
    fbEntries.forEach(e => {
        const t   = ticketById[e.ticketId];
        const uid = t?.closedBy || t?.claimedBy;
        if (!uid) return;
        if (!staffRatingMap[uid]) staffRatingMap[uid] = { sum: 0, n: 0 };
        staffRatingMap[uid].sum += e.rating;
        staffRatingMap[uid].n++;
    });
    const staffRatings = Object.entries(staffRatingMap)
        .map(([uid, v]) => ({ name: nameOf(uid), avg: +(v.sum / v.n).toFixed(2), n: v.n }))
        .sort((a, b) => b.avg - a.avg).slice(0, 12);

    // 13. Ratings over time — avg per day, last 30 d + daily/weekly/monthly counts
    const fbByDay = {};
    fbEntries.forEach(e => {
        const d = toDay(e.submittedAt);
        if (!d) return;
        if (!fbByDay[d]) fbByDay[d] = { sum: 0, n: 0 };
        fbByDay[d].sum += e.rating;
        fbByDay[d].n++;
    });
    const fbDailyCount  = fbEntries.filter(e => toDay(e.submittedAt) === todayKey).length;
    const fbWeeklyCount = fbEntries.filter(e => { const d = toDay(e.submittedAt); return d && d >= weekAgo;  }).length;
    const fbMonthlyCount= fbEntries.filter(e => { const d = toDay(e.submittedAt); return d && d >= monthAgo; }).length;

    // 14. Ratings by panel — avg rating + count per panel
    const panelRatingMap = {};
    fbEntries.forEach(e => {
        const pid = e.panelId || '__none__';
        if (!panelRatingMap[pid]) panelRatingMap[pid] = { sum: 0, n: 0 };
        panelRatingMap[pid].sum += e.rating;
        panelRatingMap[pid].n++;
    });
    const ratingsByPanel = (() => {
        const entries = Object.entries(panelRatingMap)
            .map(([pid, v]) => ({
                label: pid === '__none__' ? '—' : (panels.find(p => p.id === pid)?.panelTitle || panels.find(p => p.id === pid)?.name || `#${pid.slice(-4)}`),
                avg: +(v.sum / v.n).toFixed(2),
                count: v.n,
            }))
            .sort((a, b) => b.avg - a.avg);
        return {
            labels: entries.map(e => e.label),
            avgs:   entries.map(e => e.avg),
            counts: entries.map(e => e.count),
        };
    })();

    res.json({
        ticketsOverTime:     { dates: last30, counts: last30.map(d => openedByDay[d] || 0) },
        openVsClosed:        { open: openCount, closed: closedCount },
        byPanel,
        heatmap,
        staffResponse:       { labels: staffResponse.map(s => s.name), avgMin: staffResponse.map(s => s.avgMin) },
        resolutionOverTime:  { dates: last30, avgMin: last30.map(d => resByDay[d] ? +(resByDay[d].s / resByDay[d].n / 60000).toFixed(1) : null) },
        staffTickets:        { labels: staffTickets.map(s => s.name), counts: staffTickets.map(s => s.count) },
        escalated:           { normal: tickets.length - escalatedCount, escalated: escalatedCount },
        dailyWeeklyMonthly:  {
            summary: { daily, weekly, monthly },
            last7:   { dates: last7, counts: last7.map(d => openedByDay[d] || 0) },
        },
        staffReceived:       { labels: staffReceived.map(s => s.name), counts: staffReceived.map(s => s.count) },
        // ── Feedback ──────────────────────────────────────────────────────
        starDist:            { counts: [1,2,3,4,5].map(n => starDist[n]), total: totalFb },
        staffRatings:        { labels: staffRatings.map(s => s.name), avgs: staffRatings.map(s => s.avg), counts: staffRatings.map(s => s.n) },
        ratingsOverTime:     {
            dates:   last30,
            avgRating: last30.map(d => fbByDay[d] ? +(fbByDay[d].sum / fbByDay[d].n).toFixed(2) : null),
            summary: { daily: fbDailyCount, weekly: fbWeeklyCount, monthly: fbMonthlyCount, total: totalFb },
        },
        ratingsByPanel,
    });
});

/* ── Utility ─────────────────────────────────────────── */
app.get('/dashboard/:guildId/utility', require('./middleware/auth'), (req, res) => {
    const guildDb = require('./utils/guildDb');
    const { getClient } = require('./utils/botClient');
    const getUnicodeFlagIcon = require('country-flag-icons/unicode').default;
    const botClient = getClient();
    const { guildId } = req.params;

    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.redirect('/dashboard');

    const inBot = botClient ? botClient.guilds.cache.has(guildId) : guildDb.exists(guildId);
    if (!inBot) return res.redirect('/dashboard');

    const guildInfo = raw.find(g => g.id === guildId);
    const guilds = raw.map(g => ({
        ...g,
        inBot: botClient ? botClient.guilds.cache.has(g.id) : guildDb.exists(g.id),
    }));

    let guildRoles = [], guildChannels = [];
    if (botClient) {
        const guild = botClient.guilds.cache.get(guildId);
        if (guild) {
            guildRoles = guild.roles.cache
                .filter(r => !r.managed && r.id !== guildId)
                .map(r => ({ id: r.id, name: r.name, color: r.color ? '#' + r.color.toString(16).padStart(6, '0') : null }))
                .sort((a, b) => b.position - a.position);
            guildChannels = guild.channels.cache
                .filter(c => c.type === 0)
                .map(c => ({ id: c.id, name: c.name }))
                .sort((a, b) => a.name.localeCompare(b.name));
        }
    }


    const guildCmdsUtil = require('../utils/guildCmds');
    const utilityActions = guildCmdsUtil.resolveAllPublic(guildId);
    const sCfg = readSettingsCfg();
    const botPrefix = (sCfg.system && sCfg.system.PREFIX) ? sCfg.system.PREFIX : '!';

    res.render('utility', {
        user: req.session.user,
        guildInfo,
        guilds,
        guildRoles,
        guildChannels,
        t: req.t,
        lang: req.lang,
        guildId,
        isShip: getIsShip(req.session.user?.id),
        utilityActions,
        botPrefix,
    });
});

/* ── Utility Save ────────────────────────────────────── */
app.post('/dashboard/:guildId/utility/save', require('./middleware/auth'), (req, res) => {
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });

    const { commands } = req.body;
    if (!commands || typeof commands !== 'object') return res.status(400).json({ error: 'Invalid payload' });

    try {
        const guildCmdsUtil = require('../utils/guildCmds');
        const sCfg = readSettingsCfg();
        Object.entries(commands).forEach(([key, updates]) => {
            if (!sCfg.actions[key] || sCfg.actions[key].public !== true) return;
            const patch = {};
            if (typeof updates.enabled === 'boolean')          patch.enabled = updates.enabled;
            if (Array.isArray(updates.aliases))                patch.aliases = updates.aliases;
            if (Array.isArray(updates.ignoredChannels))        patch.ignoredChannels = updates.ignoredChannels;
            if (Array.isArray(updates.ignoredRoles))           patch.ignoredRoles = updates.ignoredRoles;
            if (Array.isArray(updates.enabledChannels))        patch.enabledChannels = updates.enabledChannels;
            if (Array.isArray(updates.allowedRoles))           patch.allowedRoles = updates.allowedRoles;
            if (typeof updates.autoDeleteAuthor === 'boolean') patch.autoDeleteAuthor = updates.autoDeleteAuthor;
            if (typeof updates.autoDeleteReply === 'boolean')  patch.autoDeleteReply = updates.autoDeleteReply;
            guildCmdsUtil.set(guildId, key, patch);
        });
        return res.json({ ok: true });
    } catch (err) {
        logger.error('utility/save failed', { category: 'dashboard', error: err.message, stack: err.stack });
        return res.status(500).json({ error: 'Server error' });
    }
});

/* ── Moderation ──────────────────────────────────────── */
app.get('/dashboard/:guildId/moderation', require('./middleware/auth'), (req, res) => {
    const guildDb = require('./utils/guildDb');
    const { getClient } = require('./utils/botClient');
    const getUnicodeFlagIcon = require('country-flag-icons/unicode').default;
    const botClient = getClient();
    const { guildId } = req.params;

    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.redirect('/dashboard');

    const inBot = botClient ? botClient.guilds.cache.has(guildId) : guildDb.exists(guildId);
    if (!inBot) return res.redirect('/dashboard');

    const guildInfo = raw.find(g => g.id === guildId);
    const guilds = raw.map(g => ({
        ...g,
        inBot: botClient ? botClient.guilds.cache.has(g.id) : guildDb.exists(g.id),
    }));

    let guildRoles = [], guildChannels = [];
    if (botClient) {
        const guild = botClient.guilds.cache.get(guildId);
        if (guild) {
            guildRoles = guild.roles.cache
                .filter(r => !r.managed && r.id !== guildId)
                .map(r => ({ id: r.id, name: r.name, color: r.color ? '#' + r.color.toString(16).padStart(6, '0') : null }))
                .sort((a, b) => b.position - a.position);
            guildChannels = guild.channels.cache
                .filter(c => c.type === 0)
                .map(c => ({ id: c.id, name: c.name }))
                .sort((a, b) => a.name.localeCompare(b.name));
        }
    }


    const guildCmdsUtil = require('../utils/guildCmds');
    const moderationActions = guildCmdsUtil.resolveAllAdmin(guildId);
    const sCfg = readSettingsCfg();
    const botPrefix = (sCfg.system && sCfg.system.PREFIX) ? sCfg.system.PREFIX : '!';

    res.render('moderation', {
        user: req.session.user,
        guildInfo,
        guilds,
        guildRoles,
        guildChannels,
        t: req.t,
        lang: req.lang,
        guildId,
        isShip: getIsShip(req.session.user?.id),
        moderationActions,
        botPrefix,
    });
});

/* ── Moderation Save ─────────────────────────────────── */
app.post('/dashboard/:guildId/moderation/save', require('./middleware/auth'), (req, res) => {
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });

    const { commands } = req.body;
    if (!commands || typeof commands !== 'object') return res.status(400).json({ error: 'Invalid payload' });

    try {
        const guildCmdsUtil = require('../utils/guildCmds');
        const sCfg = readSettingsCfg();
        Object.entries(commands).forEach(([key, updates]) => {
            if (!sCfg.actions[key] || sCfg.actions[key].admin !== true) return;
            const patch = {};
            if (typeof updates.enabled === 'boolean')              patch.enabled = updates.enabled;
            if (Array.isArray(updates.aliases))                    patch.aliases = updates.aliases;
            if (Array.isArray(updates.ignoredChannels))            patch.ignoredChannels = updates.ignoredChannels;
            if (Array.isArray(updates.ignoredRoles))               patch.ignoredRoles = updates.ignoredRoles;
            if (Array.isArray(updates.enabledChannels))            patch.enabledChannels = updates.enabledChannels;
            if (Array.isArray(updates.allowedRoles))               patch.allowedRoles = updates.allowedRoles;
            if (Array.isArray(updates.allowedUsers))               patch.allowedUsers = updates.allowedUsers;
            if (typeof updates.requireAdministrator === 'boolean') patch.requireAdministrator = updates.requireAdministrator;
            if (typeof updates.autoDeleteAuthor === 'boolean')     patch.autoDeleteAuthor = updates.autoDeleteAuthor;
            if (typeof updates.autoDeleteReply === 'boolean')      patch.autoDeleteReply = updates.autoDeleteReply;
            if (key === 'jail') {
                if (typeof updates.addRole === 'string')   patch.addRole  = updates.addRole;
                if (Array.isArray(updates.showRoom))       patch.showRoom = updates.showRoom;
            }
            guildCmdsUtil.set(guildId, key, patch);
        });
        return res.json({ ok: true });
    } catch (err) {
        logger.error('moderation/save failed', { category: 'dashboard', error: err.message, stack: err.stack });
        return res.status(500).json({ error: 'Server error' });
    }
});

/* ── User lookup API (for moderation allowed-users modal) ── */
app.get('/api/user/:userId', require('./middleware/auth'), async (req, res) => {
    const { getClient } = require('./utils/botClient');
    const botClient = getClient();
    if (!botClient) return res.status(503).json({ error: 'Bot offline' });

    const { userId } = req.params;
    const guildId    = req.query.guildId;
    if (!/^\d{17,20}$/.test(userId)) return res.status(400).json({ error: 'Invalid user ID' });

    try {
        const user = await botClient.users.fetch(userId, { force: true });
        let nickname = null;
        if (guildId) {
            try {
                const member = await botClient.guilds.cache.get(guildId)?.members.fetch(userId).catch(() => null);
                if (member) nickname = member.nickname || null;
            } catch (_) {}
        }
        return res.json({
            id:          user.id,
            username:    user.username,
            displayName: user.displayName || user.globalName || user.username,
            nickname,
            avatar:      user.avatar
                ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${user.avatar.startsWith('a_') ? 'gif' : 'png'}?size=256`
                : `https://cdn.discordapp.com/embed/avatars/${Number(user.discriminator || 0) % 5}.png`,
            banner:      user.banner
                ? `https://cdn.discordapp.com/banners/${user.id}/${user.banner}.${user.banner.startsWith('a_') ? 'gif' : 'png'}?size=480`
                : null,
            bannerColor: user.accentColor
                ? '#' + user.accentColor.toString(16).padStart(6, '0')
                : null,
        });
    } catch (e) {
        if (e.code === 10013) return res.status(404).json({ error: 'User not found' });
        return res.status(500).json({ error: 'Error fetching user' });
    }
});

/* ── Current user's Discord presence (real status + custom status) ── */
app.get('/api/me/presence', require('./middleware/auth'), (req, res) => {
    try {
        const { getClient } = require('./utils/botClient');
        const botClient = getClient();
        const userId = String(req.session.user?.id || '');
        if (!botClient || !userId) return res.json({ status: 'offline', customStatus: null });

        let presence = null;
        for (const [, guild] of botClient.guilds.cache) {
            const member = guild.members.cache.get(userId);
            if (member?.presence) { presence = member.presence; break; }
        }

        const status = presence?.status || 'offline';
        let customStatus = null;
        if (presence?.activities) {
            const custom = presence.activities.find(a => a.type === 4); // ActivityType.Custom
            if (custom) {
                const parts = [];
                if (custom.emoji?.name) parts.push(custom.emoji.name);
                if (custom.state) parts.push(custom.state);
                customStatus = parts.join(' ') || null;
            }
        }
        res.json({ status, customStatus });
    } catch (e) {
        res.json({ status: 'offline', customStatus: null });
    }
});

/* ── Guild stats API (member count + online count for topbar) ── */
app.get('/api/guild-stats/:guildId', require('./middleware/auth'), (req, res) => {
    const { getClient } = require('./utils/botClient');
    const botClient = getClient();
    const { guildId } = req.params;

    // Security: user must have access to this guild
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });

    if (!botClient) return res.json({ memberCount: null, onlineCount: null });

    const guild = botClient.guilds.cache.get(guildId);
    if (!guild) return res.json({ memberCount: null, onlineCount: null });

    const memberCount = guild.memberCount || 0;
    // online = members whose presence status is not 'offline' (requires GUILD_PRESENCES intent)
    let onlineCount = null;
    try {
        const presenceCount = guild.presences?.cache?.filter(p => p.status && p.status !== 'offline').size;
        if (typeof presenceCount === 'number') onlineCount = presenceCount;
    } catch (_) {}

    return res.json({ memberCount, onlineCount });
});

/* ── Protection ─────────────────────────────────────── */
app.get('/dashboard/:guildId/protection', require('./middleware/auth'), (req, res) => {
    const guildDb = require('./utils/guildDb');
    const { getClient } = require('./utils/botClient');
    const getUnicodeFlagIcon = require('country-flag-icons/unicode').default;
    const botClient = getClient();
    const { guildId } = req.params;

    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.redirect('/dashboard');

    const inBot = botClient ? botClient.guilds.cache.has(guildId) : guildDb.exists(guildId);
    if (!inBot) return res.redirect('/dashboard');

    const guildInfo = raw.find(g => g.id === guildId);
    const guilds = raw.map(g => ({
        ...g,
        inBot: botClient ? botClient.guilds.cache.has(g.id) : guildDb.exists(g.id),
    }));


    // Per-guild protection config (fallback to global defaults)
    const globalCfg      = readSettingsCfg();
    const guildProtData  = guildDb.read(guildId, 'protection', null);
    const protectionCfg  = guildProtData || Object.assign({}, globalCfg.protection || {});

    // Access control
    const userId    = String(req.session.user?.id || '');
    const userPerms = (protectionCfg.user_permissions || []).map(String);
    const owners    = (globalCfg.DASHBOARD?.OWNERS || []).map(String);
    const canEdit   = userPerms.length === 0
        ? owners.includes(userId)
        : userPerms.includes(userId);

    // Fetch guild roles
    let guildRoles = [];
    if (botClient && botClient.guilds.cache.has(guildId)) {
        const guild = botClient.guilds.cache.get(guildId);
        guildRoles = guild.roles.cache
            .filter(r => !r.managed && r.id !== guild.id)
            .map(r => ({
                id:    r.id,
                name:  r.name,
                color: r.color ? `#${r.color.toString(16).padStart(6,'0')}` : null,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    res.render('protection', {
        user: req.session.user,
        guildInfo,
        guilds,
        t: req.t,
        lang: req.lang,
        guildId,
        isShip: getIsShip(req.session.user?.id),
        protectionCfg,
        canEdit,
        guildRoles,
    });
});

/* ── Protection Save ─────────────────────────────────── */
app.post('/dashboard/:guildId/protection/save', require('./middleware/auth'), (req, res) => {
    const guildDb = require('./utils/guildDb');
    const { guildId } = req.params;

    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Access denied' });

    // Re-check canEdit
    const globalCfg     = readSettingsCfg();
    const guildProtData = guildDb.read(guildId, 'protection', null);
    const existing      = guildProtData || Object.assign({}, globalCfg.protection || {});
    const userId        = String(req.session.user?.id || '');
    const userPerms     = (existing.user_permissions || []).map(String);
    const owners        = (globalCfg.DASHBOARD?.OWNERS || []).map(String);
    const canEdit       = userPerms.length === 0 ? owners.includes(userId) : userPerms.includes(userId);

    if (!canEdit) return res.status(403).json({ error: 'Permission denied' });

    const body = req.body || {};
    const allowed = ['anti_ban','anti_kick','anti_channel_create','anti_channel_delete','anti_role_create','anti_role_delete','anti_bots','anti_webhooks'];

    const newData = {
        '1': existing['1'] || 'kick',
        '2': existing['2'] || 'remove role',
        '3': existing['3'] || 'ban',
        '4': existing['4'] || 'mute',
        '5': existing['5'] || 'jail',
        user_permissions: existing.user_permissions || [],
        enable:           body.enable === true || body.enable === 'true',
        whitelist_roles:  Array.isArray(body.whitelist_roles) ? body.whitelist_roles : [],
    };
    allowed.forEach(key => {
        const src = body[key] || {};
        const prev = existing[key] || {};
        newData[key] = {
            enabled:         src.enabled === true || src.enabled === 'true',
            action:          parseInt(src.action ?? prev.action ?? 2, 10) || 2,
        };
        if (src.limit !== undefined) newData[key].limit = parseInt(src.limit, 10) || 5;
        else if (prev.limit !== undefined) newData[key].limit = prev.limit;
        if (src.whitelist_roles !== undefined) newData[key].whitelist_roles = Array.isArray(src.whitelist_roles) ? src.whitelist_roles : [];
        else if (prev.whitelist_roles !== undefined) newData[key].whitelist_roles = prev.whitelist_roles;
    });

    guildDb.write(guildId, 'protection', newData);
    res.json({ ok: true });
});

/* ── Protection Perms Add ────────────────────────────── */
app.post('/api/:guildId/protection/perms/add', require('./middleware/auth'), (req, res) => {
    const guildDb = require('./utils/guildDb');
    const { guildId } = req.params;
    const { userId: targetId } = req.body || {};
    if (!targetId) return res.status(400).json({ error: 'userId required' });

    const globalCfg     = readSettingsCfg();
    const guildProtData = guildDb.read(guildId, 'protection', null);
    const existing      = guildProtData || Object.assign({}, globalCfg.protection || {});
    const actorId       = String(req.session.user?.id || '');
    const userPerms     = (existing.user_permissions || []).map(String);
    const owners        = (globalCfg.DASHBOARD?.OWNERS || []).map(String);

    // Only owners can add when list is empty; first added = top admin
    const isOwner = owners.includes(actorId);
    const isTopAdmin = userPerms.length > 0 && userPerms[0] === actorId;
    if (!isOwner && !isTopAdmin) return res.status(403).json({ error: 'Permission denied' });

    const tid = String(targetId);
    if (!userPerms.includes(tid)) {
        userPerms.push(tid);
        existing.user_permissions = userPerms;
        guildDb.write(guildId, 'protection', existing);
    }
    res.json({ ok: true });
});

/* ── Protection Perms Remove ─────────────────────────── */
app.delete('/api/:guildId/protection/perms/:uid', require('./middleware/auth'), (req, res) => {
    const guildDb = require('./utils/guildDb');
    const { guildId, uid } = req.params;

    const globalCfg     = readSettingsCfg();
    const guildProtData = guildDb.read(guildId, 'protection', null);
    const existing      = guildProtData || Object.assign({}, globalCfg.protection || {});
    const actorId       = String(req.session.user?.id || '');
    const userPerms     = (existing.user_permissions || []).map(String);
    const owners        = (globalCfg.DASHBOARD?.OWNERS || []).map(String);

    const isOwner    = owners.includes(actorId);
    const isTopAdmin = userPerms.length > 0 && userPerms[0] === actorId;
    if (!isOwner && !isTopAdmin) return res.status(403).json({ error: 'Permission denied' });

    existing.user_permissions = userPerms.filter(id => id !== String(uid));
    guildDb.write(guildId, 'protection', existing);
    res.json({ ok: true });
});

/* ── Auto Roles ───────────────────────────────────────── */
app.get('/dashboard/:guildId/auto-roles', require('./middleware/auth'), (req, res) => {
    const guildDb = require('./utils/guildDb');
    const { getClient } = require('./utils/botClient');
    const getUnicodeFlagIcon = require('country-flag-icons/unicode').default;

    const botClient = getClient();
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.redirect('/dashboard');
    const inBot = botClient ? botClient.guilds.cache.has(guildId) : guildDb.exists(guildId);
    if (!inBot) return res.redirect('/dashboard');

    const guildInfo = raw.find(g => g.id === guildId);
    const guilds    = raw.map(g => ({ ...g, inBot: botClient ? botClient.guilds.cache.has(g.id) : guildDb.exists(g.id) }));

    let guildRoles = [];
    if (botClient) {
        const guild = botClient.guilds.cache.get(guildId);
        if (guild) {
            guildRoles = guild.roles.cache
                .filter(r => !r.managed && r.id !== guildId)
                .map(r => ({ id: r.id, name: r.name, color: r.color ? '#' + r.color.toString(16).padStart(6, '0') : null }))
                .sort((a, b) => (b.position || 0) - (a.position || 0));
        }
    }

    // Read auto_role DB (supports both legacy and new schema)
    let autoRoles = { enabled: false, humans: [], bots: [], inviteRoles: [] };
    const gData = guildDb.read(guildId, 'auto_role', null);
    if (gData) {
        const memberRoles = Array.isArray(gData.memberRoles) ? gData.memberRoles : (Array.isArray(gData.humans) ? gData.humans : []);
        const botRoles    = Array.isArray(gData.botRoles)    ? gData.botRoles    : (Array.isArray(gData.bots)   ? gData.bots   : []);
        const inviteRoles = Array.isArray(gData.inviteRoles) ? gData.inviteRoles : [];

        autoRoles.humans  = memberRoles.map(String);
        autoRoles.bots    = botRoles.map(String);
        autoRoles.inviteRoles = inviteRoles
            .filter(x => x && typeof x === 'object')
            .map(x => ({ invite: String(x.invite || '').trim(), role: String(x.role || '').trim() }))
            .filter(x => x.invite && x.role);
        autoRoles.enabled = gData.enabled !== false; // default true if key exists
    }


    res.render('auto_roles', {
        user: req.session.user,
        guildInfo,
        guilds,
        guildRoles,
        autoRoles,
        t: req.t,
        lang: req.lang,
        guildId,
        isShip: getIsShip(req.session.user?.id)
    });
});

app.post('/dashboard/:guildId/auto-roles/save', require('./middleware/auth'), (req, res) => {
    const guildDb = require('./utils/guildDb');

    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });

    const { enabled, humans, bots, memberRoles, botRoles, inviteRoles } = req.body || {};

    try {
        const normalizeRoleList = (arr) => Array.from(new Set((Array.isArray(arr) ? arr : []).map(String).filter(Boolean)));

        const normalizedMemberRoles = normalizeRoleList(Array.isArray(memberRoles) ? memberRoles : humans);
        const normalizedBotRoles    = normalizeRoleList(Array.isArray(botRoles) ? botRoles : bots);
        const normalizedInviteRoles = Array.isArray(inviteRoles)
            ? inviteRoles
                .filter(x => x && typeof x === 'object')
                .map(x => ({
                    invite: String(x.invite || '').trim(),
                    role: String(x.role || '').trim()
                }))
                .filter(x => x.invite && x.role)
            : [];

        const data = {
            guildId,
            enabled: enabled !== false && enabled !== 'false',
            memberRoles: normalizedMemberRoles,
            botRoles: normalizedBotRoles,
            inviteRoles: normalizedInviteRoles
        };

        guildDb.write(guildId, 'auto_role', data);
        res.json({ ok: true });
    } catch (err) {
        logger.error('auto-roles/save failed', { category: 'dashboard', error: err.message, stack: err.stack });
        res.status(500).json({ error: 'Failed to save' });
    }
});

/* ── Suggestions ─────────────────────────────────────── */
app.get('/dashboard/:guildId/suggestions', require('./middleware/auth'), (req, res) => {
    const guildDb = require('./utils/guildDb');
    const { getClient } = require('./utils/botClient');
    const botClient = getClient();
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.redirect('/dashboard');
    const inBot = botClient ? botClient.guilds.cache.has(guildId) : guildDb.exists(guildId);
    if (!inBot) return res.redirect('/dashboard');

    const guildInfo = raw.find(g => g.id === guildId);
    const guilds    = raw.map(g => ({ ...g, inBot: botClient ? botClient.guilds.cache.has(g.id) : guildDb.exists(g.id) }));

    let guildChannels = [];
    let guildRoles    = [];
    let guildEmojis   = [];
    if (botClient) {
        const guild = botClient.guilds.cache.get(guildId);
        if (guild) {
            guildChannels = guild.channels.cache
                .filter(c => c.type === 0)
                .map(c => ({ id: c.id, name: c.name }))
                .sort((a, b) => a.name.localeCompare(b.name));
            guildRoles = guild.roles.cache
                .filter(r => !r.managed && r.id !== guildId)
                .map(r => ({ id: r.id, name: r.name, color: r.color ? '#' + r.color.toString(16).padStart(6, '0') : null }))
                .sort((a, b) => (b.position || 0) - (a.position || 0));
            guildEmojis = guild.emojis.cache
                .map(e => ({ id: e.id, name: e.name, animated: e.animated, url: e.imageURL({ size: 32 }) }))
                .sort((a, b) => a.name.localeCompare(b.name));
        }
    }

    // Default settings
    const defaultSettings = {
        enabled: false, channel: '', allowThreads: false,
        voting: { enabled: true, type: 'upvote_downvote', upvoteEmoji: '\uD83D\uDC4D', downvoteEmoji: '\uD83D\uDC4E', multipleReactions: [] },
        autoThreshold: { enabled: false, minUpvotes: 10, minDownvotes: 5 },
        permissions: { allowAll: true, allowedRoles: [], minAccountAge: 0, minServerLevel: 0 },
        spam: { cooldown: 10, maxPerDay: 3 },
        moderation: { requireApproval: false, pendingChannel: '', requireRejectReason: true },
        statusTags: { accepted: 'Accepted', rejected: 'Rejected', considered: 'Under Review' }
    };

    const suggestions = Object.assign({}, defaultSettings, guildDb.read(guildId, 'suggestions_config', null) || {});

    res.render('suggestions', {
        user:         req.session.user,
        guildInfo,
        guilds,
        guildChannels,
        guildRoles,
        guildEmojis,
        suggestions,
        guildId,
        t:            req.t,
        lang:         req.lang,
        isShip:       getIsShip(req.session.user?.id),
    });
});

app.post('/dashboard/:guildId/suggestions/save', require('./middleware/auth'), (req, res) => {
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });

    try {
        const body = req.body || {};
        const toInt = (v, def) => { const n = parseInt(v, 10); return isNaN(n) || n < 0 ? def : n; };
        const toBool = (v) => v === true || v === 'true' || v === 1 || v === '1';
        const toStr = (v, def = '') => (typeof v === 'string' ? v.trim().slice(0, 200) : def);

        const voting = body.voting || {};
        const autoT  = body.autoThreshold || {};
        const perms  = body.permissions || {};
        const spam   = body.spam || {};
        const mod    = body.moderation || {};
        const tags   = body.statusTags || {};

        const multipleReactions = Array.isArray(voting.multipleReactions)
            ? voting.multipleReactions.map(e => toStr(e)).filter(Boolean).slice(0, 10)
            : [];
        const allowedRoles = Array.isArray(perms.allowedRoles)
            ? perms.allowedRoles.map(String).filter(Boolean)
            : [];

        const data = {
            guildId,
            enabled:      toBool(body.enabled),
            channel:      toStr(body.channel),
            allowThreads: toBool(body.allowThreads),
            voting: {
                enabled:           toBool(voting.enabled),
                type:              ['upvote_downvote','multiple_reactions','buttons'].includes(voting.type) ? voting.type : 'upvote_downvote',
                upvoteEmoji:       toStr(voting.upvoteEmoji, '\uD83D\uDC4D'),
                downvoteEmoji:     toStr(voting.downvoteEmoji, '\uD83D\uDC4E'),
                multipleReactions
            },
            autoThreshold: {
                enabled:     toBool(autoT.enabled),
                minUpvotes:  toInt(autoT.minUpvotes, 10),
                minDownvotes: toInt(autoT.minDownvotes, 5)
            },
            permissions: {
                allowAll:      toBool(perms.allowAll),
                allowedRoles,
                minAccountAge: toInt(perms.minAccountAge, 0),
                minServerLevel: toInt(perms.minServerLevel, 0)
            },
            spam: {
                cooldown:  toInt(spam.cooldown, 10),
                maxPerDay: toInt(spam.maxPerDay, 3)
            },
            moderation: {
                requireApproval:     toBool(mod.requireApproval),
                pendingChannel:      toStr(mod.pendingChannel),
                requireRejectReason: toBool(mod.requireRejectReason)
            },
            statusTags: {
                accepted:   toStr(tags.accepted, 'Accepted'),
                rejected:   toStr(tags.rejected, 'Rejected'),
                considered: toStr(tags.considered, 'Under Review')
            }
        };

        const guildDb = require('./utils/guildDb');
        guildDb.write(guildId, 'suggestions_config', data);
        res.json({ ok: true });
    } catch (err) {
        logger.error('suggestions/save failed', { category: 'dashboard', error: err.message, stack: err.stack });
        res.status(500).json({ error: 'Failed to save' });
    }
});

/* ── Auto Responder ──────────────────────────────────── */
app.get('/dashboard/:guildId/auto-responder', require('./middleware/auth'), (req, res) => {
    const guildDb = require('./utils/guildDb');
    const { getClient } = require('./utils/botClient');
    const botClient = getClient();
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.redirect('/dashboard');
    const inBot = botClient ? botClient.guilds.cache.has(guildId) : guildDb.exists(guildId);
    if (!inBot) return res.redirect('/dashboard');

    const guildInfo = raw.find(g => g.id === guildId);
    const guilds    = raw.map(g => ({ ...g, inBot: botClient ? botClient.guilds.cache.has(g.id) : guildDb.exists(g.id) }));

    let guildRoles = [], guildChannels = [];
    if (botClient) {
        const guild = botClient.guilds.cache.get(guildId);
        if (guild) {
            guildRoles = guild.roles.cache
                .filter(r => !r.managed && r.id !== guildId)
                .map(r => ({ id: r.id, name: r.name, color: r.color ? '#' + r.color.toString(16).padStart(6, '0') : null }))
                .sort((a, b) => (b.position || 0) - (a.position || 0));
            guildChannels = guild.channels.cache
                .filter(c => c.type === 0)
                .map(c => ({ id: c.id, name: c.name }))
                .sort((a, b) => a.name.localeCompare(b.name));
        }
    }

    const defaultAR = { enabled: false, responses: [] };
    const autoResponder = Object.assign({}, defaultAR, guildDb.read(guildId, 'auto_responder', null) || {});

    res.render('auto_responder', {
        user:     req.session.user,
        guildInfo,
        guilds,
        guildId,
        guildRoles,
        guildChannels,
        autoResponder,
        t:        req.t,
        lang:     req.lang,
        isShip:   getIsShip(req.session.user?.id),
    });
});

app.post('/dashboard/:guildId/auto-responder/save', require('./middleware/auth'), express.json(), (req, res) => {
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const body    = req.body || {};
        const toBool  = v => v === true || v === 'true' || v === 1 || v === '1';
        const toStr   = (v, def = '') => (typeof v === 'string' ? v.trim().slice(0, 2000) : def);
        const toArr   = v => Array.isArray(v) ? v : [];
        const toInt   = (v, def) => { const n = parseInt(v, 10); return isNaN(n) || n < 0 ? def : n; };

        const responses = toArr(body.responses).map(r => ({
            id:                 (typeof r.id === 'string' && r.id) ? r.id : (Date.now().toString(36) + Math.random().toString(36).slice(2)),
            triggers:           toArr(r.triggers).map(t => toStr(t)).filter(Boolean).slice(0, 20),
            triggerType:        ['equals','contains','startsWith','endsWith'].includes(r.triggerType) ? r.triggerType : 'contains',
            sendType:           ['send','reply','reply_mention','dm'].includes(r.sendType) ? r.sendType : 'reply',
            messages:           toArr(r.messages).map(m => toStr(m)).filter(Boolean).slice(0, 10),
            giveRole:           toStr(r.giveRole),
            ignoredChannels:    toArr(r.ignoredChannels).map(String).filter(Boolean),
            ignoredRoles:       toArr(r.ignoredRoles).map(String).filter(Boolean),
            enabledChannels:    toArr(r.enabledChannels).map(String).filter(Boolean),
            allowedRoles:       toArr(r.allowedRoles).map(String).filter(Boolean),
            autoDeleteBotReply: toBool(r.autoDeleteBotReply),
            deleteOnAuthorDelete: toBool(r.deleteOnAuthorDelete),
            deleteUserMessage:  toBool(r.deleteUserMessage),
            enabled:            toBool(r.enabled !== undefined ? r.enabled : true),
        })).slice(0, 50);

        const data = { enabled: toBool(body.enabled), responses };
        const guildDb = require('./utils/guildDb');
        guildDb.write(guildId, 'auto_responder', data);
        res.json({ ok: true });
    } catch (err) {
        logger.error('auto-responder/save failed', { category: 'dashboard', error: err.message, stack: err.stack });
        res.status(500).json({ error: 'Failed to save' });
    }
});

/* ── Points: Ticket Points ───────────────────────────── */
app.get('/dashboard/:guildId/points/tickets', require('./middleware/auth'), (req, res) => {
    const fs            = require('fs');
    const path          = require('path');
    const guildDb       = require('./utils/guildDb');
    const staffPoints   = require('../systems/points_tickets');
    const { getClient } = require('./utils/botClient');
    const botClient     = getClient();
    const { guildId }   = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.redirect('/dashboard');
    const inBot = botClient ? botClient.guilds.cache.has(guildId) : guildDb.exists(guildId);
    if (!inBot) return res.redirect('/dashboard');
    const guildInfo = raw.find(g => g.id === guildId);
    const guilds    = raw.map(g => ({ ...g, inBot: botClient ? botClient.guilds.cache.has(g.id) : guildDb.exists(g.id) }));

    // Load staff points config and scores
    const staffPointsConfig = staffPoints.getConfig(guildId);
    const staffScores       = staffPoints.getScores(guildId);

    // Fetch channels and roles from the bot client
    let guildChannels = [];
    let guildRoles    = [];
    if (botClient) {
        const guild = botClient.guilds.cache.get(guildId);
        if (guild) {
            guildChannels = guild.channels.cache
                .filter(c => c.type === 0)
                .map(c => ({ id: c.id, name: c.name }))
                .sort((a, b) => a.name.localeCompare(b.name));
            guildRoles = guild.roles.cache
                .filter(r => !r.managed && r.id !== guild.id)
                .map(r => ({ id: r.id, name: r.name, color: r.hexColor }))
                .sort((a, b) => b.position - a.position);
        }
    }

    // Read all available bot commands from the commands folder
    let guildCommands = [];
    try {
        const cmdsDir = path.join(__dirname, '../commands');
        guildCommands = fs.readdirSync(cmdsDir)
            .filter(f => f.endsWith('.js'))
            .map(f => f.replace('.js', '').replace(/_/g, ' '))
            .sort();
    } catch (_) {}

    res.render('points_tickets', {
        user: req.session.user, guildInfo, guilds,
        t: req.t, lang: req.lang, guildId,
        isShip: getIsShip(req.session.user?.id),
        staffPointsConfig, staffScores,
        guildChannels, guildRoles, guildCommands,
    });
});

/* ── Points: Ticket Points — Save ───────────────────────── */
app.post('/dashboard/:guildId/points/tickets/save', require('./middleware/auth'), express.json(), (req, res) => {
    try {
        const guildDb     = require('./utils/guildDb');
        const staffPoints = require('../systems/staff_points');
        const { guildId } = req.params;
        const raw = req.session.guilds || [];
        if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });

        const body   = req.body || {};
        const current = staffPoints.getConfig(guildId);

        // Build sanitised config from request body
        const toNum  = (v, fallback) => { const n = parseInt(v, 10); return isNaN(n) ? fallback : n; };
        const toBool = (v, fallback) => (typeof v === 'boolean' ? v : (v === 'true' ? true : (v === 'false' ? false : fallback)));

        const newConfig = {
            enabled: toBool(body.enabled, current.enabled),
            ticketPoints: {
                enabled: toBool(body.ticketPoints?.enabled, current.ticketPoints.enabled),
                claim: {
                    enabled: toBool(body.ticketPoints?.claim?.enabled, current.ticketPoints.claim.enabled),
                    points:  toNum(body.ticketPoints?.claim?.points, current.ticketPoints.claim.points),
                },
                close: {
                    enabled: toBool(body.ticketPoints?.close?.enabled, current.ticketPoints.close.enabled),
                    points:  toNum(body.ticketPoints?.close?.points, current.ticketPoints.close.points),
                },
            },
            ratingPoints: {
                enabled: toBool(body.ratingPoints?.enabled, current.ratingPoints?.enabled ?? false),
                // Per-star points (1–5)
                stars: {
                    5: toNum(body.ratingPoints?.stars?.[5] ?? body.ratingPoints?.stars?.['5'], 10),
                    4: toNum(body.ratingPoints?.stars?.[4] ?? body.ratingPoints?.stars?.['4'], 5),
                    3: toNum(body.ratingPoints?.stars?.[3] ?? body.ratingPoints?.stars?.['3'], 0),
                    2: toNum(body.ratingPoints?.stars?.[2] ?? body.ratingPoints?.stars?.['2'], -2),
                    1: toNum(body.ratingPoints?.stars?.[1] ?? body.ratingPoints?.stars?.['1'], -5),
                },
            },
            commandPoints: {
                enabled: toBool(body.commandPoints?.enabled, current.commandPoints.enabled),
                // Dynamic array of { id, name, points }
                commands: Array.isArray(body.commandPoints?.commands)
                    ? body.commandPoints.commands
                        .filter(c => c.name && typeof c.name === 'string')
                        .map(c => ({
                            id:     String(c.id || Date.now()),
                            name:   String(c.name).replace(/[^a-z0-9_ -]/gi, '').toLowerCase().trim().slice(0, 50),
                            points: toNum(c.points, 1),
                        }))
                        .filter(c => c.name)
                    : (Array.isArray(current.commandPoints.commands) ? current.commandPoints.commands : []),
            },
            logsChannelId: body.logsChannelId || null,
            antiAbuse: {
                enabled:          toBool(body.antiAbuse?.enabled, current.antiAbuse.enabled),
                noSelfClaim:      toBool(body.antiAbuse?.noSelfClaim, current.antiAbuse.noSelfClaim),
                noSelfRate:       toBool(body.antiAbuse?.noSelfRate, current.antiAbuse.noSelfRate),
                noDuplicatePoints:toBool(body.antiAbuse?.noDuplicatePoints, current.antiAbuse.noDuplicatePoints),
                cooldownMinutes:  toNum(body.antiAbuse?.cooldownMinutes, current.antiAbuse.cooldownMinutes),
            },
            rewards: {
                enabled: toBool(body.rewards?.enabled, current.rewards.enabled),
                list: Array.isArray(body.rewards?.list) ? body.rewards.list.map(r => ({
                    id:     String(r.id || Date.now()),
                    points: toNum(r.points, 100),
                    roleId: String(r.roleId || ''),
                    label:  String(r.label || '').slice(0, 80),
                })).filter(r => r.points > 0) : current.rewards.list,
            },
        };

        guildDb.write(guildId, 'staff_points', newConfig);
        res.json({ ok: true });
    } catch (err) {
        logger.error('points/tickets/save failed', { category: 'dashboard', error: err.message, stack: err.stack });
        res.status(500).json({ error: 'Failed to save' });
    }
});

/* ── Points: Interaction Points ─────────────────────── */
app.get('/dashboard/:guildId/points/interactions', require('./middleware/auth'), (req, res) => {
    const guildDb    = require('./utils/guildDb');
    const { getClient } = require('./utils/botClient');
    const interactionPoints = require('../systems/points_interactions');
    const botClient  = getClient();
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.redirect('/dashboard');
    const inBot = botClient ? botClient.guilds.cache.has(guildId) : guildDb.exists(guildId);
    if (!inBot) return res.redirect('/dashboard');
    const guildInfo  = raw.find(g => g.id === guildId);
    const guilds     = raw.map(g => ({ ...g, inBot: botClient ? botClient.guilds.cache.has(g.id) : guildDb.exists(g.id) }));
    const interactionConfig = interactionPoints.getConfig(guildId);

    let guildChannels = [], guildRoles = [];
    if (botClient) {
        const guild = botClient.guilds.cache.get(guildId);
        if (guild) {
            guildChannels = guild.channels.cache
                .filter(c => c.type === 0)
                .map(c => ({ id: c.id, name: c.name }))
                .sort((a, b) => a.name.localeCompare(b.name));
            guildRoles = guild.roles.cache
                .filter(r => !r.managed && r.id !== guild.id)
                .map(r => ({ id: r.id, name: r.name }))
                .sort((a, b) => b.position - a.position);
        }
    }

    res.render('points_interactions', {
        user: req.session.user, guildInfo, guilds,
        t: req.t, lang: req.lang, guildId,
        isShip: getIsShip(req.session.user?.id),
        interactionConfig, guildChannels, guildRoles,
    });
});

/* ── Points: Interaction Points — Save ─────────────────── */
app.post('/dashboard/:guildId/points/interactions/save', require('./middleware/auth'), express.json(), (req, res) => {
    try {
        const guildDb    = require('./utils/guildDb');
        const interactionPoints = require('../systems/points_interactions');
        const { guildId } = req.params;
        const raw = req.session.guilds || [];
        if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });

        const body    = req.body || {};
        const current = interactionPoints.getConfig(guildId);
        const toNum   = (v, fb) => { const n = parseInt(v, 10); return isNaN(n) ? fb : n; };
        const toBool  = (v, fb) => (typeof v === 'boolean' ? v : (v === 'true' ? true : (v === 'false' ? false : fb)));

        const newConfig = {
            enabled: toBool(body.enabled, current.enabled),

            messagePoints: {
                enabled:         toBool(body.messagePoints?.enabled, current.messagePoints.enabled),
                points:          toNum(body.messagePoints?.points, current.messagePoints.points),
                cooldownSeconds: toNum(body.messagePoints?.cooldownSeconds, current.messagePoints.cooldownSeconds),
                minLength:       toNum(body.messagePoints?.minLength, current.messagePoints.minLength),
            },

            reactionPoints: {
                enabled:       toBool(body.reactionPoints?.enabled, current.reactionPoints.enabled),
                givePoints:    toNum(body.reactionPoints?.givePoints, current.reactionPoints.givePoints),
                receivePoints: toNum(body.reactionPoints?.receivePoints, current.reactionPoints.receivePoints),
            },

            voicePoints: {
                enabled:         toBool(body.voicePoints?.enabled, current.voicePoints.enabled),
                pointsPerMinute: toNum(body.voicePoints?.pointsPerMinute, current.voicePoints.pointsPerMinute),
                ignoreAfk:       toBool(body.voicePoints?.ignoreAfk, current.voicePoints.ignoreAfk),
                ignoreMuted:     toBool(body.voicePoints?.ignoreMuted, current.voicePoints.ignoreMuted),
            },

            mediaPoints: {
                enabled:      toBool(body.mediaPoints?.enabled, current.mediaPoints.enabled),
                imagePoints:  toNum(body.mediaPoints?.imagePoints, current.mediaPoints.imagePoints),
                linkPoints:   toNum(body.mediaPoints?.linkPoints, current.mediaPoints.linkPoints),
            },

            channels: {
                ignored: Array.isArray(body.channels?.ignored) ? body.channels.ignored.filter(Boolean) : current.channels.ignored,
                allowed: Array.isArray(body.channels?.allowed) ? body.channels.allowed.filter(Boolean) : current.channels.allowed,
            },

            roles: {
                ignored: Array.isArray(body.roles?.ignored) ? body.roles.ignored.filter(Boolean) : current.roles.ignored,
                bonus: Array.isArray(body.roles?.bonus)
                    ? body.roles.bonus.map(b => ({ roleId: String(b.roleId || ''), multiplier: parseFloat(b.multiplier) || 1 })).filter(b => b.roleId)
                    : current.roles.bonus,
            },

            logsChannelId: body.logsChannelId || null,
        };

        guildDb.write(guildId, 'interaction_points', newConfig);
        res.json({ ok: true });
    } catch (err) {
        logger.error('points/interactions/save failed', { category: 'dashboard', error: err.message, stack: err.stack });
        res.status(500).json({ error: 'Failed to save' });
    }
});

/* ── Welcome Messages ────────────────────────────────── */
function _welcomeRoute(view) {
    return [require('./middleware/auth'), (req, res) => {
        const guildDb = require('./utils/guildDb');
        const { getClient } = require('./utils/botClient');
        const botClient = getClient();
        const { guildId } = req.params;
        const raw = req.session.guilds || [];
        if (!raw.find(g => g.id === guildId)) return res.redirect('/dashboard');
        const inBot = botClient ? botClient.guilds.cache.has(guildId) : guildDb.exists(guildId);
        if (!inBot) return res.redirect('/dashboard');
        const guildInfo = raw.find(g => g.id === guildId);
        const guilds = raw.map(g => ({ ...g, inBot: botClient ? botClient.guilds.cache.has(g.id) : guildDb.exists(g.id) }));
        res.render(view, { user: req.session.user, guildInfo, guilds, t: req.t, lang: req.lang, guildId, isShip: getIsShip(req.session.user?.id) });
    }];
}

/* ── Welcome/Join — full featured ───────────────────── */
app.get('/dashboard/:guildId/welcome/join', require('./middleware/auth'), async (req, res) => {
    const db = require('../systems/schemas');
    const { getClient } = require('./utils/botClient');
    const botClient = getClient();
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.redirect('/dashboard');
    const inBot = botClient ? botClient.guilds.cache.has(guildId) : false;
    if (!inBot) return res.redirect('/dashboard');
    const guildInfo = raw.find(g => g.id === guildId);
    const guilds    = raw.map(g => ({ ...g, inBot: botClient ? botClient.guilds.cache.has(g.id) : false }));

    let guildChannels = [];
    let guildRoles = [];
    if (botClient) {
        const guild = botClient.guilds.cache.get(guildId);
        if (guild) {
            guildChannels = guild.channels.cache
                .filter(c => c.type === 0)
                .map(c => ({ id: c.id, name: c.name }))
                .sort((a, b) => a.name.localeCompare(b.name));
            guildRoles = guild.roles.cache
                .filter(r => !r.managed && r.name !== '@everyone')
                .map(r => ({ id: r.id, name: r.name, color: r.hexColor || '#99aab5', position: r.rawPosition }))
                .sort((a, b) => b.position - a.position);
        }
    }

    let welcomeConfig;
    try {
        welcomeConfig = await db.WelcomeJoin.getConfig(guildId);
        logger.info('welcome/join loaded', {
            category: 'dashboard',
            guildId,
            fromMongo: !!(welcomeConfig && welcomeConfig._id),
            templateCount: Array.isArray(welcomeConfig?.templates) ? welcomeConfig.templates.length : 0,
            enabled: welcomeConfig?.enabled,
        });
    } catch (err) {
        logger.error('welcome/join getConfig failed', { category: 'dashboard', guildId, error: err.message });
        welcomeConfig = {
            guildId, enabled: false, welcomeText: false, dmWelcome: false, dmMessage: '',
            sendDelay: 0, deleteDelay: 0, waitRules: false, ignoreBots: false, ignoreUsers: false,
            templates: [], groups: [],
        };
    }

    let imgConfig = { enabled: false, sendMode: 'embed', attachmentText: '', channelId: '', linkedTemplateId: '' };
    try { imgConfig = await db.WelcomeImage.getConfig(guildId); } catch { /* use defaults */ }

    const memberCount = botClient?.guilds.cache.get(guildId)?.memberCount ?? 0;

    res.render('welcome_join', {
        user: req.session.user, guildInfo, guilds,
        guildChannels, guildRoles, welcomeConfig, imgConfig,
        t: req.t, lang: req.lang, guildId,
        memberCount, isShip: getIsShip(req.session.user?.id)
    });
});

/* ── Welcome/Join Save ───────────────────────────────── */
app.post('/dashboard/:guildId/welcome/join/save', require('./middleware/auth'), async (req, res) => {
    const db = require('../systems/schemas');
    const { getClient } = require('./utils/botClient');
    const botClient = getClient();
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    const inBot = botClient ? botClient.guilds.cache.has(guildId) : false;
    if (!inBot) return res.status(403).json({ error: 'Guild not found' });

    try {
        const allowed = ['enabled','welcomeText','dmWelcome','dmMessage',
                         'sendDelay','deleteDelay','waitRules',
                         'ignoreBots','ignoreUsers','templates','groups'];
        const patch = {};
        for (const key of allowed) {
            if (key in req.body) patch[key] = req.body[key];
        }
        // Clamp numeric fields
        if (typeof patch.sendDelay   === 'number') patch.sendDelay   = Math.max(0, Math.min(300,  patch.sendDelay));
        if (typeof patch.deleteDelay === 'number') patch.deleteDelay = Math.max(0, Math.min(3600, patch.deleteDelay));

        const saved = await db.WelcomeJoin.patch(guildId, patch);
        const savedCount = Array.isArray(saved?.templates) ? saved.templates.length : (Array.isArray(patch?.templates) ? patch.templates.length : 0);
        logger.info('welcome/join saved', {
            category: 'dashboard',
            guildId,
            templateCount: savedCount,
            enabled: patch.enabled,
            mongoConnected: require('../systems/schemas').isConnected(),
        });
        res.json({ success: true, templateCount: savedCount });
    } catch (err) {
        logger.error('welcome/join/save failed', { category: 'dashboard', guildId, error: err.message, stack: err.stack });
        res.status(500).json({ error: 'Failed to save', detail: err.message });
    }
});

app.get('/dashboard/:guildId/welcome/leave',      ..._welcomeRoute('welcome_leave'));

/* ── Welcome/Join Test Send ──────────────────────────── */
app.post('/dashboard/:guildId/welcome/join/test-send', require('./middleware/auth'), async (req, res) => {
    const { getClient } = require('./utils/botClient');
    const botClient = getClient();
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    const inBot = botClient ? botClient.guilds.cache.has(guildId) : false;
    if (!inBot) return res.status(403).json({ error: 'Guild not found' });
    try {
        const { template, targetChannelId } = req.body;
        if (!template || typeof template !== 'object') return res.status(400).json({ error: 'No template provided' });
        const guild  = botClient.guilds.cache.get(guildId);
        const member = guild ? await guild.members.fetch(req.session.user.id).catch(() => null) : null;
        if (!guild || !member) return res.status(400).json({ error: 'Could not find your member in this guild' });
        // Resolve send target
        const chId = targetChannelId || template.channelId;
        let channel = null;
        if (!chId || chId === 'dm') {
            channel = await member.user.createDM().catch(() => null);
        } else {
            channel = guild.channels.cache.get(chId) || null;
        }
        if (!channel) return res.status(400).json({ error: 'Channel not found or bot lacks access' });
        // Variable replacement — matches [variable] syntax used in templates
        const today    = new Date();
        const created  = member.user.createdAt;
        const daysSince = Math.floor((Date.now() - created.getTime()) / 86_400_000);
        const replace = s => (s || '')
            .replace(/\[user\]/g,            member.toString())
            .replace(/\[userName\]/g,        member.user.username)
            .replace(/\[userCreatedDate\]/g, created.toLocaleDateString('en-GB'))
            .replace(/\[userCreatedDays\]/g, String(daysSince))
            .replace(/\[serverName\]/g,      guild.name)
            .replace(/\[memberCount\]/g,     String(guild.memberCount))
            .replace(/\[inviter\]/g,         member.toString())
            .replace(/\[inviterName\]/g,     member.user.username)
            .replace(/\[invitesCount\]/g,    '0')
            .replace(/\[inviteCode\]/g,      'N/A');
        const { EmbedBuilder } = require('discord.js');
        const type = template.type || 'text';
        if (type === 'embed') {
            const eb = new EmbedBuilder();
            const em = template.embed || {};
            if (em.title)       eb.setTitle(replace(em.title).slice(0, 256));
            if (em.description) eb.setDescription(replace(em.description).slice(0, 4096));
            if (em.color)       { try { eb.setColor(em.color); } catch {} }
            if (em.footer)      eb.setFooter({ text: replace(em.footer).slice(0, 2048) });
            if (em.thumbnail)   { const t = replace(em.thumbnail); if (/^https?:\/\//.test(t)) eb.setThumbnail(t); }
            await channel.send({ embeds: [eb] });
        } else if (type === 'component') {
            const { buildComponentPayload } = require('./utils/componentBuilder');
            let parsed; try { parsed = JSON.parse(template.componentJson || '{}'); } catch { return res.status(400).json({ error: 'Invalid component JSON' }); }
            const rows = Array.isArray(parsed.components) ? parsed.components : (Array.isArray(parsed) ? parsed : []);
            await channel.send(buildComponentPayload({ content: '', components: rows }));
        } else {
            const text = replace(template.content || 'Test welcome message').slice(0, 2000);
            await channel.send(text);
        }
        res.json({ success: true });
    } catch (err) {
        logger.error('welcome/join/test-send failed', { category: 'dashboard', error: err.message });
        res.status(500).json({ error: err.message || 'Failed to send' });
    }
});

/* ── Welcome/Join Dynamic Image Test Send ─────────────── */
app.post('/dashboard/:guildId/welcome/join/image/test-send', require('./middleware/auth'), async (req, res) => {
    const { getClient } = require('./utils/botClient');
    const botClient = getClient();
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    const inBot = botClient ? botClient.guilds.cache.has(guildId) : false;
    if (!inBot) return res.status(403).json({ error: 'Guild not found in bot cache' });
    try {
        const db      = require('../systems/schemas');
        const guild   = botClient.guilds.cache.get(guildId);

        // Use the dashboard user as the test member (their avatar/name used where relevant)
        const member  = await guild.members.fetch(req.session.user.id).catch(() => null);
        if (!member) return res.status(400).json({ error: 'Could not find your member in this guild' });

        // Load saved WelcomeImage config; allow overriding linkedTemplateId from request
        const imgConfig = await db.WelcomeImage.getConfig(guildId);
        const { linkedTemplateName } = req.body;
        if (linkedTemplateName) imgConfig.linkedTemplateId = linkedTemplateName;

        const mode = imgConfig.sendMode || 'embed';

        // Determine target channel
        let channelId = imgConfig.channelId;
        if (mode === 'embed' || mode === 'component') {
            if (!imgConfig.linkedTemplateId) return res.status(400).json({ error: 'No linked template selected' });
            const joinCfg   = await db.WelcomeJoin.findOne({ guildId }).lean();
            const templates = Array.isArray(joinCfg?.templates) ? joinCfg.templates : [];
            const linkedTpl = templates.find(t => t.name === imgConfig.linkedTemplateId);
            if (!linkedTpl || !linkedTpl.channelId) return res.status(400).json({ error: `Template "${imgConfig.linkedTemplateId}" not found or has no channel` });
            channelId = linkedTpl.channelId;
        }

        const channel = guild.channels.cache.get(channelId);
        if (!channel) return res.status(400).json({ error: 'Channel not found or bot lacks access' });

        // Render the image on-server via node-canvas
        const { renderWelcomeImage } = require('../systems/welcome_image_renderer');
        const imageBuffer = await renderWelcomeImage(imgConfig, { member, guild });
        if (!imageBuffer || !imageBuffer.length) return res.status(500).json({ error: 'Image rendering produced empty output' });

        const {
            AttachmentBuilder, EmbedBuilder,
            ContainerBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder,
            TextDisplayBuilder, MessageFlags,
        } = require('discord.js');
        const attachment = new AttachmentBuilder(imageBuffer, { name: 'welcome.png' });

        // Variable resolver (same logic as welcome_join system)
        const resolveVars = (s) => {
            if (!s) return '';
            const user    = member.user;
            const created = user.createdAt;
            const days    = Math.floor((Date.now() - created.getTime()) / 86_400_000);
            return s
                .replace(/\[user\]/g,            member.toString())
                .replace(/\[userName\]/g,        user.username)
                .replace(/\[userCreatedDate\]/g, created.toLocaleDateString('en-GB'))
                .replace(/\[userCreatedDays\]/g, String(days))
                .replace(/\[serverName\]/g,      guild.name)
                .replace(/\[memberCount\]/g,     String(guild.memberCount))
                .replace(/\[inviter\]/g,         member.toString())
                .replace(/\[inviterName\]/g,     user.username)
                .replace(/\[invitesCount\]/g,    '0')
                .replace(/\[inviteCode\]/g,      'N/A');
        };

        if (mode === 'embed') {
            const e    = new EmbedBuilder().setImage('attachment://welcome.png');
            const opts = imgConfig.embedOptions || {};
            if (opts.title)       e.setTitle(resolveVars(opts.title).slice(0, 256));
            if (opts.description) e.setDescription(resolveVars(opts.description).slice(0, 4096));
            if (opts.footer)      e.setFooter({ text: resolveVars(opts.footer).slice(0, 2048) });
            if (opts.color)       { try { e.setColor(opts.color); } catch { /* invalid hex */ } }
            await channel.send({ embeds: [e], files: [attachment] });

        } else if (mode === 'component') {
            const container     = new ContainerBuilder();
            const componentText = resolveVars(imgConfig.componentText || '');
            if (componentText.trim()) {
                container.addTextDisplayComponents(new TextDisplayBuilder().setContent(componentText));
            }
            container.addMediaGalleryComponents(
                new MediaGalleryBuilder().addItems(
                    new MediaGalleryItemBuilder().setURL('attachment://welcome.png')
                )
            );
            await channel.send({ components: [container], files: [attachment], flags: MessageFlags.IsComponentsV2 });

        } else {
            // attachment mode — standalone file with optional text
            const text = resolveVars(imgConfig.attachmentText || '');
            await channel.send({ content: text.trim() || undefined, files: [attachment] });
        }

        res.json({ success: true });
    } catch (err) {
        logger.error('welcome/join/image/test-send failed', { category: 'dashboard', error: err.message });
        res.status(500).json({ error: err.message || 'Failed to send' });
    }
});

app.get('/dashboard/:guildId/welcome/boost',      ..._welcomeRoute('welcome_boost'));
app.get('/dashboard/:guildId/welcome/assignment', ..._welcomeRoute('welcome_assignment'));

/* ── Welcome/Join Activity Logs ──────────────────────── */
app.get('/dashboard/:guildId/welcome/join/logs', require('./middleware/auth'), async (req, res) => {
    const db = require('../systems/schemas');
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const cfg = await db.WelcomeJoin.findOne({ guildId }, { activityLog: 1 }).lean();
        const logs = (cfg?.activityLog || []).slice().reverse().slice(0, 100);
        res.json({ logs });
    } catch (err) {
        logger.error('welcome/join/logs GET failed', { category: 'dashboard', error: err.message });
        res.status(500).json({ error: 'Failed to load logs' });
    }
});

/* ── Welcome/Join Dynamic Image config ──────────────── */
app.get('/dashboard/:guildId/welcome/join/image', require('./middleware/auth'), async (req, res) => {
    const db = require('../systems/schemas');
    const { getClient } = require('./utils/botClient');
    const botClient = getClient();
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    const inBot = botClient ? botClient.guilds.cache.has(guildId) : false;
    if (!inBot) return res.status(403).json({ error: 'Guild not found' });
    try {
        const config = await db.WelcomeImage.getConfig(guildId);
        res.json(config);
    } catch (err) {
        logger.error('welcome/join/image GET failed', { category: 'dashboard', error: err.message });
        res.status(500).json({ error: 'Failed to load' });
    }
});

app.post('/dashboard/:guildId/welcome/join/image/save', require('./middleware/auth'), async (req, res) => {
    const db = require('../systems/schemas');
    const { getClient } = require('./utils/botClient');
    const botClient = getClient();
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    const inBot = botClient ? botClient.guilds.cache.has(guildId) : false;
    if (!inBot) return res.status(403).json({ error: 'Guild not found' });
    try {
        const allowed = ['enabled','channelId','width','height','bgColor','layers','sendMode','linkedTemplateId','attachmentText','uploadedBgUrl'];
        const patch = {};
        for (const key of allowed) {
            if (key in req.body) patch[key] = req.body[key];
        }
        if (typeof patch.width  === 'number') patch.width  = Math.max(100, Math.min(2000, patch.width));
        if (typeof patch.height === 'number') patch.height = Math.max(100, Math.min(2000, patch.height));
        await db.WelcomeImage.patch(guildId, patch);
        res.json({ success: true });
    } catch (err) {
        logger.error('welcome/join/image/save POST failed', { category: 'dashboard', error: err.message });
        res.status(500).json({ error: 'Failed to save' });
    }
});

/* ── Image Proxy (bypasses CORS for external URLs in canvas editor) ── */
app.get('/dashboard/proxy-image', require('./middleware/auth'), (req, res) => {
    const raw = decodeURIComponent(req.query.url || '');
    if (!raw || !/^https?:\/\//i.test(raw)) return res.status(400).end('Bad URL');
    try {
        const mod = raw.startsWith('https') ? require('https') : require('http');
        const request = mod.get(raw, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DashboardProxy/1.0)' } }, (upstream) => {
            if (upstream.statusCode >= 400) { res.status(upstream.statusCode).end(); return; }
            const ct = upstream.headers['content-type'] || 'image/jpeg';
            if (!/^image\//i.test(ct)) { res.status(400).end('Not an image'); return; }
            res.set('Content-Type', ct);
            res.set('Cache-Control', 'public, max-age=3600');
            res.set('Access-Control-Allow-Origin', '*');
            upstream.pipe(res);
        });
        request.on('error', () => res.status(502).end('Upstream error'));
    } catch (_err) {
        res.status(500).end('Proxy error');
    }
});

/* ── Welcome/Join Background Image Upload ─────────────── */
const multerWiBg = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const dir = path.join(UPLOADS_ROOT, 'wi-bg', req.params.guildId);
            fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: (_req, _file, cb) => {
            const ext = _file.originalname.split('.').pop().replace(/[^a-z0-9]/gi, '') || 'jpg';
            cb(null, `bg_${Date.now()}.${ext}`);
        },
    }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        cb(null, /^image\/(jpeg|jpg|png|webp|gif)$/.test(file.mimetype));
    },
});
app.post('/dashboard/:guildId/welcome/join/image/upload-bg', require('./middleware/auth'), multerWiBg.single('file'), async (req, res) => {
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    if (!req.file) return res.status(400).json({ error: 'No valid image file provided (max 8 MB, jpg/png/webp)' });
    try {
        const relPath = `/uploads/wi-bg/${guildId}/${req.file.filename}`;
        // Persist the uploaded bg URL in the WelcomeImage document so it survives saves
        const db = require('../systems/schemas');
        await db.WelcomeImage.patch(guildId, { uploadedBgUrl: relPath });
        res.json({ success: true, url: relPath });
    } catch (err) {
        logger.error('welcome/join/image/upload-bg failed', { category: 'dashboard', guildId, error: err.message });
        res.status(500).json({ error: 'Upload failed' });
    }
});

/* ── Welcome image preview (renders PNG server-side) ── */
app.get('/dashboard/:guildId/welcome/join/image/preview', require('./middleware/auth'), async (req, res) => {
    const db = require('../systems/schemas');
    const { renderWelcomeImage } = require('../systems/welcome_image_renderer');
    const { getClient } = require('./utils/botClient');
    const botClient = getClient();
    const { guildId } = req.params;
    const raw = req.session.guilds || [];
    if (!raw.find(g => g.id === guildId)) return res.status(403).json({ error: 'Forbidden' });
    const inBot = botClient ? botClient.guilds.cache.has(guildId) : false;
    if (!inBot) return res.status(403).json({ error: 'Guild not found' });
    try {
        const config = await db.WelcomeImage.getConfig(guildId);
        const guild  = botClient ? botClient.guilds.cache.get(guildId) : null;
        const member = guild ? await guild.members.fetch(req.session.user.id).catch(() => null) : null;
        if (!guild || !member) return res.status(400).json({ error: 'Bot not in guild or member not found' });
        const buf = await renderWelcomeImage(config, { member, guild });
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'no-store');
        res.send(buf);
    } catch (err) {
        logger.error('welcome/join/image/preview failed', { category: 'dashboard', error: err.message });
        res.status(500).json({ error: 'Render failed' });
    }
});

/* ── 404 ─────────────────────────────────────────────── */
app.use((req, res) => {
    res.status(404).redirect('/');
});

/* ── Start (called from index.js or standalone) ─────── */
function start() {
    // Ensure MongoDB is connected. When launched via index.js the main bootstrap
    // calls dbSchemas.connect() shortly after — this is a no-op in that case.
    // When run standalone (`node dashboard/server.js`) this guarantees a connection
    // so all Mongoose queries (WelcomeJoin, embeds, etc.) persist to the database.
    const _dbSchemas = require('../systems/schemas');
    if (!_dbSchemas.isConnected()) {
        _dbSchemas.connect()
            .then(() => Promise.all([
                require('../utils/settings').loadFromMongoDB(),
                require('./utils/guildDb').loadFromMongoDB(),
            ]))
            .catch(err =>
                logger.error('Dashboard: MongoDB connect failed', { category: 'db', error: err.message })
            );
    }

    const publicURL = IS_PROD
        ? new URL(process.env.QAUTH_LINK).origin
        : `http://localhost:${PORT}`;
    httpServer.listen(PORT, () => {
        logger.discord(`Dashboard running at ${publicURL}  (port ${PORT})`, { category: 'dashboard' });
    });
}

// Allow standalone: node dashboard/server.js
if (require.main === module) start();

module.exports = { app, start, io, httpServer };


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */
