/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

/**
 * systems/ticket_transcript.js
 * Generates an HTML transcript using discord-transcript-v2 (supports CV2 +
 * embeds), saves it to disk, posts it to the configured transcript channel,
 * and optionally DMs it to the ticket creator.
 *
 * Only runs when panel.transcriptEnabled === true.
 *
 * Usage:
 *   const { generateTranscript } = require('./ticket_transcript');
 *   await generateTranscript(client, guildId, ticket, panel, ticketData, user);
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    AttachmentBuilder,
    MessageFlags,
} = require('discord.js');

const { createTranscript, ExportReturnType } = require('discord-transcript-v2');

const DB_ROOT = path.join(__dirname, '../dashboard/database');

// ── Public API ─────────────────────────────────────────────────────────────
/**
 * @param {import('discord.js').Client}    client
 * @param {string}                         guildId
 * @param {object}                         ticket     – open ticket record
 * @param {object|null}                    panel      – panel config from tickets.json
 * @param {object|null}                    ticketData – full tickets.json data
 * @param {import('discord.js').User|null} dmUser     – user to DM transcript to
 * @returns {Promise<{ filePath: string|null, transcriptChannelMsgId: string|null }>}
 */
async function generateTranscript(client, guildId, ticket, panel, ticketData, dmUser = null) {
    // Skip entirely if transcript not enabled on this panel
    if (!panel?.transcriptEnabled) return { filePath: null, transcriptChannelMsgId: null };

    // ── 1. Fetch the ticket channel ────────────────────────────────────────
    const channel = ticket.channelId
        ? (client.channels.cache.get(ticket.channelId)
            ?? await client.channels.fetch(ticket.channelId).catch(() => null))
        : null;

    if (!channel) {
        console.warn('[ticket_transcript] Channel not found for ticket', ticket.id);
        return { filePath: null, transcriptChannelMsgId: null };
    }

    // ── 2. Generate HTML via discord-transcript-v2 ──────────────────────────
    const fileName = `transcript-${ticket.id}.html`;
    let htmlBuffer;

    try {
        htmlBuffer = await createTranscript(channel, {
            limit:      -1,                      // fetch all messages
            returnType: ExportReturnType.Buffer,  // Buffer for disk save + reuse
            filename:   fileName,
            saveImages: false,
            poweredBy:  false,
        });
    } catch (err) {
        console.error('[ticket_transcript] createTranscript error:', err.message);
        return { filePath: null, transcriptChannelMsgId: null };
    }

    // ── 3. Save HTML to disk ───────────────────────────────────────────────
    const dir = path.join(DB_ROOT, guildId, 'transcripts');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, fileName);
    const buf = Buffer.isBuffer(htmlBuffer) ? htmlBuffer : Buffer.from(htmlBuffer);
    fs.writeFileSync(filePath, buf);

    // ── 4. Resolve transcript channel ─────────────────────────────────────
    const rawId = panel?.transcriptChannel;
    const transcriptChannelId = (!rawId || rawId === 'global')
        ? (ticketData?.general?.TRANSCRIPTS_CHANNEL || null)
        : rawId;

    // ── 5. Post to transcript channel ─────────────────────────────────────
    let transcriptChannelMsgId = null;
    if (transcriptChannelId) {
        const tCh = client.channels.cache.get(transcriptChannelId)
            ?? await client.channels.fetch(transcriptChannelId).catch(() => null);
        if (tCh?.isTextBased()) {
            transcriptChannelMsgId = await _postToChannel(tCh, ticket, panel, filePath, fileName);
        }
    }

    // ── 6. DM to ticket creator ────────────────────────────────────────────
    if (panel?.transcriptDm) {
        const user = dmUser ?? await client.users.fetch(ticket.userId).catch(() => null);
        if (user) await _dmToUser(user, ticket, panel, filePath, fileName);
    }

    return { filePath, transcriptChannelMsgId };
}

// ── Post V2 card + HTML file to transcript channel ─────────────────────────
async function _postToChannel(channel, ticket, panel, filePath, fileName) {
    const container = new ContainerBuilder().setAccentColor(0x5865f2);

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `## 📄 Transcript — Ticket \`#${String(ticket.number ?? ticket.id).padStart(4, '0')}\``
        )
    );
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            [
                `> **User:** <@${ticket.userId}>`,
                `> **Panel:** ${panel?.panelTitle || ticket.panelId || '—'}`,
                `> **Closed:** <t:${Math.floor(Date.now() / 1000)}:f>`,
                `> **Reason:** ${ticket.closeReason || '—'}`,
            ].join('\n')
        )
    );

    const file = new AttachmentBuilder(filePath, { name: fileName });

    try {
        await channel.send({
            components: [container],
            flags:      MessageFlags.IsComponentsV2,
        });
        const fileMsg = await channel.send({ files: [file] });
        return fileMsg.id;
    } catch (err) {
        console.error('[ticket_transcript] Failed to post to transcript channel:', err.message);
        return null;
    }
}

// ── DM transcript HTML to user ─────────────────────────────────────────────
async function _dmToUser(user, ticket, panel, filePath, fileName) {
    try {
        const container = new ContainerBuilder().setAccentColor(0x57f287);
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`## 📄 Your Ticket Transcript`)
        );
        container.addSeparatorComponents(new SeparatorBuilder());
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                [
                    `Your ticket \`#${String(ticket.number ?? ticket.id).padStart(4, '0')}\` from **${panel?.panelTitle || 'Support'}** has been closed.`,
                    `Here is your transcript — open the HTML file in a browser to view it.`,
                    ticket.closeReason ? `\n> **Reason:** ${ticket.closeReason}` : '',
                ].filter(Boolean).join('\n')
            )
        );

        const dm = await user.createDM();
        // V2 components message first (files not referenced in tree are dropped by Discord)
        await dm.send({
            components: [container],
            flags:      MessageFlags.IsComponentsV2,
        });
        // Transcript file as a plain follow-up so Discord actually delivers it
        await dm.send({
            files: [new AttachmentBuilder(filePath, { name: fileName })],
        });
    } catch (err) {
        // DMs can fail if the user has them disabled — not fatal
        console.warn('[ticket_transcript] Could not DM transcript to user:', err.message);
    }
}

// ── Legacy HTML builder (kept for reference, no longer used) ─────────────
function _buildHtml(ticket, panel, messages) {
    const title = `Ticket #${String(ticket.number ?? ticket.id).padStart(4,'0')} — ${panel?.panelTitle ?? ''}`;

    const messageRows = messages.map(m => {
        const iso    = new Date(m.createdTimestamp).toLocaleString('en-GB', { hour12: false });
        const author = _esc(m.author?.tag ?? 'Unknown#0000');
        const avatar = m.author?.displayAvatarURL({ size: 32, extension: 'webp' }) ?? '';
        const isDev  = m.author?.bot ? ' <span class="badge">BOT</span>' : '';
        const body   = _formatContent(m.content);
        const attachLinks = [...m.attachments.values()]
            .map(a => `<a class="attach" href="${_esc(a.url)}" target="_blank">📎 ${_esc(a.name)}</a>`)
            .join(' ');
        const embedsHtml = m.embeds.length
            ? `<div class="embeds">${m.embeds.map(_renderEmbed).join('')}</div>`
            : '';

        return `    <div class="msg" id="${m.id}">
      <img class="av" src="${avatar}" alt="${author}" loading="lazy" />
      <div class="body">
        <span class="author">${author}${isDev}</span>
        <span class="ts" title="${new Date(m.createdTimestamp).toISOString()}">${iso}</span>
        ${body ? `<div class="content">${body}</div>` : ''}
        ${attachLinks ? `<div class="attachments">${attachLinks}</div>` : ''}
        ${embedsHtml}
      </div>
    </div>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${_esc(title)}</title>
  <style>
    :root {
      --bg: #313338; --surface: #2b2d31; --elevated: #232428;
      --text: #dbdee1; --muted: #80848e; --accent: #5865f2;
      --green: #57f287; --red: #ed4245; --yellow: #fee75c;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg); color: var(--text);
      font: 15px/1.6 "gg sans","Noto Sans",system-ui,sans-serif;
      padding: 24px 32px;
    }
    header {
      display: flex; align-items: flex-start; gap: 16px;
      border-left: 4px solid var(--accent); padding: 14px 18px;
      background: var(--surface); border-radius: 6px; margin-bottom: 28px;
    }
    header .meta h1  { font-size: 1.15rem; color: #fff; }
    header .meta p   { font-size: .82rem;  color: var(--muted); margin-top: 4px; }
    .msg {
      display: flex; gap: 14px; padding: 6px 4px; border-radius: 4px;
      transition: background .1s;
    }
    .msg:hover { background: var(--surface); }
    .av  { width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0; margin-top: 2px; }
    .body { flex: 1; min-width: 0; }
    .author { font-weight: 600; color: #fff; }
    .ts     { font-size: .75rem; color: var(--muted); margin-left: 8px; }
    .badge  { font-size: .65rem; background: var(--accent); color: #fff;
              padding: 1px 5px; border-radius: 3px; vertical-align: middle; margin-left: 4px; }
    .content { white-space: pre-wrap; word-break: break-word; color: var(--text); margin-top: 2px; }
    .attachments { margin-top: 4px; }
    a.attach { color: var(--accent); font-size: .85rem; margin-right: 8px; }
    a.attach:hover { text-decoration: underline; }
    .embeds  { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }
    .embed   { border-left: 4px solid var(--accent); background: var(--elevated);
               padding: 8px 12px; border-radius: 0 4px 4px 0; font-size: .9rem; }
    .embed .e-title   { font-weight: 700; color: #fff; }
    .embed .e-desc    { color: var(--text); margin-top: 4px; white-space: pre-wrap; }
    code { background: var(--elevated); padding: 1px 5px; border-radius: 4px; font-size: .88em; }
    pre  { background: var(--elevated); padding: 12px; border-radius: 6px;
           overflow-x: auto; font-size: .88em; margin-top: 4px; }
    blockquote { border-left: 3px solid var(--muted); padding-left: 10px; color: var(--muted); }
    footer { margin-top: 40px; text-align: center; font-size: .78rem; color: var(--muted); }
  </style>
</head>
<body>
  <header>
    <div class="meta">
      <h1>📄 ${_esc(title)}</h1>
      <p>
        User: ${_esc(ticket.userId)} &nbsp;|&nbsp;
        Panel: ${_esc(panel?.panelTitle ?? '')} &nbsp;|&nbsp;
        Messages: ${messages.length} &nbsp;|&nbsp;
        Opened: ${ticket.openedAt ? new Date(ticket.openedAt).toLocaleString('en-GB') : '—'} &nbsp;|&nbsp;
        Closed: ${ticket.closedAt ? new Date(ticket.closedAt).toLocaleString('en-GB') : '—'}
      </p>
    </div>
  </header>

  <div class="messages">
${messageRows || '    <p style="color:var(--muted);padding:12px">No messages found.</p>'}
  </div>

  <footer>Generated by System Pro &nbsp;|&nbsp; ${new Date().toUTCString()}</footer>
</body>
</html>`;
}

function _renderEmbed(e) {
    const parts = [];
    if (e.title)       parts.push(`<div class="e-title">${_esc(e.title)}</div>`);
    if (e.description) parts.push(`<div class="e-desc">${_esc(e.description)}</div>`);
    if (!parts.length) return '';
    const color = e.color ? `border-left-color:#${e.color.toString(16).padStart(6,'0')}` : '';
    return `<div class="embed" style="${color}">${parts.join('')}</div>`;
}

function _formatContent(text) {
    if (!text) return '';
    return _esc(text)
        .replace(/```([a-z]*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
        .replace(/`([^`]+)`/g,                   '<code>$1</code>')
        .replace(/^&gt;\s(.+)$/gm,               '<blockquote>$1</blockquote>')
        .replace(/\*\*(.+?)\*\*/g,               '<strong>$1</strong>')
        .replace(/__(.+?)__/g,                   '<u>$1</u>')
        .replace(/\*(.+?)\*/g,                   '<em>$1</em>')
        .replace(/~~(.+?)~~/g,                   '<del>$1</del>')
        .replace(/\|\|(.+?)\|\|/g,               '<span style="background:#202225;border-radius:3px">$1</span>');
}

function _esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

module.exports = { generateTranscript };


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */