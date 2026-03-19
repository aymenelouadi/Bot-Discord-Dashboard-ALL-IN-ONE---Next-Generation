/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const express      = require('express');
const router       = express.Router();
const discord      = require('../utils/discord');
const settingsUtil = require('../../utils/settings');
const dashLogs     = require('../utils/dashboardLogs');

/* ── GET /auth/discord ─────────────────────────────── */
router.get('/discord', (req, res) => {
    const url = discord.getOAuthURL();
    res.redirect(url);
});

/* ── GET /auth/discord/redirect ────────────────────── */
router.get('/discord/redirect', async (req, res) => {
    const { code, error } = req.query;

    if (error || !code) {
        return res.redirect('/?error=access_denied');
    }

    try {
        const tokenData = await discord.exchangeCode(code);
        const userInfo  = await discord.getUser(tokenData.access_token);

        // Check if user is in the guild (optional strict guard)
        // Check DASHBOARD access
        const settings  = settingsUtil.get();
        const dashboard = settings?.DASHBOARD || {};

        if (!dashboard.ENABLED) {
            return res.redirect('/?error=access_denied');
        }

        const anyware = dashboard.ANYWARE === true;
        if (!anyware) {
            const owners = dashboard.OWNERS || [];
            const ships  = dashboard.SHIPS  || [];
            const allowed = owners.includes(userInfo.id) || ships.includes(userInfo.id);
            if (!allowed) {
                return res.redirect('/?error=access_denied');
            }
        }

        req.session.user = {
            id:              userInfo.id,
            username:        userInfo.username,
            displayName:     userInfo.global_name || userInfo.username,
            discriminator:   userInfo.discriminator,
            avatar:          userInfo.avatar,
            banner:          userInfo.banner || null,
            bannerColor:     userInfo.banner_color || null,
            publicFlags:     Number(userInfo.public_flags || userInfo.flags || 0),
            premiumType:     Number(userInfo.premium_type || 0),
            email:           userInfo.email,
            ip:              req.clientIp || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown',
            loginAt:         new Date().toISOString(),
            verified:        dashboard.CODE_ACCESS === false ? true : false,
        };

        // Fetch guilds and store admin/managed ones in session
        try {
            const allGuilds = await discord.getUserGuilds(tokenData.access_token);
            const MANAGE    = 0x20; // MANAGE_GUILD permission bit
            req.session.guilds = allGuilds
                .filter(g => g.owner || (BigInt(g.permissions) & BigInt(MANAGE)) !== 0n)
                .map(g => ({
                    id:   g.id,
                    name: g.name,
                    icon: g.icon,
                }));
        } catch { req.session.guilds = []; }

        const redirectTo = dashboard.CODE_ACCESS === false ? '/dashboard' : '/verify';
        req.session.save(() => {
            // Log the login event
            try {
                dashLogs.addEntry({
                    type:        'login',
                    userId:      userInfo.id,
                    username:    userInfo.username,
                    displayName: userInfo.global_name || userInfo.username,
                    avatar:      userInfo.avatar,
                    ip:          req.clientIp || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown',
                });
            } catch (_) {}
            res.redirect(redirectTo);
        });
    } catch (err) {
        console.error('[Auth] OAuth error:', err.message);
        res.redirect('/?error=oauth_failed');
    }
});

/* ── GET /auth/logout ───────────────────────────────── */
router.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

module.exports = router;


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */