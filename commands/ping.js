/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

﻿const { SlashCommandBuilder } = require('discord.js');
const os    = require('os');
const { version } = require('discord.js');
const guard = require('../utils/cmdGuard');

/* ── Components V2 ── */
const CV2 = 1 << 15; // MessageFlags.IsComponentsV2
const C   = { Container: 17, Text: 10, Sep: 14 };

function fmtUptime(ms) {
    const s = Math.floor((ms || 0) / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    const p = [];
    if (d) p.push(`${d}d`);
    if (h) p.push(`${h}h`);
    if (m) p.push(`${m}m`);
    if (!p.length) p.push(`${Math.floor(s % 60)}s`);
    return p.join(' ');
}

function bar(pct, len = 10) {
    const n = Math.max(0, Math.min(len, Math.round(pct / 100 * len)));
    return `\`${'█'.repeat(n)}${'░'.repeat(len - n)}\``;
}

function buildMsg(ping, apiPing, client) {
    const total = os.totalmem(), used = total - os.freemem();
    const pct   = (used / total) * 100;
    const dot   = (ms) => ms < 100 ? '🟢' : ms < 200 ? '🟡' : '🔴';

    return {
        flags: CV2,
        components: [{
            type: C.Container,
            accent_color: 0x27ae60,
            components: [{
                type: C.Text,
                content: [
                    `## 🏓  Pong!`,
                    ``,
                    `${dot(ping)} **Bot** \`${ping}ms\`    ${dot(apiPing)} **API** \`${apiPing}ms\``,
                    ``,
                    `💾 **RAM**  ${(used/1024**3).toFixed(1)} / ${(total/1024**3).toFixed(1)} GB  ${bar(pct)}  ${pct.toFixed(0)}%`,
                    `🖥️ **CPU**  ${os.cpus().length} cores  ·  load \`${os.loadavg()[0].toFixed(2)}\``,
                    ``,
                    `⬆️ **Uptime**  \`${fmtUptime(client.uptime)}\``,
                    `🌐 **Servers** \`${client.guilds.cache.size}\`   👥 **Users** \`${client.users.cache.size}\``,
                    ``,
                    `-# Node ${process.version}  ·  discord.js ${version}`,
                ].join('\n'),
            }],
        }],
    };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Bot statistics & latency'),

    textCommand: { name: 'ping', aliases: [] },

    async execute(client, ctx, args) {
        const isSlash   = ctx.isCommand?.();
        const guildId   = ctx.guild?.id;
        const channelId = isSlash ? ctx.channelId : ctx.channel.id;

        const g = guard.check('ping', guildId, channelId, ctx.member ?? null);
        if (!g.ok) return guard.deny(ctx, g.reason);

        const t0 = Date.now();

        if (isSlash) {
            await ctx.deferReply();
            await ctx.editReply(buildMsg(Date.now() - t0, Math.round(client.ws.ping), client));
        } else {
            const skeleton = {
                flags: CV2,
                components: [{ type: C.Container, accent_color: 0x27ae60,
                    components: [{ type: C.Text, content: '## 🏓  Pong!\n\n-# measuring...' }] }],
            };
            const reply = await ctx.channel.send(skeleton);
            await reply.edit(buildMsg(Date.now() - t0, Math.round(client.ws.ping), client));
            await guard.cleanup(g.cfg, ctx, reply);
        }
    },
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */