'use strict';

/**
 * component_interactions — Action pipeline executor for ComponentMessage automations.
 *
 * When a Discord user clicks a button or picks a select-menu option that belongs
 * to a ComponentMessage, this system:
 *   1. Looks up the document via the componentIds index (O(1)).
 *   2. Resolves which state is currently active for this user/message.
 *   3. Finds the matching ActionPipeline for the clicked customId.
 *   4. Evaluates every conditional rule group and executes its steps.
 *   5. Handles state transitions, role changes, replies, DMs, etc.
 *
 * State tracking strategy:
 *   • multiUser = false  → shared `activeStateId` stored in the DB document.
 *   • multiUser = true   → per-user state in an in-memory Map (ephemeral but fast).
 */

const logger = require('../utils/logger');

// Per-user state: `${guildId}:${messageId}:${userId}` → stateId
const _userStates   = new Map();
const MAX_MAP_SIZE  = 25_000;

module.exports = {
    name: 'component_interactions',

    execute(client) {
        client.on('interactionCreate', async (interaction) => {
            if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
            if (!interaction.guildId) return;

            const customId  = interaction.customId;
            const guildId   = interaction.guildId;
            const messageId = interaction.message?.id;

            try {
                const ComponentMessage   = require('./schemas/ComponentMessage');
                const { buildComponentPayload } = require('../dashboard/utils/componentBuilder');

                // Fast lookup via componentIds index
                const doc = await ComponentMessage.findOne({ guildId, componentIds: customId }).lean();
                if (!doc) return; // not our component

                // Resolve active state
                const states = doc.states?.length
                    ? doc.states
                    : [{ id: 'legacy', content: doc.content, components: doc.components, actions: doc.actions || [] }];

                let currentStateId;
                if (doc.multiUser) {
                    const key = `${guildId}:${messageId}:${interaction.user.id}`;
                    currentStateId = _userStates.get(key) || doc.initialStateId || states[0]?.id;
                } else {
                    currentStateId = doc.activeStateId || doc.initialStateId || states[0]?.id;
                }

                const currentState = states.find(s => s.id === currentStateId) || states[0];
                if (!currentState) return;

                // For select menus try compound key `menuCustomId:selectedValue` first
                let actionKey = customId;
                if (interaction.isStringSelectMenu() && interaction.values?.length) {
                    const compound = `${customId}:${interaction.values[0]}`;
                    if (currentState.actions?.find(a => a.customId === compound)) actionKey = compound;
                }

                const pipeline = currentState.actions?.find(a => a.customId === actionKey);
                if (!pipeline) return; // no action configured → ignore silently

                // Normalise rules (new format) vs legacy steps
                const rules = pipeline.rules?.length
                    ? pipeline.rules
                    : (pipeline.steps?.length
                        ? [{ id: 'leg', conditions: [], conditionOp: 'AND', steps: pipeline.steps }]
                        : []);
                if (!rules.length) return;

                // Acknowledge the interaction so Discord doesn't time out
                await interaction.deferUpdate().catch(() => null);

                let nextStateId = null;

                for (const rule of rules) {
                    if (!_evalConditions(rule.conditions, rule.conditionOp, interaction)) continue;

                    for (const step of (rule.steps || [])) {
                        try {
                            const result = await _executeStep(step, interaction, doc, states);
                            if (result) nextStateId = result; // edit_message returns target stateId
                        } catch (stepErr) {
                            logger.warn('component_interactions: step failed', {
                                type: step.type, error: stepErr.message, guildId, customId,
                            });
                        }
                    }
                    break; // first matching rule wins
                }

                // Apply state transition if signalled by an edit_message step
                if (nextStateId) {
                    const nextState = states.find(s => s.id === nextStateId);
                    if (nextState) {
                        const payload = buildComponentPayload({
                            content:    nextState.content,
                            components: nextState.components,
                        });
                        await interaction.editReply(payload).catch(() => null);

                        if (doc.multiUser) {
                            const key = `${guildId}:${messageId}:${interaction.user.id}`;
                            _userStates.set(key, nextStateId);
                            // Evict oldest entry to cap memory usage
                            if (_userStates.size > MAX_MAP_SIZE) {
                                _userStates.delete(_userStates.keys().next().value);
                            }
                        } else {
                            await ComponentMessage.findByIdAndUpdate(doc._id, { activeStateId: nextStateId });
                        }
                    }
                }

                // ── AutomationLink: fire cross-message links after pipeline ──
                try {
                    const AutomationLink = require('./schemas/AutomationLink');
                    const links = await AutomationLink.find({
                        guildId, sourceKind: 'component', sourceId: doc._id.toString(), enabled: true,
                    }).lean();
                    for (const link of links) {
                        if (link.sourceButtonId && link.sourceButtonId !== customId) continue;
                        await _executeAutoLink(interaction, link);
                    }
                } catch (linkErr) {
                    logger.warn('component_interactions: AutomationLink error', { error: linkErr.message });
                }

            } catch (err) {
                logger.error('component_interactions: unhandled error', {
                    error: err.message, guildId, customId,
                });
                interaction.followUp?.({ content: '❌ An error occurred while processing this interaction.', ephemeral: true })
                    .catch(() => null);
            }
        });
    },
};

// ═══════════════════════════════════════════════════════════════════════════
// CONDITION EVALUATOR
// ═══════════════════════════════════════════════════════════════════════════

function _evalConditions(conditions, op, interaction) {
    if (!conditions?.length) return true;
    const results = conditions.map(c => {
        switch (c.type) {
            case 'has_role':     return !!interaction.member?.roles?.cache?.has(c.value);
            case 'not_has_role': return !interaction.member?.roles?.cache?.has(c.value);
            case 'is_user':      return interaction.user.id === c.value;
            case 'not_user':     return interaction.user.id !== c.value;
            case 'in_channel':   return interaction.channelId === c.value;
            default:             return true;
        }
    });
    return op === 'OR' ? results.some(Boolean) : results.every(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP EXECUTOR
// Returns a stateId string if the step signals a state transition, else null.
// ═══════════════════════════════════════════════════════════════════════════

async function _executeStep(step, interaction, doc, states) {
    const tpl = s => _tpl(s, interaction);

    switch (step.type) {
        case 'reply': {
            await interaction.followUp({
                content:   tpl(step.content || '\u200b'),
                ephemeral: step.ephemeral !== false,
            }).catch(() => null);
            break;
        }

        case 'send_dm': {
            await interaction.user.send({ content: tpl(step.content || '') }).catch(() => null);
            break;
        }

        case 'send_to_channel': {
            if (!step.channelId) break;
            const ch = interaction.guild?.channels?.cache?.get(step.channelId)
                ?? await interaction.client.channels.fetch(step.channelId).catch(() => null);
            if (ch?.isTextBased?.()) {
                await ch.send({ content: tpl(step.content || '') }).catch(() => null);
            }
            break;
        }

        case 'add_role': {
            if (step.roleId && interaction.member && !interaction.member.roles.cache.has(step.roleId)) {
                await interaction.member.roles.add(step.roleId).catch(() => null);
            }
            break;
        }

        case 'remove_role': {
            if (step.roleId && interaction.member && interaction.member.roles.cache.has(step.roleId)) {
                await interaction.member.roles.remove(step.roleId).catch(() => null);
            }
            break;
        }

        case 'toggle_role': {
            if (step.roleId && interaction.member) {
                const has = interaction.member.roles.cache.has(step.roleId);
                await (has
                    ? interaction.member.roles.remove(step.roleId)
                    : interaction.member.roles.add(step.roleId)
                ).catch(() => null);
            }
            break;
        }

        case 'edit_message': {
            // targetId = the id of the state to transition to
            if (step.targetId) return step.targetId;
            break;
        }

        case 'disable_component': {
            if (step.targetId) {
                const comps = _patchDisabled(interaction.message?.components, step.targetId, true);
                await interaction.editReply({ components: comps }).catch(() => null);
            }
            break;
        }

        case 'enable_component': {
            if (step.targetId) {
                const comps = _patchDisabled(interaction.message?.components, step.targetId, false);
                await interaction.editReply({ components: comps }).catch(() => null);
            }
            break;
        }
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// TEMPLATE ENGINE  —  {user} {username} {server} {channel}
// ═══════════════════════════════════════════════════════════════════════════

function _tpl(text, interaction) {
    return (text || '')
        .replace(/\{user(?:\.mention)?\}/gi, `<@${interaction.user.id}>`)
        .replace(/\{user\.id\}/gi,           interaction.user.id)
        .replace(/\{username\}/gi,           interaction.user.username)
        .replace(/\{server(?:\.name)?\}/gi,  interaction.guild?.name || '')
        .replace(/\{channel(?:\.mention)?\}/gi, `<#${interaction.channelId}>`);
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPONENT PATCH  —  toggle disabled on a component by customId
// ═══════════════════════════════════════════════════════════════════════════

function _patchDisabled(rows, targetId, disabled) {
    if (!rows) return [];
    return rows.map(row => {
        const r = row.toJSON?.() ?? { ...row };
        r.components = (r.components || []).map(comp => {
            const c = comp.toJSON?.() ?? { ...comp };
            if ((c.custom_id ?? c.customId) === targetId) c.disabled = disabled;
            return c;
        });
        return r;
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTOMATION LINK EXECUTOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fire an AutomationLink: send the target message in response to a source
 * component interaction having just completed its pipeline.
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {object} link  AutomationLink lean document
 */
async function _executeAutoLink(interaction, link) {
    try {
        if (link.targetKind === 'component') {
            const CompMsg = require('./schemas/ComponentMessage');
            const { buildComponentPayload } = require('../dashboard/utils/componentBuilder');
            const target = await CompMsg.findById(link.targetId).lean();
            if (!target) return;
            const initState = target.states?.find(s => s.id === target.initialStateId) || target.states?.[0];
            const payload = buildComponentPayload({
                content:    initState?.content    ?? target.content    ?? '',
                components: initState?.components ?? target.components ?? [],
            });
            if (link.sendMode === 'reply' || link.sendMode === 'reply_ephemeral') {
                await interaction.followUp({ ...payload, ephemeral: link.sendMode === 'reply_ephemeral' }).catch(() => null);
            } else if (link.sendMode === 'new_message') {
                await interaction.channel?.send(payload).catch(() => null);
            } else if (link.sendMode === 'update_message') {
                await interaction.editReply(payload).catch(() => null);
            } else {
                await interaction.followUp(payload).catch(() => null);
            }
        } else if (link.targetKind === 'embed') {
            const EmbMsg = require('./schemas/EmbedMessage');
            const { buildDiscordPayload } = require('../dashboard/utils/embedBuilder');
            const target = await EmbMsg.findById(link.targetId).lean();
            if (!target) return;
            const machine     = target.machine;
            const initStateId = machine?.initial;
            const initState   = machine?.states?.[initStateId];
            if (!initState) return;
            const payload = buildDiscordPayload({
                embeds:     initState.embeds     || [],
                components: initState.components || [],
            });
            if (link.sendMode === 'reply' || link.sendMode === 'reply_ephemeral') {
                await interaction.followUp({ ...payload, ephemeral: link.sendMode === 'reply_ephemeral' }).catch(() => null);
            } else if (link.sendMode === 'new_message') {
                await interaction.channel?.send(payload).catch(() => null);
            } else if (link.sendMode === 'update_message') {
                await interaction.editReply(payload).catch(() => null);
            } else {
                await interaction.followUp(payload).catch(() => null);
            }
        }
    } catch (e) {
        logger.warn('component_interactions: _executeAutoLink failed:', {
            error: e.message, targetId: link.targetId, targetKind: link.targetKind,
        });
    }
}

