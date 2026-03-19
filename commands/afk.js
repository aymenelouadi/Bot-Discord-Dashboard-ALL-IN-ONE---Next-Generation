/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

﻿const { SlashCommandBuilder } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const guard = require('../utils/cmdGuard');

/* ── Components V2 ── */
const CV2 = 1 << 15;
const C   = { Container: 17, Text: 10, Sep: 14 };

/* ── Database helpers ─────────────────────────────────── */
const DB = path.join(__dirname, '../database/afk.json');

function readDB() {
    if (!fs.existsSync(DB)) return {};
    try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return {}; }
}

function writeDB(data) {
    fs.mkdirSync(path.dirname(DB), { recursive: true });
    fs.writeFileSync(DB, JSON.stringify(data, null, 2));
}

function getAFK(userId)             { return readDB()[userId] || null; }
function saveAFK(userId, entry)     { const d = readDB(); d[userId] = entry; writeDB(d); }
function removeAFK(userId)          { const d = readDB(); const e = d[userId]; delete d[userId]; writeDB(d); return e; }

/* ── Duration formatter ───────────────────────────────── */
function fmtDuration(ms) {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    const p = [];
    if (d) p.push(`${d}d`);
    if (h) p.push(`${h}h`);
    if (m) p.push(`${m}m`);
    if (!p.length) p.push(`${Math.floor(s % 60)}s`);
    return p.join(' ');
}

/* ── Message builders ─────────────────────────────────── */
function buildSet(reason, date) {
    return {
        flags: CV2,
        components: [{
            type: C.Container,
            accent_color: 0x5865f2,
            components: [{ type: C.Text, content: `## 💤  AFK Enabled\n**Reason:** ${reason}\n-# ${date}` }],
        }],
    };
}

function buildRemoved(duration) {
    return {
        flags: CV2,
        components: [{
            type: C.Container,
            accent_color: 0x27ae60,
            components: [{ type: C.Text, content: `## ✅  Welcome back!\n-# You were AFK for **${duration}**` }],
        }],
    };
}

function buildError(text) {
    return {
        flags: CV2,
        components: [{
            type: C.Container,
            accent_color: 0xe74c3c,
            components: [{ type: C.Text, content: `❌  ${text}` }],
        }],
    };
}

/* ── Module ───────────────────────────────────────────── */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('afk')
        .setDescription('Set or clear your AFK status')
        .addStringOption(o => o.setName('reason').setDescription('AFK reason').setRequired(false)),

    textCommand: { name: 'afk', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash   = ctx.isCommand?.();
        const guildId   = ctx.guild?.id;
        const channelId = isSlash ? ctx.channelId : ctx.channel.id;
        const user      = isSlash ? ctx.user : ctx.author;

        const g = guard.check('afk', guildId, channelId, ctx.member ?? null);
        if (!g.ok) return guard.deny(ctx, g.reason);

        /* ── Toggle AFK off if already set ── */
        const current = getAFK(user.id);
        if (current) {
            removeAFK(user.id);
            const duration = fmtDuration(Date.now() - current.timestamp);
            const msg = buildRemoved(duration);

            if (isSlash) {
                await ctx.reply(msg);
            } else {
                const reply = await ctx.reply(msg);
                await guard.cleanup(g.cfg, ctx, reply);
            }
            return;
        }

        /* ── Set AFK ── */
        const reason = isSlash
            ? (ctx.options.getString('reason') || 'AFK')
            : (args.join(' ') || 'AFK');

        if (!isSlash && !args.length) {
            // No reason provided from text — just default to 'AFK', no error
        }

        const now  = Date.now();
        const date = new Date(now).toLocaleString('en-US', { timeStyle: 'short', dateStyle: 'medium' });

        saveAFK(user.id, { userId: user.id, username: user.username, reason, timestamp: now, date, guildId });

        const msgSet = buildSet(reason, date);

        if (isSlash) {
            await ctx.reply(msgSet);
        } else {
            const reply = await ctx.reply(msgSet);
            await guard.cleanup(g.cfg, ctx, reply);
        }
    },

    /* Exported helpers for index.js AFK detection */
    getAFK,
    removeAFK,
    fmtDuration,
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */