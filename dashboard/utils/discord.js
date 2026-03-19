/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const https = require('https');

const CLIENT_ID     = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI  = process.env.QAUTH_LINK || 'http://localhost:2000/auth/discord/redirect';

const SCOPES = ['identify', 'email', 'guilds'].join('%20');

/* ── Build OAuth redirect URL ────────────────────────── */
function getOAuthURL() {
    return `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${SCOPES}`;
}

/* ── Exchange code for token ─────────────────────────── */
async function exchangeCode(code) {
    const body = new URLSearchParams({
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  REDIRECT_URI,
    }).toString();

    return await discordPost('/api/oauth2/token', body);
}

/* ── Get user info ───────────────────────────────────── */
async function getUser(accessToken) {
    return await discordGet('/api/users/@me', accessToken);
}

/* ── Get user guilds ─────────────────────────────────── */
async function getUserGuilds(accessToken) {
    return await discordGet('/api/users/@me/guilds', accessToken);
}

/* ── Helpers ─────────────────────────────────────────── */
function discordPost(path, body) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'discord.com',
            path,
            method: 'POST',
            headers: {
                'Content-Type':   'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
            },
        };
        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function discordGet(path, token) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'discord.com',
            path,
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
        };
        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

module.exports = { getOAuthURL, exchangeCode, getUser, getUserGuilds };


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */