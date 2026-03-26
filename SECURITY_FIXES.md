# Security Fixes & Bug Report
**Date:** 2026-03-26  
**Branch:** `security/hardening-and-fixes`  
**Severity Levels:** 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low

---

## 🔴 Fix #1 — Path Traversal → File Disclosure
**File:** `systems/tickets.js`  
**Function:** `_resolveBanner()`  
**OWASP:** A01 – Broken Access Control

### What Was the Problem?
When a user saved a ticket panel with a banner image, the path was built using `path.join()` without validation:
```js
// VULNERABLE — before fix
const filePath = path.join(__dirname, '../dashboard/public', bannerImage);
```
An attacker could set `bannerImage = /uploads/../../../../.env` and the server would:
1. Resolve the path to `/container/.env`
2. Read the file contents (TOKEN, SESSION secret, DATABASE_URL, CLIENT_SECRET)
3. Send it as a file attachment directly to Discord

### Fix Applied
```js
// SECURE — after fix
const _UPLOADS_ROOT = path.resolve(__dirname, '../dashboard/public/uploads');
const filePath = path.resolve(__dirname, '../dashboard/public', bannerImage.slice(1));
if (!filePath.startsWith(_UPLOADS_ROOT + path.sep)) return null; // blocks escape
```
- Uses `path.resolve()` (resolves `..` sequences) instead of `path.join()`
- Validates that the resolved path stays inside `/uploads/` directory
- Removed `http://` URL acceptance (only `https://` allowed now)

---

## 🟠 Fix #2 — SSRF (Server-Side Request Forgery)
**File:** `dashboard/utils/dashboardLogs.js`  
**Function:** `_sendWebhook()`  
**OWASP:** A10 – Server-Side Request Forgery

### What Was the Problem?
The webhook URL was accepted from user input and used directly to make HTTP requests:
```js
// VULNERABLE — before fix
const lib = url.protocol === 'https:' ? https : http;
const req = lib.request({ hostname: url.hostname, ... });
```
A SHIPS-level user could set `WEBHOOK_LOG.URL` to internal addresses:
- `http://127.0.0.1:27017` → probe MongoDB
- `http://169.254.169.254/latest/meta-data/` → AWS instance metadata (cloud token theft)
- `http://localhost:3000` → any internal service

### Fix Applied
```js
// SECURE — after fix
function _isDiscordWebhook(rawUrl) {
    const u = new URL(rawUrl);
    return u.protocol === 'https:' &&
        (u.hostname === 'discord.com' || u.hostname === 'discordapp.com') &&
        u.pathname.startsWith('/api/webhooks/');
}
// Called before making any request:
if (!_isDiscordWebhook(wh.URL)) return;
```
- Only Discord webhook URLs are allowed
- Protocol must be `https:` — no `http://` to private networks
- Removed the `http` module import entirely (no longer needed)

---

## 🟡 Fix #3 — OAuth CSRF (Missing State Parameter)
**File:** `dashboard/routes/auth.js` + `dashboard/utils/discord.js`  
**OWASP:** A05 – Security Misconfiguration

### What Was the Problem?
The Discord OAuth flow had no `state` parameter — a classic OAuth CSRF vector:
```js
// VULNERABLE — before fix
router.get('/discord', (req, res) => {
    const url = discord.getOAuthURL(); // no state
    res.redirect(url);
});
router.get('/discord/redirect', async (req, res) => {
    const { code, error } = req.query; // no state check
```
An attacker could craft a URL that forces the victim's browser to complete an OAuth flow using the attacker's `code`, potentially linking the attacker's Discord account to the victim's session.

### Fix Applied
```js
// SECURE — after fix
router.get('/discord', (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    req.session.save(() => res.redirect(discord.getOAuthURL(state)));
});

router.get('/discord/redirect', async (req, res) => {
    const { code, error, state } = req.query;
    if (!state || state !== req.session?.oauthState) {
        return res.redirect('/?error=invalid_state'); // CSRF blocked
    }
    delete req.session.oauthState;
    // ... rest of flow
```
- Generates a cryptographically random 16-byte state token per login attempt
- Stores it in the session and verifies it on callback
- Rejects any callback where `state` doesn't match

---

## 🟡 Fix #4 — Session Cookie CSRF (sameSite: none)
**File:** `dashboard/server.js`  
**OWASP:** A05 – Security Misconfiguration

### What Was the Problem?
```js
// VULNERABLE — before fix
cookie: {
    sameSite: IS_PROD ? 'none' : 'lax',
```
`sameSite: 'none'` means cookies are sent on all cross-origin requests. Any malicious website could make authenticated requests to the dashboard:
```html
<!-- On attacker's site — sends with valid session cookie -->
<script>
fetch('https://yourdashboard.com/settings/ships', {
    method: 'POST',
    credentials: 'include',
    body: JSON.stringify({ userId: 'attacker_id' })
});
</script>
```

### Fix Applied
```js
// SECURE — after fix
cookie: {
    sameSite: IS_PROD ? 'strict' : 'lax',
```
`sameSite: 'strict'` ensures cookies are only sent from requests originating from the same site.

> **Note:** If your dashboard is embedded in an iframe from a different domain, change to `'lax'` instead of `'strict'`.

---

## 🐛 Bug Fix #5 — Ticket Panel "No channel set" Error
**Files:** `dashboard/views/tickets_panels.ejs` + `dashboard/server.js`  
**Type:** Functional Bug

### What Was the Problem?
When clicking "Send Panel", the frontend sent `channelId` in the request body, but the server route only destructured `{ panelId, messageId, forceNew }` — ignoring `channelId`. If the panel hadn't been explicitly saved after selecting a channel, the send always failed with:
```
Error: No channel set for this panel. Choose a channel first.
```

### Fix Applied
- Server now reads `channelId` from request and persists it before calling `sendPanel()`
- Frontend `panel-send-btn` now includes `channelId` in all send requests
- `mp-resend-btn` now includes `mpPanels` to prevent "Multi-panel has no panels" error

---

## 🐛 Bug Fix #6 — Moderation Page Settings Not Persisting
**File:** `dashboard/views/moderation.ejs`  
**Type:** Data Persistence Bug

### What Was the Problem?
4 multi-select dropdowns and 2 checkboxes were never pre-populated from server data on page load:
- `ignoredChannels`, `ignoredRoles`, `enabledChannels`, `allowedRoles` → always appeared empty
- `autoDeleteAuthor`, `autoDeleteReply` → always appeared unchecked

Every refresh showed empty values. If users saved after a refresh, it overwrote the database with empty arrays.

### Fix Applied
All 6 fields now render server-side EJS chips and `selected` class from the saved `cmd` data, matching the pattern already used for `addRole` and `showRoom`.

---

## Summary Table

| # | Severity | Type | File | Fixed |
|---|----------|------|------|-------|
| 1 | 🔴 Critical | Path Traversal | `systems/tickets.js` | ✅ |
| 2 | 🟠 High | SSRF | `dashboard/utils/dashboardLogs.js` | ✅ |
| 3 | 🟡 Medium | OAuth CSRF | `dashboard/routes/auth.js` | ✅ |
| 4 | 🟡 Medium | Session CSRF | `dashboard/server.js` | ✅ |
| 5 | 🟡 Medium | Bug | `tickets_panels.ejs` + `server.js` | ✅ |
| 6 | 🟡 Medium | Bug | `moderation.ejs` | ✅ |

---

## Remaining Recommendations (Not Yet Fixed)

| Priority | Recommendation |
|----------|----------------|
| 🟡 Medium | Add a global rate limiter for all `POST /dashboard/*` API routes |
| 🟡 Medium | Ensure `SESSION=<random>` is set in `.env` in production (current fallback is a hardcoded string) |
| 🟢 Low | Add `Content-Security-Policy` headers per-page instead of disabling via helmet config |
