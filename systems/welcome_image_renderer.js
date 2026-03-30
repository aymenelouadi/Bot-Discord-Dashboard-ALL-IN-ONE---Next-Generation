'use strict';

/*
 * Next Generation — Welcome Image Renderer
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders a welcome image based on a WelcomeImage config document using
 * node-canvas. Returns a PNG Buffer ready to attach to a Discord message.
 *
 * Supported layer types:
 *   • "image" — static URL / dynamic:avatar / dynamic:guild_icon / dynamic:banner
 *   • "text"  — static or [variable] content with shadow / stroke support
 *
 * Usage:
 *   const { renderWelcomeImage } = require('./welcome_image_renderer');
 *   const buf = await renderWelcomeImage(config, { member, guild });
 *   // buf is a PNG Buffer
 */

const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const https = require('https');
const http  = require('http');
const path  = require('path');
const fs    = require('fs');
const logger = require('../utils/logger');

// ── Font registration ─────────────────────────────────────────────────────────
// Register any custom fonts placed in dashboard/public/fonts/
const FONTS_DIR = path.join(__dirname, '../dashboard/public/fonts');
if (fs.existsSync(FONTS_DIR)) {
    for (const file of fs.readdirSync(FONTS_DIR)) {
        if (/\.(ttf|otf|woff)$/i.test(file)) {
            try {
                GlobalFonts.registerFromPath(path.join(FONTS_DIR, file));
            } catch { /* ignore bad fonts */ }
        }
    }
}

// ── Image cache (in-memory LRU-ish, bounded at 50 entries) ───────────────────
const _imgCache = new Map();
const IMG_CACHE_MAX = 50;

async function _fetchRemoteImage(url) {
    if (_imgCache.has(url)) return _imgCache.get(url);

    const buf = await new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        mod.get(url, { timeout: 8000 }, (res) => {
            const chunks = [];
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return _fetchRemoteImage(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
    });

    const img = await loadImage(buf);
    if (_imgCache.size >= IMG_CACHE_MAX) {
        const oldest = _imgCache.keys().next().value;
        _imgCache.delete(oldest);
    }
    _imgCache.set(url, img);
    return img;
}

async function _loadImage(src, member, guild) {
    if (!src) return null;
    if (src === 'dynamic:avatar') {
        const url = member.user.displayAvatarURL({ extension: 'png', size: 256 });
        return _fetchRemoteImage(url).catch(() => null);
    }
    if (src === 'dynamic:guild_icon') {
        const url = guild.iconURL({ extension: 'png', size: 256 });
        if (!url) return null;
        return _fetchRemoteImage(url).catch(() => null);
    }
    if (src === 'dynamic:banner') {
        const url = member.user.bannerURL?.({ extension: 'png', size: 512 });
        if (!url) return null;
        return _fetchRemoteImage(url).catch(() => null);
    }
    if (/^https?:\/\//i.test(src)) {
        return _fetchRemoteImage(src).catch(() => null);
    }
    // Relative path → serve from dashboard/public on disk (e.g. /uploads/wi-bg/...)
    if (src.startsWith('/')) {
        const diskPath = path.join(__dirname, '../dashboard/public', src);
        try {
            return await loadImage(diskPath);
        } catch { return null; }
    }
    return null;
}

// ── Variable resolver ─────────────────────────────────────────────────────────
function _resolveText(text, member, guild) {
    if (!text) return '';
    const user      = member.user;
    const createdAt = user.createdAt;
    const days      = Math.floor((Date.now() - createdAt.getTime()) / 86_400_000);
    return text
        .replace(/\[user\]/g,            user.username)
        .replace(/\[userName\]/g,        user.username)
        .replace(/\[userCreatedDate\]/g, createdAt.toLocaleDateString('en-GB'))
        .replace(/\[userCreatedDays\]/g, String(days))
        .replace(/\[serverName\]/g,      guild.name)
        .replace(/\[memberCount\]/g,     String(guild.memberCount))
        .replace(/\[inviter\]/g,         user.username)
        .replace(/\[inviterName\]/g,     user.username)
        .replace(/\[invitesCount\]/g,    '0')
        .replace(/\[inviteCode\]/g,      'N/A');
}

// ── Rounded-rectangle clip path ───────────────────────────────────────────────
function _roundedRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

// ── Draw a single layer ───────────────────────────────────────────────────────
async function _drawLayer(ctx, layer, member, guild) {
    if (!layer.visible) return;

    const { x, y, width: w, height: h, rotation, opacity } = layer;
    const cx = x + w / 2;
    const cy = y + h / 2;

    ctx.save();
    ctx.globalAlpha = typeof opacity === 'number' ? Math.max(0, Math.min(1, opacity)) : 1;

    // Apply rotation around layer centre
    if (rotation) {
        ctx.translate(cx, cy);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.translate(-cx, -cy);
    }

    if (layer.type === 'image' || layer.type === 'background' || layer.type === 'avatar') {
        const img = await _loadImage(layer.src, member, guild);
        if (img) {
            const r = typeof layer.borderRadius === 'number'
                ? (layer.borderRadius / 100) * Math.min(w, h)  // borderRadius is % of min side
                : 0;
            if (r > 0) {
                ctx.save();
                _roundedRect(ctx, x, y, w, h, r);
                ctx.clip();
            }

            // fit: cover (crop to fill) | contain (letterbox) | fill (stretch)
            const fit = layer.fit || 'cover';
            const iw = img.width, ih = img.height;

            if (fit === 'fill') {
                ctx.drawImage(img, x, y, w, h);
            } else if (fit === 'contain') {
                const scale = Math.min(w / iw, h / ih);
                const dw = iw * scale, dh = ih * scale;
                ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
            } else { // cover
                const scale = Math.max(w / iw, h / ih);
                const dw = iw * scale, dh = ih * scale;
                ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
            }

            if (r > 0) ctx.restore();
        }
    }

    if (layer.type === 'text') {
        const text = _resolveText(layer.content || '', member, guild);
        if (!text) { ctx.restore(); return; }

        const fontSize   = layer.fontSize   || 24;
        const fontFamily = layer.fontFamily  || 'Inter';
        const fontWeight = layer.fontWeight  || 'normal';
        const fontStyle  = layer.fontStyle   || 'normal';
        ctx.font      = `${fontStyle} ${fontWeight} ${fontSize}px "${fontFamily}", sans-serif`;
        ctx.fillStyle = layer.color || '#ffffff';
        ctx.textAlign = layer.align || 'center';
        ctx.textBaseline = 'middle';

        const tx = layer.align === 'left' ? x : layer.align === 'right' ? x + w : x + w / 2;
        const ty = y + h / 2;

        if (layer.shadow) {
            ctx.shadowColor   = layer.shadowColor || 'rgba(0,0,0,0.7)';
            ctx.shadowBlur    = Math.round(fontSize * 0.2);
            ctx.shadowOffsetX = 2;
            ctx.shadowOffsetY = 2;
        }

        if (layer.strokeWidth > 0 && layer.stroke) {
            ctx.strokeStyle = layer.stroke;
            ctx.lineWidth   = layer.strokeWidth;
            ctx.lineJoin    = 'round';
            ctx.strokeText(text, tx, ty);
        }

        ctx.fillText(text, tx, ty);
        ctx.shadowColor = 'transparent';
    }

    ctx.restore();
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Render the welcome canvas and return a PNG Buffer.
 * @param {object} config  WelcomeImage config (from WelcomeImage.getConfig)
 * @param {{ member: import('discord.js').GuildMember, guild: import('discord.js').Guild }} context
 * @returns {Promise<Buffer>}
 */
async function renderWelcomeImage(config, { member, guild }) {
    const W = config.width  || 500;
    const H = config.height || 350;

    const canvas = createCanvas(W, H);
    const ctx    = canvas.getContext('2d');

    // Background fill
    ctx.fillStyle = config.bgColor || '#060018';
    ctx.fillRect(0, 0, W, H);

    // Draw layers bottom → top
    const layers = Array.isArray(config.layers) ? config.layers : [];
    for (const layer of layers) {
        try {
            await _drawLayer(ctx, layer, member, guild);
        } catch (err) {
            logger.warn('welcome_image_renderer: layer draw failed', {
                category: 'system', layerId: layer.id, error: err.message,
            });
        }
    }

    return canvas.toBuffer('image/png');
}

module.exports = { renderWelcomeImage };
