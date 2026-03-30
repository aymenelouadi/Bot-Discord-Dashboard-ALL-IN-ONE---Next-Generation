'use strict';

/**
 * component_auto_channel — fires saved ComponentMessage automations
 * when a new text channel is created inside a watched category.
 *
 * Trigger type: "on_channel_create"
 * Required param: categoryId  (the Discord category ID to watch)
 */

const logger = require('../utils/logger');

module.exports = {
    name: 'component_auto_channel',

    execute(client) {
        client.on('channelCreate', async (channel) => {
            // Only care about text channels (type 0) that belong to a category
            if (channel.type !== 0 || !channel.parentId) return;

            const guildId = channel.guild?.id;
            if (!guildId) return;

            try {
                const ComponentMessage = require('./schemas/ComponentMessage');
                const { buildComponentPayload } = require('../dashboard/utils/componentBuilder');

                // Find all automations for this guild that have an on_channel_create
                // trigger targeting this channel's parent category
                const docs = await ComponentMessage.find({
                    guildId,
                    'triggers.type': 'on_channel_create',
                }).lean();

                if (!docs.length) return;

                for (const doc of docs) {
                    const trigger = doc.triggers.find(
                        t => t.type === 'on_channel_create' &&
                             t.params?.categoryId === channel.parentId
                    );
                    if (!trigger) continue;

                    try {
                        const payload = buildComponentPayload({
                            content: doc.content,
                            components: doc.components,
                        });

                        if (!payload.components.length && !payload.content) continue;

                        const sent = await channel.send(payload);

                        // Log the send so the dashboard can show it
                        await ComponentMessage.findByIdAndUpdate(doc._id, {
                            $push: {
                                sentLog: {
                                    channelId: channel.id,
                                    messageId: sent.id,
                                    sentAt: new Date(),
                                },
                            },
                        });

                        logger.discord(
                            `component_auto_channel: sent automation "${doc.name}" to new channel #${channel.name}`,
                            { guildId, channelId: channel.id, docId: String(doc._id) }
                        );
                    } catch (sendErr) {
                        logger.error('component_auto_channel: send failed', {
                            guildId, channelId: channel.id, docId: String(doc._id),
                            error: sendErr.message,
                        });
                    }
                }
            } catch (err) {
                logger.error('component_auto_channel: query failed', {
                    guildId, error: err.message,
                });
            }
        });
    },
};
