/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

/**
 * Auth Middleware — protects dashboard routes.
 * Redirects to login if no valid session exists.
 */
const settingsUtil = require('../../utils/settings');

module.exports = function requireAuth(req, res, next) {
    if (req.session?.user?.verified) return next();
    if (req.session?.user && !req.session.user.verified) {
        const cfg = settingsUtil.get();
        if (cfg?.DASHBOARD?.CODE_ACCESS === false) {
            req.session.user.verified = true;
            return req.session.save(() => next());
        }
        return res.redirect('/verify');
    }
    return res.redirect('/?error=unauthorized');
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */