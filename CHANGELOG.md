# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [v5.7.1] — 2026-04-06 🔒 Security Patch

### Fixed — Security

#### 🛡️ XSS via Malicious File Upload (Stored XSS)
- **Welcome background image upload** (`/dashboard/:guildId/welcome/join/image/upload-bg`): file extension was previously derived from `originalname`, allowing an attacker to upload a file named `payload.html` with a valid image MIME type and have it served as an executable HTML page. Extension is now always derived from the verified MIME type.
- **Ticket panel banner upload**: same issue — `path.extname(file.originalname)` replaced with a MIME-to-extension mapping.
- **`/uploads` static serving**: added dedicated middleware with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'`, and forced `application/octet-stream` for any non-image file as defense-in-depth.

#### 🔐 IDOR — Cross-Guild Channel Injection
- **Embeds save endpoint** (`/dashboard/:guildId/embeds/api/save`): `channelId` from the request body was used directly to send Discord messages without verifying ownership. An attacker with access to Guild A could intercept the request, replace `channelId` with a channel from Guild B, and cause the bot to send messages there. Now validated against the bot client before any DB write or Discord send.
- **Ticket panel send endpoint** (`/dashboard/:guildId/tickets/panels/send`): `channelId` from the request body was persisted to the database and forwarded to the bot without guild ownership verification. Same validation added.

---

## [v5.7.0] — 2026-03-30 ✨ Components Flow Builder + Full Audit

### Added — Components Messages System (`/dashboard/:id/components`)

A complete interactive flow-builder for Discord Components v2 messages — fully production-ready.

#### 🏗️ Multi-State Flow Builder
- **States sidebar** — create, rename, reorder (drag), and color-code states in the left panel
- **Initial state indicator** — INIT badge marks the entry-point state; click any state’s dot to change color via native color picker
- **State transitions** — IF/THEN action pipeline with `go_to_state` action to transition users between states
- **Per-state snapshots** — each state carries its own content, components array, and actions map independently
- **Auto-draft** — dirty builder state auto-saved to `localStorage` every 30 s (restored on next open)

#### 🧩 Component Row Types
- **Button Row** — up to 5 buttons per row; per-button: label, style (Primary / Secondary / Success / Danger / Link), emoji, URL, customId, disabled toggle
- **Select Menu** — up to 25 options; per-option: label, value, description, emoji, default flag; placeholder text
- **Text Display** — free-text markdown block (up to 4 000 chars)
- **Separator** — divider line or spacing gap (Small / Large)
- **Container** — accent-border wrapper (up to 10 nested children); supports all row types recursively
- **Image** — URL + alt text with live inline preview
- Collapse / Expand + Duplicate per row
- SortableJS drag-to-reorder for both top-level rows and container children

#### ⚡ IF/THEN Interaction Logic Builder
- **Rule blocks** (IF / ELSE IF / ELSE) with drag-to-reorder support
- **18 action types**: `go_to_state`, `update_message`, `reply`, `send_dm`, `send_to_channel`, `send_webhook`, `edit_message`, `add_role`, `remove_role`, `toggle_role`, `open_ticket`, `close_ticket`, `disable_component`, `enable_component`, `create_thread`, `award_points`, `kick_member`, `timeout_member`
- **5 condition types**: `user_has_role`, `user_missing_role`, `channel_is`, `channel_is_not`, `selected_option`
- AND / OR operator toggle between conditions
- Old `steps[]` format auto-migrated to `rules[]` on open

#### 🚀 Smart Triggers
- **10 trigger types**: `slash_command`, `on_join`, `member_leave`, `role_add`, `role_remove`, `on_reaction`, `scheduled` (cron), `webhook`, `on_message` (regex), `on_channel_create`
- Per-trigger parameter forms (command name, emoji, cron expression, regex pattern, role/category selectors)
- **Webhook trigger** — auto-generated per-trigger secure token; one-click copy of full webhook URL
- Channel context hint in save modal: `all_provided` / `some_provided` / `none_provided` / `no_triggers`

#### 📡 Multi-Channel Send
- Channel pills UI — add/remove multiple target channels with live search
- All channels receive the message; primary channel’s `messageId` stored for edit mode

#### ⏰ Scheduled Send
- `datetime-local` picker; stored as ISO string; cleared with one click

#### 💬 Pre-Mention Pings
- Separate ping message sent before the component message
- Supports roles, `@everyone`, `@here`; inline vs separate-message mode toggle

#### 👁️ Live Preview
- Discord mock shell renders content + all component rows in real time
- **State preview tabs** — when multiple states exist, pin preview to any state without switching editor
- Full Discord Markdown renderer (`**bold**`, `_italic_`, `__underline__`, `~~strike~~`, `||spoiler||`, `` `code` ``, `
` → `<br>`)

#### 💾 Save & Send Modal
- Name + primary channel override fields
- `Edit` vs `New` send-mode radio (pre-selects Edit when updating an existing message)
- Context-aware title and description based on new vs existing document
- Ctrl+S shortcut saves from anywhere in the builder

#### 📄 Send Log
- Every Discord send appended to `sentLog[]` (channelId, messageId, sentAt)
- Log modal shows full history with timestamps

#### 🔗 Slash Quick-Add Bar
- Type `/text`, `/btn`, `/sel`, `/sep`, `/img`, `/cnt` + Enter to add rows without touching the mouse
- Keyboard navigable (Arrow keys + Enter + Escape)

#### 😀 Emoji Picker
- Standard emoji grid (6 category groups) + server custom emoji tab
- Fuzzy search; inserts at cursor position in the content textarea

#### 🎬 Webhook Endpoint
- `POST /api/webhook/components/:guildId/:triggerId?token=xxx` — public trigger endpoint secured by per-trigger token (min 8 chars)

### Fixed
- **`duplicateAutomation()` double event-listener attachment** — after calling `renderList()` (which attaches listeners internally), the function re-attached `_edit` / `_del` to every card again, causing handlers to fire N+1 times after N duplications. Removed the redundant attachment lines.
- **`getAllCustomIds()` missing container children** — buttons and select menus nested inside Container rows were invisible to the Actions panel — no IF/THEN logic could be assigned to them. Fixed with recursive `collectFromRow()` helper.
- **`_validateBeforeSave()` skipping container contents** — Link buttons with no URL and duplicate `customId` values inside containers bypassed pre-save validation, causing Discord API errors at send time. Fixed with recursive `checkRows()` helper.

### Changed
- Version bumped from `5.4.0-beta` to **`5.7.0`** — first stable non-beta release
- Removed `Beta` label from all UI surfaces (`intro.ejs`, `login.ejs`), `package.json`, `Dockerfile`, `README.md`
- `ComponentMessage` schema: `strict: false` on `StateSchema` and `ActionPipelineSchema` to accommodate future step properties without migration

---

## [v5.4.0 Beta] — 2026-03-25 ✨ Embeds Flow Builder System

### Added — Embed Message Builder (`/dashboard/:id/embeds`)

A complete visual flow-builder for creating and sending rich Discord messages with interactive XState-powered automation.

#### 🏗️ Flow Builder
- **Visual state-flow canvas** — drag-and-drop XState-compatible flow builder with pan/zoom, zoom-lock, and auto-layout (BFS grid)
- **State cards** — each state holds independent embed content, components (buttons / select menus), transitions, and permissions
- **Drag-to-connect** — draw transitions between states by dragging port handles
- **Auto-layout** — one-click BFS grid placement for all states
- **Initial state** — mark any state as the entry point (rendered with a crown indicator)
- **State count badge** — live counter in the canvas toolbar

#### 💬 Embed & Component Editor (Inspector)
- **Embeds panel** — full Discord embed editor per state: title, description, color picker, URL, author, footer, thumbnail, image, timestamp, and fields (inline support)
- **Components panel** — build Button rows and Select Menu rows; per-component `customId`, label, style, emoji, URL, disabled toggle; select options with value, description, emoji, default flag
- **Transitions panel** — pipeline step builder with all action types: `update_content`, `replace_embeds`, `append_embeds`, `update_components`, `disable_component`, `enable_component`, `hide_component`, `send_ephemeral`, `send_to_channel`, `delay`
- **Permissions panel** — per-state role whitelist, cooldown (seconds), and deny-message configuration
- **Live preview** — Discord-style message preview pane updated in real time

#### 🤖 Flow Execution Engine (`systems/emped.js`)
- XState-compatible execution engine — processes button clicks and select-menu interactions against the saved machine definition
- **Multi-User mode** — optional per-user state isolation (each user has their own flow position keyed by `msgId:userId`)
- **EP Theme mode** — all component interactions share one shared embed state across all users
- **Permission enforcement** — role-based access check before executing any transition
- **Cooldown system** — per-state per-user cooldown tracking with `_cooldownMap`
- **All action types** implemented: content updates, embed replace/append, component mutations (disable/enable/hide), ephemeral replies, channel messages, delays
- **Smart triggers** — fire machine transitions automatically on external events:
  - `cron` — time-based, configurable schedule (runs every 60 s tick)
  - `member_join` / `member_leave` — guild member events
  - `role_add` / `role_remove` — role change events
  - `message_create` — message pattern matching

#### 💾 Save & Send
- **Save & Send modal** — context-aware title ("Save Changes" vs "New Message") and button text ("Save & Update" vs "Save & Send")
- **Edit vs New mode** — choose to edit the existing live Discord message in-place or send a brand-new one
- **`embedBuilder.js` utility** — converts stored embed/component JSON to Discord.js `EmbedBuilder` / `ActionRowBuilder` payloads; skips empty embeds, handles emoji safely

#### 🕐 Version History
- **Version snapshots** — every save auto-creates a snapshot; manual snapshots with custom labels
- **Rollback** — revert the live flow to any previous snapshot; current state is auto-saved before rollback
- **Snapshot pruning** — auto-saves are capped at 10 per document (oldest pruned automatically)
- **Version count badge** on the History toolbar button

#### 🗑️ Trash / Recycle Bin
- **Soft delete** — deleted flows move to trash with a 30-day TTL (MongoDB TTL index auto-expires)
- **Restore** — restore any trashed flow back to the active list, including full `componentIds` rebuild
- **Permanent delete** — force-remove a trashed flow immediately

#### 📋 Templates
- **Save as Template** — save the current flow machine as a named, reusable template
- **Apply Template** — apply any saved template to the current flow or create a new flow from it
- **Import JSON** — import a machine definition from a `.json` file
- **Templates drawer** — slideout panel listing all guild templates with apply/delete actions

#### 🎛️ Triggers Modal
- Full CRUD UI for smart triggers — add, remove, and configure type + target state per trigger
- Trigger types: `cron`, `member_join`, `member_leave`, `role_add`, `role_remove`, `message_create`
- Changes saved independently from the flow via the Triggers save button

#### 🔧 UX Improvements & Bug Fixes
- **Keyboard shortcuts** — `Ctrl+S` / `Cmd+S` saves the flow from anywhere in the builder; `Escape` closes any open modal
- **Overlay click to close** — all modals (save, triggers, versions, trash, template save) close when clicking the backdrop
- **"Add First State" button** — canvas empty state now has a direct action button, no need to find the toolbar
- **EP Theme label** — renamed from cryptic `epTheme` to "EP Theme" with a tooltip explaining its purpose
- **machine mutation guard** — save handler clones the machine before writing `multiUser`; the shared in-memory machine object is never mutated
- **Triggers save sync** — saving triggers now updates `currentDoc` and `savedMessages` in place so the list reflects changes without a page reload

### Added — New Schemas
- `systems/schemas/EmbedMessage.js` — full embed message schema (embeds, components, machine, epTheme, multiUser, instanceStates, componentIds, messageId, channelId)
- `systems/schemas/EmbedVersion.js` — version snapshot schema with TTL-pruning of auto-saves
- `systems/schemas/EmbedTrash.js` — recycle bin schema with 30-day MongoDB TTL index
- `systems/schemas/EmbedTemplate.js` — guild-scoped template storage schema

---

## [v5.3.4 Beta] — 2026-03-22 🐛 Bug Fixes

### Fixed
- **Slash command visibility for non-admin users** — Changed `setDefaultMemberPermissions(PermissionFlagsBits.X)` to `setDefaultMemberPermissions(0)` on 44 commands so that Discord shows them to users who are granted access via the moderation dashboard (allowedRoles / allowedUsers), not just server Administrators
- **Double AFK notification on reply** — When replying to an AFK user Discord auto-includes that user in `message.mentions`, causing both the reply-reference block and the mentions loop to fire. Fixed by tracking `afkNotifiedId` and skipping the same user in the mentions loop
- **`/say` sends message twice** — The `buildCard` success reply used `flags: CV2` which Discord.js doesn't merge with `ephemeral: true`, making it a visible channel message in addition to the actual sent message. Replaced the confirmation card with a minimal ephemeral `✅` reply
- **Levels dashboard selections not saving on mobile** — After `document.body.appendChild(dd)` (portal pattern), `makeCPicker()` still queried options using `wrap.querySelectorAll()`, finding nothing after the detach; `syncHidden()` then cleared the hidden `<select>`. Fixed by changing all four query sites to `dd.querySelectorAll()` / `dd.querySelector()`
- **Levels save bar disappears before showing success** — `markClean()` was called immediately after setting the "✓ Saved!" label, hiding the save bar instantly. Moved it inside the `setTimeout` so the bar stays visible for 2 seconds
- **`come.js` ThumbnailBuilder crash** — `ThumbnailBuilder.setMedia({ url })` does not exist in discord.js 14.25.1; replaced with the correct `setURL(url)` method

---

## [v5.3.3 Beta] — 2026-03-21 🔧 Credits & Branding Update

### Changed
- Updated all project credits to **Next Generation team** throughout the entire codebase
- Fixed all Discord invite links to `https://discord.gg/BhJStSa89s`
- Replaced Ko-Fi / PayPal donation links with GitHub repository link
- Removed outdated Live Demo badge and section (codnex.xyz)
- Updated community links in dashboard (guild.ejs, promo_card.ejs) — removed Trustpilot/Ko-fi references
- Updated clone URL in CONTRIBUTING.md to `https://github.com/aymenelouadi/next-generation.git`
- Version bumped to **5.3.3 Beta** across package.json, Dockerfile, and dashboard views

### Added — `migrate.js` (JSON → MongoDB migration)
- New migration script that reads all flat-file JSON databases and upserts them into MongoDB
- Covers: AFK, Warnings, Jails, Mutes, TempRoles, AutoRoles, AutoResponder, Suggestions, per-guild settings/protection/tickets/levels/staff scores/interaction scores/ticket feedback
- **Idempotent** — uses `findOneAndUpdate` + `upsert: true`; safe to run multiple times without duplicating records
- **Dry-run mode** — pass `--dry-run` to preview all operations without writing to MongoDB
- **Stable legacy IDs** — records missing a `caseId` receive a deterministic `LEGACY_<userId>_<index>` ID so re-runs always produce the same document (no duplicates)
- **Expired records skipped** — active Jails, Mutes, and TempRoles past `expiresAt` are not migrated
- **Absolute paths** — all file reads use `path.join(__dirname, ...)` so the script works correctly regardless of working directory
- **Missing-directory guard** — gracefully skips `dashboard/database/` if the folder does not exist

---

## [v5.1.1] — 2026-03-17 ✨ New Systems & Improvements

### ✨ New Systems

#### 🤖 Auto Responder
- Rule-based auto-reply system — configure trigger keywords and bot responses per guild
- Match modes: exact, contains, starts-with, and regex
- Full dashboard admin page (`/dashboard/:id/auto-responder`)

#### 💡 Suggestions System
- Members can submit suggestions to a dedicated channel
- Dashboard controls: approve, reject, and manage suggestion entries
- Full dashboard admin page (`/dashboard/:id/suggestions`)

#### ⭐ Staff Points
- Reward staff members with points for activity and contributions
- Leaderboard view and per-member history
- Full dashboard admin page (`/dashboard/:id/staff-points`)

#### 🎟️ Ticket Points
- Award points to staff for handling and closing tickets
- Integrates with the existing ticket system
- Full dashboard admin page (`/dashboard/:id/ticket-points`)

#### 💬 Interaction Points
- Track and reward member engagement (messages, reactions, voice time)
- Per-guild leaderboard with configurable role reward thresholds
- Full dashboard admin page (`/dashboard/:id/interaction-points`)

### 📊 Activity Tracking
- New `activityTracker` utility records hourly guild stats to `dashboard/database/<guildId>/activity.json`
- Tracked metrics: member joins, member leaves, messages sent, voice channel joins
- New API endpoint: `GET /dashboard/:guildId/stats/activity`

### 🌐 Dashboard Improvements
- **Guild overview** — 4 ApexCharts sparkline cards (Joins / Leaves / Messages / Voice) fed by the activity tracker
- **Module Status** expanded from 4 to 8 cards: Protection, Tickets, Auto Roles, Levels, Auto Responder, Suggestions, Staff Points, Interaction Points
- **Quick Actions** expanded with 4 new buttons linking to the new system pages

### 🌍 Multi-Language Expansion
- Added 9 new language packs: French (`fr`), German (`de`), Spanish (`es`), Russian (`ru`), Portuguese (`pt`), Hindi (`hi`), Bengali (`bn`), Urdu (`ur`), Chinese (`zh`)
- Total supported languages: **11** (en, ar, fr, de, es, ru, pt, hi, bn, ur, zh)

### 🎨 Intro Screen v2
- Redesigned intro screen with loading bar animation, fact card, and version badge
- Title: `System Pro — v5.1.1`, badge: `VERSION 5.1.1 · STABLE`

---

## [v5.0.0] — 2026-03-08 🚀 Initial Public Release

### ✨ Features

#### 🤖 Discord Bot
- **Dual command support** — both slash commands (`/`) and prefix text commands (`!`) out of the box
- **Multi-language system** — English and Arabic UI via a configurable `lang` setting per guild
- **Activity & status** — configurable bot activity type and presence status from `settings.json`

#### 🛡️ Protection System
- **Anti-Ban** — detects and reverses mass-ban events; punishes the responsible member
- **Anti-Kick** — detects and reverses mass-kick events with configurable action
- **Anti-Bots** — blocks automatic bot additions to the guild
- **Anti-Webhooks** — prevents mass webhook creation
- **Anti-Channel Create / Delete** — protects channel structure from rapid create/delete
- **Anti-Role Add / Delete** — protects role structure from mass mutations
- **Whitelist system** — trusted users/roles exempt from all protection triggers
- **Jail system** — isolates members into a locked room with configurable jail role and channel
- **Mute system** — temporary mute with automatic role restore via database-backed scheduler

#### 📋 Moderation Commands
- `ban` / `unban` / `unban_all` — ban management with reason logging
- `kick` — kick with log
- `mute` / `unmute` — mute with duration support
- `warn` / `unwarn` / `warning` — full warning system with per-user history
- `jail` / `unjail` — jail isolation
- `clear` — bulk message deletion (1–100 messages)
- `lock` / `unlock` — channel lockdown
- `slowmode` — set channel slowmode delay
- `rename` — rename channels or members
- `say` — send a message as the bot

#### 👥 Role Management
- `add_role` / `remove_role` — add or remove a single role from a member
- `multipe_role` — apply a role to all members matching a filter
- `temp_role` — assign a role for a defined duration; auto-removed on expiry
- `auto_role` — automatically assign roles to new human members, bots, or via invite link
- `roles` — list all roles in the server  
- `set_perm` / `set_perm_all` / `set_perm_reset` — fine-grained command permission control per role

#### 🎟️ Ticket System
- Multi-panel ticket support with configurable category, role, and emoji per panel
- Ticket transcript generation (HTML export)
- Ticket feedback collection on close
- Ticket statistics tracking
- Ticket log channel support
- Post-close actions (archive, delete, notify)

#### 📊 Utility & Info
- `server` — server information embed
- `user` — user profile (avatar, join date, roles, badges)
- `avatar` / `banner_user` / `banner_server` / `logo_server` — media fetch commands
- `ping` — bot latency and API ping
- `afk` — set AFK status with custom message; auto-cleared on next message
- `come` — summon the bot to your voice channel
- `help` — dynamic help command listing all enabled commands

#### ⚖️ Court / Complaint System
- `court_set_name` / `court_set_color` / `court_set_logo` / `court_set_log` — configure the court module
- Embedded complaint management with status tracking

#### 🔔 Logging System
- Comprehensive action log channel — tracks bans, kicks, mutes, role changes, command usage, and more
- Per-guild log channel configurable via `settings.json` or dashboard

#### 🌐 Web Dashboard
- Express + EJS dashboard served separately from the bot process
- Discord OAuth2 login
- Guild selector with permission check
- **Pages:**
  - Home / Server overview
  - Auto Roles — manage human, bot, and invite-based auto-assign rules
  - Moderation — review warnings, bans, and mod log
  - Protection — configure all anti-* modules with live toggle
  - Ticket System — manage panels, categories, and settings
  - Levels — XP and level tracking configuration
  - System Settings — prefix, language, activity, whitelist
  - Utility settings
  - Verify system

#### ⚙️ Configuration
- `settings.json` — single-file guild configuration for all modules
- `database/` — flat JSON file database for persistent state (warnings, mutes, jails, temp roles, afk, auto roles, tickets)
- `.env` — environment secrets (token, client secret, session key)

### 🏗️ Technical Stack

| Layer | Technology |
|-------|-----------|
| Bot runtime | Node.js ≥ 20, discord.js v14 |
| Dashboard | Express 5, EJS 4, Socket.IO |
| Auth | Discord OAuth2 |
| Database | Flat-file JSON (fs-extra) |
| UI components | Lucide icons, ApexCharts, Three.js |
| Container | Docker (Node 20 Alpine) |

---

### 🛠️ Post-Release Updates — 2026-03-15

#### 🔒 Security Hardening (`dashboard/server.js`, `dashboard/routes/auth.js`)
- Added `helmet` middleware (CSP & COEP disabled for dashboard compatibility)
- Added `express-rate-limit` with IPv6-safe `ipKeyGenerator` — fixes `ValidationError` on IPv6 addresses
- Fixed Socket.io CORS — origin now computed from `QAUTH_LINK` in production instead of wildcard `*`
- Added startup warning when `SESSION` environment variable is missing
- Fixed path traversal vulnerability on guild delete endpoint — `guildId` now validated against `/^\d{17,20}$/` before any `fs.rmSync` call
- Removed `accessToken` from session storage — token is not used post-login and should never be persisted
- Added `requestIp` middleware for accurate client IP logging behind reverse proxies

#### 🎟️ Ticket System — Improvements

**Transcript library replaced** (`systems/ticket_transcript.js`)
- Swapped `discord-html-transcripts` → `discord-transcript-v2`
- Updated import: `const { createTranscript, ExportReturnType } = require('discord-transcript-v2')`
- Updated `returnType` value: `ExportReturnType.Buffer` (typed enum instead of string literal)

**Multi-panel: title & description fields** (`dashboard/views/tickets_panels.ejs`, `systems/tickets.js`)
- Added `#mp-title` (text input, max 256 chars) and `#mp-description` (textarea) to the multi-panel configuration card
- `loadMpData()` now populates both new fields from saved data
- Save payload includes `panelTitle` and `description`
- `_buildMultiPanelPayload()` renders title + description as `TextDisplay` components above the separator line

**Fix: Multi-panel stale data on selector change** (`dashboard/views/tickets_panels.ejs`)
- `loadMpData(null)` previously only cleared `mpPanels`; it now fully resets every MP field (channel, toggles, title, description, banner, accent color, visibility rows)
- Added `_collectMpState(id)` helper — snapshots all current MP form values into an object
- `_mpList` is now fully synced on save: new entries use `_collectMpState`, existing entries use `Object.assign` — previously only `{ id }` was stored, causing data loss on switch-away / switch-back
- `renderMpPanels()` now always calls `_buildMpPanelSelList()` — previously the panel picker was only rebuilt on remove (×) click, causing "already used" filter to desync on load

**Fix: Single-panel stale data on selector change** (`dashboard/views/tickets_panels.ejs`)
- `resetPanelForm()` previously only cleared `panel-id` and the selector; now resets all 40+ fields (every checkbox, select, text input, banner, accent color, button color, display mode, ACL rows, support roles, form questions, hours grid, action buttons)
- Added `_collectPanelState(id)` helper — mirrors `_collectMpState` for single panels
- Save handler now uses `_collectPanelState` for both new panel (`_panelList.push`) and existing panel (`Object.assign`) — previously only `panelTitle`, `btnText`, `btnEmoji` were updated
- Panel selector choice is now persisted in `sessionStorage` per guild — refreshing the page restores the last active panel; selecting "new panel" (`''`) is also remembered so a refresh keeps the blank form instead of jumping back to the last saved panel

#### 🐛 Bug Fixes

**Fix: `DiscordAPIError[10062]: Unknown interaction` — Uncaught exception** (`systems/ticket_after.js`)
- All `return handler()` calls inside `registerAfterHandlers` were missing `await` — in JavaScript, `return asyncFn()` without `await` inside a `try/catch` does not let the catch block intercept rejections, so every error from ticket handlers escaped as an uncaught exception. Fixed by changing all to `return await handler()`
- All `showModal` calls (`closeTicket`, `handleAddUserButton`, `handleRemoveUserButton`, `_showFormModal`) wrapped in `try/catch` — error code `10062` (interaction token expired, 3-second Discord window) is now caught and silently ignored; user can simply click the button again
- `_showFormModal` converted from regular function to `async function` to support `await interaction.showModal()`
- Global catch block in `registerAfterHandlers` now early-returns on `err.code === 10062` instead of attempting `interaction.reply()` (which would also fail since the token is expired)
- `handleActionSelect` inner dispatches also changed to `return await handler()` for consistent propagation

---

> This project was programmed by the Next Generation team.  
> Discord: https://discord.gg/BhJStSa89s
