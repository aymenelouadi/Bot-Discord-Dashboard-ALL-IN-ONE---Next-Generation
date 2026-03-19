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

const CMD = 'anti_channel_delete';

module.exports = {
    data: new SlashCommandBuilder()
        .setName(CMD)
        .setDescription('Anti Channel-Delete | منع حذف القنوات')
        .addIntegerOption(o => o
            .setName('limit')
            .setDescription('Max actions before punishment | الحد قبل التدخل')
            .setRequired(true).setMinValue(1).setMaxValue(20)
        )
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

    textCommand: { name: 'antichdelete', aliases: ["anti-channel-delete"] },

    async execute(client, ctx, args) {
        const isSlash = ctx.isCommand?.();
        const guildId = ctx.guildId || ctx.guild?.id;
        const lang    = getLang(guildId);
        const t       = i18n[lang];
        try {
            if (!isCommandEnabled(CMD)) return sendResponse(ctx, isSlash, t.disabled);
            if (!checkPermission(ctx.member, guildId, CMD)) return sendResponse(ctx, isSlash, t.noPermission);

            let limit, action, enabled;
            if (isSlash) {
                limit   = ctx.options.getInteger('limit');
                action  = ctx.options.getString('action');
                enabled = ctx.options.getBoolean('enabled') ?? true;
            } else {
                if (args.length < 2) {
                    const u = lang === 'en'
                        ? `**Usage:** \`!antichdelete <limit 1-20> <1/2/3> [on/off]\``
                        : `**الاستخدام:** \`!antichdelete <الحد 1-20> <1/2/3> [on/off]\``;
                    return sendResponse(ctx, isSlash, u);
                }
                limit = parseInt(args[0]); action = args[1]; enabled = args[2] !== 'off';
            }
            if (isNaN(limit) || limit < 1 || limit > 20 || !['1','2','3'].includes(String(action)))
                return sendResponse(ctx, isSlash, lang === 'en' ? 'Invalid arguments.' : 'مدخلات غير صحيحة.');
            
            saveProtection(guildId, { [CMD]: { enabled, limit, action: String(action) } });

            const moderator = ctx.user || ctx.author;
            await logSystem.logCommandUsage({
                interaction: ctx, commandName: CMD, moderator, target: moderator,
                reason: `anti_channel_delete → limit:${limit} action:${action} enabled:${enabled}`,
                action: CMD
            }).catch(() => {});

            return sendResponse(ctx, isSlash, buildEmbed({
                guildId, protectionKey: CMD,
                titleAr: 'منع حذف القنوات', titleEn: 'Anti Channel-Delete',
                enabled, limit, action: String(action), lang
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