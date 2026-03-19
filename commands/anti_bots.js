/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const logSystem = require('../systems/log.js');
const {
    i18n, getLang, saveProtection,
    checkPermission, isCommandEnabled, buildEmbed, sendResponse
} = require('./_protectionHelper');

const CMD = 'anti_bots';

module.exports = {
    data: new SlashCommandBuilder()
        .setName(CMD)
        .setDescription('Anti-Bots | منع إضافة البوتات')
        
        .addStringOption(o => o
            .setName('action')
            .setDescription('Punishment | الإجراء')
            .setRequired(true)
            .addChoices(
                { name: 'Kick / كير',                value: '1' },
                { name: 'Remove Roles / إزالة الرتب', value: '2' },
                { name: 'Ban / حظر',                 value: '3' }
            )
        )
        .addBooleanOption(o => o.setName('enabled').setDescription('Enable/Disable').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    textCommand: { name: 'antibot', aliases: ["anti-bot"] },

    async execute(client, ctx, args) {
        const isSlash = ctx.isCommand?.();
        const guildId = ctx.guildId || ctx.guild?.id;
        const lang    = getLang(guildId);
        const t       = i18n[lang];
        try {
            if (!isCommandEnabled(CMD)) return sendResponse(ctx, isSlash, t.disabled);
            if (!checkPermission(ctx.member, guildId, CMD)) return sendResponse(ctx, isSlash, t.noPermission);

            let action, enabled;
            if (isSlash) {
                action  = ctx.options.getString('action');
                enabled = ctx.options.getBoolean('enabled') ?? true;
            } else {
                if (args.length < 1) {
                    const u = lang === 'en'
                        ? `**Usage:** \`!antibot <1/2/3> [on/off]\``
                        : `**الاستخدام:** \`!antibot <1/2/3> [on/off]\``;
                    return sendResponse(ctx, isSlash, u);
                }
                action = args[0]; enabled = args[1] !== 'off';
            }
            if (!['1','2','3'].includes(String(action)))
                return sendResponse(ctx, isSlash, lang === 'en' ? 'Invalid arguments.' : 'مدخلات غير صحيحة.');
            
            saveProtection(guildId, { [CMD]: { enabled, action: String(action) } });

            const moderator = ctx.user || ctx.author;
            await logSystem.logCommandUsage({
                interaction: ctx, commandName: CMD, moderator, target: moderator,
                reason: `anti_bots → action:${action} enabled:${enabled}`,
                action: CMD
            }).catch(() => {});

            return sendResponse(ctx, isSlash, buildEmbed({
                guildId, protectionKey: CMD,
                titleAr: 'منع إضافة البوتات', titleEn: 'Anti-Bots',
                enabled, limit: null, action: String(action), lang
            }));
        } catch(e) {
            console.error(`[${CMD}]`, e);
            return sendResponse(ctx, isSlash, t.error);
        }
    }
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */