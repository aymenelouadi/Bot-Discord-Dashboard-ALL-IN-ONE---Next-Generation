/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const logSystem = require('../systems/log.js');
const {
    i18n, getLang, getProtection, saveProtection,
    checkPermission, isCommandEnabled, buildEmbed, sendResponse
} = require('./_protectionHelper');

const CMD = 'anti_ban';

module.exports = {
    data: new SlashCommandBuilder()
        .setName(CMD)
        .setDescription('Anti-Ban settings | إعدادات منع الحظر الجماعي')
        .addIntegerOption(o => o
            .setName('limit')
            .setDescription('Max bans before punishment triggers | الحد المسموح قبل التدخل')
            .setRequired(true)
            .setMinValue(1).setMaxValue(20)
        )
        .addStringOption(o => o
            .setName('action')
            .setDescription('Punishment action | الإجراء عند تجاوز الحد')
            .setRequired(true)
            .addChoices(
                { name: 'Kick / كير',              value: '1' },
                { name: 'Remove Roles / إزالة الرتب', value: '2' },
                { name: 'Ban / حظر',               value: '3' }
            )
        )
        .addBooleanOption(o => o
            .setName('enabled')
            .setDescription('Enable or disable | تفعيل أو تعطيل')
            .setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    textCommand: {
        name: 'antiban',
        aliases: ['anti-ban']
    },

    async execute(client, interactionOrMessage, args) {
        const isSlash  = interactionOrMessage.isCommand?.();
        const guildId  = interactionOrMessage.guildId || interactionOrMessage.guild?.id;
        const lang     = getLang(guildId);
        const t        = i18n[lang];

        try {
            // ── Command enabled check ──────────────────────────────────────────
            if (!isCommandEnabled(CMD)) {
                return sendResponse(interactionOrMessage, isSlash, t.disabled);
            }

            // ── Permission check ───────────────────────────────────────────────
            if (!checkPermission(interactionOrMessage.member, guildId, CMD)) {
                return sendResponse(interactionOrMessage, isSlash, t.noPermission);
            }

            // ── Parse arguments ────────────────────────────────────────────────
            let limit, action, enabled;

            if (isSlash) {
                limit   = interactionOrMessage.options.getInteger('limit');
                action  = interactionOrMessage.options.getString('action');
                enabled = interactionOrMessage.options.getBoolean('enabled') ?? true;
            } else {
                if (args.length < 2) {
                    const usage = lang === 'en'
                        ? `**Usage:** \`!antiban <limit 1-20> <action 1/2/3> [on/off]\`\n1=Kick 2=Remove Roles 3=Ban`
                        : `**الاستخدام:** \`!antiban <الحد 1-20> <الإجراء 1/2/3> [on/off]\`\n1=كير  2=إزالة الرتب  3=حظر`;
                    return sendResponse(interactionOrMessage, isSlash, usage);
                }
                limit   = parseInt(args[0]);
                action  = args[1];
                enabled = args[2] !== 'off';
            }

            if (isNaN(limit) || limit < 1 || limit > 20 || !['1','2','3'].includes(String(action))) {
                const msg = lang === 'en' ? 'Invalid arguments.' : 'مدخلات غير صحيحة.';
                return sendResponse(interactionOrMessage, isSlash, msg);
            }

            // ── Save per-guild ─────────────────────────────────────────────────
            saveProtection(guildId, {
                [CMD]: { enabled, limit, action: String(action) }
            });

            // ── Log ────────────────────────────────────────────────────────────
            const moderator = interactionOrMessage.user || interactionOrMessage.author;
            await logSystem.logCommandUsage({
                interaction: interactionOrMessage,
                commandName: CMD,
                moderator,
                target: moderator,
                reason: `[${lang.toUpperCase()}] anti_ban → limit:${limit} action:${action} enabled:${enabled}`,
                action: CMD
            }).catch(() => {});

            // ── Embed response ─────────────────────────────────────────────────
            const embed = buildEmbed({
                guildId,
                protectionKey: CMD,
                titleAr: 'منع الحظر الجماعي',
                titleEn: 'Anti Mass-Ban',
                enabled,
                limit,
                action: String(action),
                lang
            });

            return sendResponse(interactionOrMessage, isSlash, embed);

        } catch (err) {
            console.error(`[${CMD}] Error:`, err);
            return sendResponse(interactionOrMessage, isSlash, i18n[lang].error);
        }
    }
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */