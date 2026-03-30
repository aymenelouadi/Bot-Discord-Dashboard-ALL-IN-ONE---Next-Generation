# Security Policy

## Supported Versions

Only the latest stable release receives security updates.

| Version | Supported          |
|---------|--------------------|
| 5.7.0   | ✅ Active support  |
| < 5.7.0 | ❌ End of life     |

---

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Please report security issues privately through one of the following channels:

| Channel | Contact |
|---------|---------|
| Discord | [discord.gg/BhJStSa89s](https://discord.gg/BhJStSa89s) — open a private ticket |
| GitHub  | [Security Advisories](https://github.com/aymenelouadi/next-generation/security/advisories/new) |

We aim to respond within **48 hours** and issue a patch within **7 days** for confirmed vulnerabilities.

---

## Security Considerations for Self-Hosting

### Environment Variables
- **Never commit `.env`** — all secrets (bot token, OAuth secret, session key) must stay in `.env` only
- Change the default `CODE` access code in `settings.json` from `"ADMIN"` to a strong, unique value
- Use a minimum 32-character random string for the `SESSION` variable

### Discord Bot Token
- Rotate your token immediately if it is accidentally exposed
- Restrict bot permissions to only what is required (avoid `Administrator` unless necessary)

### Dashboard
- The dashboard runs on port `2000` by default — do **not** expose this port publicly without a reverse proxy + HTTPS
- Use nginx or Caddy with HTTPS in production
- The `CODE` login gate is a secondary control — always pair it with a strong session secret

### MongoDB
- Use a dedicated database user with least-privilege access (read/write on one database only)
- Enable MongoDB Atlas IP allowlist; never use `0.0.0.0/0` in production
- The `MONGODB` connection string contains credentials — keep it in `.env`

### Webhook Endpoints
- Component webhook endpoints (`/api/webhook/components/:guildId/:triggerId`) are public but secured by a per-trigger token (minimum 8 characters, auto-generated as 32 hex chars)
- Rotate webhook tokens by deleting and recreating the trigger in the dashboard

### File System
- The `database/` and `dashboard/database/` directories may contain guild-specific data — they are gitignored by default
- Do not expose the project root via a static file server

---

## OWASP Top 10 Mitigations in Place

| Risk | Mitigation |
|------|-----------|
| Broken Access Control | Per-route `require('./middleware/auth')` session guard; guild membership verified on every API call |
| Injection (XSS) | All user-supplied values escaped with `esc()` before insertion into HTML; EJS auto-escapes by default |
| Injection (MongoDB) | Mongoose schemas with typed fields; `findOne({ _id: id, guildId })` pattern prevents cross-guild data access |
| Security Misconfiguration | `.env` excluded from git; `database/` and `dashboard/database/` gitignored |
| Cryptographic Failures | Session secret enforced via environment variable; webhook tokens generated with `crypto.getRandomValues` |
| Insecure Design | No `sudo`/`Administrator` bot permissions required; role-based permission checks per dashboard action |
| SSRF | Webhook URLs in action steps are user-supplied; validate/restrict in production if needed |
| Logging | All moderation actions logged; bot errors logged to `logs/` (gitignored) |

---

## Acknowledgements

We thank everyone who responsibly discloses security issues to help keep the community safe.
