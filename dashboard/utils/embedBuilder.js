/*
 * Next Generation — Embed Builder Utility
 * Converts the stored EmbedMessage document into a Discord.js-compatible
 * message payload (embeds + components).
 */

'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, StringSelectMenuBuilder, ButtonStyle, StringSelectMenuOptionBuilder } = require('discord.js');

/** Only allow real HTTP/HTTPS URLs — rejects data:, blob:, empty strings, etc. */
function isValidUrl(str) {
    if (!str || typeof str !== 'string') return false;
    try {
        const u = new URL(str);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch { return false; }
}

const STYLE_MAP = {
    Primary:   ButtonStyle.Primary,
    Secondary: ButtonStyle.Secondary,
    Success:   ButtonStyle.Success,
    Danger:    ButtonStyle.Danger,
    Link:      ButtonStyle.Link,
};

/**
 * Build a Discord.js message payload from an EmbedMessage document (or plain object).
 * @param {object} doc  EmbedMessage lean object
 * @param {object} [opts]
 * @param {string[]} [opts.embedIds]  If set, only include these embed ids
 * @param {object[]} [opts.overrideComponents]  Override component rows
 * @returns {{ embeds: EmbedBuilder[], components: ActionRowBuilder[] }}
 */
function buildDiscordPayload(doc, opts = {}) {
    const srcEmbeds = opts.embedIds
        ? (doc.embeds || []).filter(e => opts.embedIds.includes(e.id))
        : (doc.embeds || []);

    const embeds = srcEmbeds.map(e => {
        const eb = new EmbedBuilder();
        if (e.title?.trim())       eb.setTitle(e.title.trim().slice(0, 256));
        if (e.description?.trim()) eb.setDescription(e.description.trim().slice(0, 4096));
        if (e.color)       { try { eb.setColor(e.color); } catch (_) {} }
        if (isValidUrl(e.url))       eb.setURL(e.url);
        if (e.timestamp)   eb.setTimestamp();
        if (e.author?.name) eb.setAuthor({
            name:    e.author.name,
            iconURL: isValidUrl(e.author.iconUrl) ? e.author.iconUrl : undefined,
            url:     isValidUrl(e.author.url)     ? e.author.url     : undefined,
        });
        if (e.footer?.text) eb.setFooter({
            text:    e.footer.text,
            iconURL: isValidUrl(e.footer.iconUrl) ? e.footer.iconUrl : undefined,
        });
        if (isValidUrl(e.thumbnail)) eb.setThumbnail(e.thumbnail);
        if (isValidUrl(e.image))     eb.setImage(e.image);
        if (e.fields?.length) {
            eb.addFields(e.fields.slice(0, 25).map(f => ({ name: f.name || '\u200b', value: f.value || '\u200b', inline: !!f.inline })));
        }
        // Skip embeds with no visible content — Discord rejects empty embeds
        const j = eb.toJSON();
        const hasContent = j.title || j.description || j.author?.name || j.footer?.text
            || j.image?.url || j.thumbnail?.url || j.fields?.length;
        if (!hasContent) return null;
        return eb;
    }).filter(Boolean);

    const srcRows = opts.overrideComponents !== undefined ? opts.overrideComponents : (doc.components || []);
    const components = srcRows.slice(0, 5).map(row => {
        const ar = new ActionRowBuilder();
        if (row.type === 'buttons' && row.buttons?.length) {
            ar.addComponents(row.buttons.slice(0, 5).map(b => {
                const btn = new ButtonBuilder()
                    .setLabel(b.label || 'Button')
                    .setStyle(STYLE_MAP[b.style] || ButtonStyle.Primary);
                if (b.style === 'Link') {
                    btn.setURL(b.url || 'https://discord.com');
                } else {
                    btn.setCustomId(b.customId);
                }
                if (b.emoji) { try { btn.setEmoji(b.emoji); } catch (_) {} }
                if (b.disabled) btn.setDisabled(true);
                return btn;
            }));
        } else if (row.type === 'select' && row.select) {
            const s = row.select;
            const menu = new StringSelectMenuBuilder()
                .setCustomId(s.customId)
                .setPlaceholder(s.placeholder || 'Select an option…')
                .setMinValues(s.minValues ?? 1)
                .setMaxValues(s.maxValues ?? 1);
            if (s.disabled) menu.setDisabled(true);
            if (s.options?.length) {
                menu.addOptions(s.options.slice(0, 25).map(o => {
                    const opt = new StringSelectMenuOptionBuilder()
                        .setLabel(o.label || 'Option')
                        .setValue(o.value);
                    if (o.description) opt.setDescription(o.description.slice(0, 100));
                    if (o.emoji)       { try { opt.setEmoji(o.emoji); } catch (_) {} }
                    if (o.default)     opt.setDefault(true);
                    return opt;
                }));
            }
            ar.addComponents(menu);
        }
        if (!ar.components.length) return null;
        return ar;
    }).filter(Boolean);

    return { embeds, components };
}

module.exports = { buildDiscordPayload };

/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */
