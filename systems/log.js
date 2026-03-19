/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const { EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const settingsPath = path.join(__dirname, '../settings.json');

function getSettings() {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

module.exports = {
    name: 'log',
    
    execute(client) {
        console.log('[system] Log system loaded');
    },
    
    createLogEmbed({ action, target, reason, moderator, color, emoji, courtName, date }) {
        const settings = getSettings();
        const actionLabel = settings.actions[action.toLowerCase()]?.label || action;
        const embedColor = color || settings.actions[action.toLowerCase()]?.color || settings.court.color;
        const actionEmoji = emoji || settings.actions[action.toLowerCase()]?.emoji || '⚖️';
        
        const embed = new EmbedBuilder()
            .setColor(embedColor)
            .setTitle(`${actionEmoji} [${actionLabel}] — ${target.username}`)
            .setDescription(
                `**السبب:** ${reason}\n` +
                `**الإداري:** ${moderator.username}\n` +
                `**المحكمة:** ${courtName}\n` +
                `**التاريخ:** ${date}`
            )
            .setThumbnail(target.displayAvatarURL({ forceStatic: false }))
            .setFooter({
                text: `Court System • ${settings.court.name}`,
                iconURL: settings.court.logo || moderator.displayAvatarURL({ forceStatic: false })
            })
            .setTimestamp();
            
        return embed;
    },

    async logCommandUsage({ interaction, commandName, moderator, target, reason, action }) {
        try {
            const settings = getSettings();
            const logChannelId = settings.court?.logChannel;
            if (!logChannelId) return;

            const logChannel = interaction.guild?.channels.cache.get(logChannelId);
            if (!logChannel) return;

            const now = new Date();
            const date = now.toLocaleString('en-US', {
                year: 'numeric',
                month: 'numeric',
                day: 'numeric',
                hour: 'numeric',
                minute: 'numeric',
                second: 'numeric'
            });

            const commandConfig = settings.actions[commandName];
            const actionToUse = action || commandName;
            const targetToUse = target || moderator;
            const reasonToUse = reason || 'تعديل إعدادات';

            const embed = this.createLogEmbed({
                action: actionToUse,
                target: targetToUse,
                reason: reasonToUse,
                moderator: moderator,
                color: commandConfig?.color,
                emoji: commandConfig?.emoji,
                courtName: settings.court.name,
                date: date
            });

            await logChannel.send({ embeds: [embed] });
        } catch (error) {
            console.error('Error logging command usage:', error);
        }
    }
};

/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */