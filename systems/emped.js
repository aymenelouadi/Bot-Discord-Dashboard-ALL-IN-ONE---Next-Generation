/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

/**
 * systems/emped.js  —  XState Flow Engine for Embed Messages
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Architecture
 * ─────────────
 *  Each EmbedMessage document stored in MongoDB contains a `machine` field
 *  that is a full XState v4-compatible state machine definition:
 *
 *    machine = {
 *      initial: 'state_0',
 *      states: {
 *        'state_0': {
 *          id, label, color, position,
 *          embeds: [...],
 *          components: [...],
 *          on: {
 *            'btn_customId': { target: 'state_1', actions: ['update_content'] },
 *            'opt_customId': { target: 'state_2', actions: ['send_ephemeral'] },
 *          }
 *        },
 *        'state_1': { ... }
 *      }
 *    }
 *
 *  When a user interacts with a Discord button or select menu:
 *    1. Lookup EmbedMessage by guildId + componentIds index.
 *    2. Read the current state for this Discord message (instanceStates map).
 *    3. Feed the customId event into the XState machine via machine.transition().
 *    4. Retrieve target state + actions from the transition result.
 *    5. Execute each action (edit message, send ephemeral, disable button, etc.).
 *    6. Persist the new state ID back into instanceStates.
 *
 * XState usage
 * ─────────────
 *  We use createMachine() + machine.transition() for pure, stateless computation.
 *  No persistent interpreter / service is kept in memory — every interaction
 *  is a fresh, synchronous transition call.
 *
 * Supported Actions
 * ─────────────────
 *  update_content    → edit the message with the target state's embeds & components
 *  replace_embeds    → replace only the embeds, keep existing components
 *  append_embeds     → prepend initial-state embeds + target state embeds
 *  update_components → replace only the components, keep existing embeds
 *  disable_component → disable the clicked button before editing
 *  send_ephemeral    → send a private ephemeral reply (does NOT edit original msg)
 */

'use strict';

const { MessageFlags,
        ChannelType,
        ActionRowBuilder,
        ButtonBuilder,
        ButtonStyle }         = require('discord.js');
const logger                  = require('../utils/logger');
const EmbedMessage            = require('./schemas/EmbedMessage');
const { buildDiscordPayload } = require('../dashboard/utils/embedBuilder');
const {
    executeRoleAction,
    evalBranchConditions,
    restoreTempRoles,
    grantXP,
    resolveTemplate,
}                             = require('./role_automation');

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Compute the next state from a machine definition, current state, and event.
 *
 * Pure JS lookup — no XState runtime needed since we handle actions ourselves.
 *
 * @param {object} machineDef
 * @param {string} currentStateId
 * @param {string} eventId  customId of the triggering component
 * @returns {{ targetStateId: string, actions: string[] } | null}
 */
function _computeTransition(machineDef, currentStateId, eventId) {
    const tr = machineDef.states?.[currentStateId]?.on?.[eventId];
    if (!tr) return null;

    // Allow empty/missing target to mean "stay on current state" (self-loop)
    const targetStateId = tr.target || currentStateId;

    if (!machineDef.states?.[targetStateId]) {
        logger.warn('[emped] Transition target state not found', {
            from:        currentStateId,
            event:       eventId,
            target:      targetStateId,
            knownStates: Object.keys(machineDef.states || {}),
        });
        return null;
    }

    return { targetStateId, actions: tr.actions || [] };
}

/**
 * For a StringSelectMenu interaction, resolve which XState event to fire.
 *
 * Discord gives us:
 *   interaction.customId  → the select menu's customId
 *   interaction.values[0] → the chosen option's `value` field
 *
 * We need to:
 *   1. Find the state that owns this select menu (by matching select.customId).
 *   2. Find the option whose `value === selectedValue`.
 *   3. Return that option's `customId` — which is the XState event name.
 *
 * @param {object} machineDef
 * @param {string} menuCustomId
 * @param {string} selectedValue
 * @returns {{ stateId: string, eventId: string } | null}
 */
function _resolveSelectEvent(machineDef, menuCustomId, selectedValue) {
    for (const [stateId, s] of Object.entries(machineDef.states || {})) {
        for (const row of (s.components || [])) {
            if (row.type !== 'select') continue;
            if (row.select?.customId !== menuCustomId) continue;

            const opt = (row.select.options || []).find(o => o.value === selectedValue);
            if (opt?.customId) return { stateId, eventId: opt.customId };
        }
    }
    return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// PIPELINE HELPERS
// ═════════════════════════════════════════════════════════════════════════════

/** Wait N milliseconds. */
const _sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms || 0)));

/** Normalize raw action array: strings → { type } objects (backward compat). */
function _normalizeActions(raw) {
    return (raw || []).map(a => (typeof a === 'string' ? { type: a } : a));
}

/** Immutably patch a button's properties inside a components-rows array. */
function _mutateBtn(components, customId, patch) {
    return components.map(row => {
        if (row.type !== 'buttons') return row;
        const btns = row.buttons || [];
        if (!btns.some(b => b.customId === customId)) return row;
        return { ...row, buttons: btns.map(b => b.customId === customId ? { ...b, ...patch } : b) };
    });
}

/** Remove a component (button or whole select row) by customId. Drops empty button rows. */
function _removeComponent(components, customId) {
    return components.map(row => {
        if (row.type === 'buttons') {
            const filtered = (row.buttons || []).filter(b => b.customId !== customId);
            return filtered.length ? { ...row, buttons: filtered } : null;
        }
        if (row.type === 'select' && row.select?.customId === customId) return null;
        return row;
    }).filter(Boolean);
}

/** Action types that write to the Discord message (used to decide default dirty flag). */
// open_dm and open_channel_flow send to a NEW context — they do NOT dirty the original message.
const CONTENT_ACTION_TYPES = new Set([
    'update_content', 'replace_embeds', 'append_embeds', 'update_components',
    'disable_component', 'enable_component', 'hide_component',
]);

/** Per-user cooldown tracker. key = `${docId}:${stateId}:${userId}` → timestamp ms */
const _cooldownMap = new Map();

// ═════════════════════════════════════════════════════════════════════════════
// FLOW CONTEXT STORE  —  Cross-Context (DM / Channel) Flow Tracking
// ═════════════════════════════════════════════════════════════════════════════

/**
 * In-memory registry of every active DM or channel-forwarded flow.
 *
 * Key:   Discord message ID of the forwarded message (string)
 * Value: {
 *   docId:        string          — EmbedMessage._id
 *   guildId:      string | null   — origin guild (null if flow started from DM)
 *   channelId:    string | null   — origin channel (where the trigger button was clicked)
 *   originMsgId:  string | null   — Discord message ID of the triggering message
 *   userId:       string          — user who triggered open_dm / open_channel_flow
 *   returnActions: object[]       — pipeline executed in origin context on complete_flow
 *   timer:        Timeout | null  — auto-expire handle
 * }
 *
 * Contexts are session-scoped (lost on bot restart — acceptable for interactive flows).
 */
const _flowContexts = new Map();

/**
 * Register a new flow context; automatically expires after `timeoutMs`.
 * @param {string} forwardedMsgId  Discord message ID of the sent DM / channel message
 * @param {object} ctx             Context payload (see above)
 * @param {number} timeoutMs       0 = no expiry; default 10 minutes
 */
function _registerFlowContext(forwardedMsgId, ctx, timeoutMs = 10 * 60_000) {
    const existing = _flowContexts.get(forwardedMsgId);
    if (existing?.timer) clearTimeout(existing.timer);
    const timer = timeoutMs > 0
        ? setTimeout(() => _flowContexts.delete(forwardedMsgId), timeoutMs)
        : null;
    _flowContexts.set(forwardedMsgId, { ...ctx, timer });
}

/**
 * Release a flow context and cancel its expiry timer.
 * Called automatically by `complete_flow`.
 */
function _releaseFlowContext(forwardedMsgId) {
    const ctx = _flowContexts.get(forwardedMsgId);
    if (ctx?.timer) clearTimeout(ctx.timer);
    _flowContexts.delete(forwardedMsgId);
}

/**
 * Parse the simple `returnAction` / `returnRoleId` shorthand fields,
 * OR a fully-formed `returnActions` array, into a normalised action array.
 * This lets the dashboard store a single returnAction without a nested editor.
 */
function _parseReturnActions(action) {
    // Fully-formed array takes priority
    if (Array.isArray(action.returnActions) && action.returnActions.length)
        return action.returnActions;
    // JSON string fallback (power users can paste raw JSON in the text field)
    if (typeof action.returnActions === 'string' && action.returnActions.trim().startsWith('[')) {
        try { return JSON.parse(action.returnActions); } catch { /* ignore */ }
    }
    // Simple shorthand: single action type + optional role
    if (action.returnAction) {
        const a = { type: action.returnAction };
        if (action.returnRoleId) a.roleId = action.returnRoleId;
        if (action.returnChannelId) a.channelId = action.returnChannelId;
        return [a];
    }
    return [];
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION EXECUTOR  —  Unlimited Automation Pipeline
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Execute the automation pipeline for a resolved transition.
 *
 * Each action is { type, ...params } (strings are normalized for compat).
 *
 * Supported action types:
 *   update_content       Replace embeds + components with target state (default)
 *   replace_embeds       Replace only embeds, keep components
 *   append_embeds        Prepend initial-state embeds + target embeds
 *   update_components    Replace only components, keep embeds
 *   disable_component    { customId? }              Disable clicked or specific button
 *   enable_component     { customId }               Enable a specific button
 *   hide_component       { customId, duration? }    Hide component; restore after `duration` ms
 *   send_ephemeral                                  Send ephemeral followUp with target state embeds
 *   send_to_channel      { channelId }              Send target embeds to another channel
 *   open_dm              { confirmMessage?, failMessage?, timeout?, returnAction?, returnRoleId?, returnChannelId? }
 *   open_channel_flow    { channelId, mention?, timeout?, returnAction?, returnRoleId? }
 *   add_role             { roleId }                 Add a role (simple)
 *   remove_role          { roleId }                 Remove a role (simple)
 *   role_toggle          { roleId, conditions?, abuse? }       Toggle on↔off
 *   role_exclusive       { roleId, groupRoles[], conditions?, abuse? } Mutual exclusion
 *   role_temp            { roleId, duration, conditions?, abuse? }     Timed role
 *   role_conditional     { roleId, operator, conditions, abuse? }      Conditional op
 *   role_check_branch    { thenTarget, elseTarget, hasRole?, minLevel?, conditions? }
 *   grant_xp             { xp, track: 'text'|'voice' }         Award XP
 *   send_dm_message                                 One-shot DM with target state (no flow tracking)
 *   send_to_origin                                  Send target state to origin channel (from DM/channel flow)
 *   edit_origin_message                             Edit the original guild message to show target state
 *   complete_flow                                   Mark flow complete; fire returnActions in origin guild
 *   delay                { ms }                     Wait N ms (flushes pending edit first)
 */

/**
 * Check per-state permissions before executing a transition.
 *
 * Reads `state.permissions = { allowedRoles, cooldown, denyMessage }` from the
 * current state definition.  Flexible — works for any interaction type.
 *
 * @returns {boolean}  true = allowed, false = blocked (already replied to user)
 */
async function _checkPermissions(interaction, doc, currentStateId) {
    const perms = doc.machine?.states?.[currentStateId]?.permissions;
    if (!perms) return true;

    const userId = interaction.user?.id;

    // ── Role check ──────────────────────────────────────────────────────────
    // Skip role check in DM context — member object is unavailable there.
    if (perms.allowedRoles?.length && interaction.guildId) {
        const hasRole = interaction.member?.roles?.cache?.some(
            r => perms.allowedRoles.includes(r.id)
        );
        if (!hasRole) {
            const msg = perms.denyMessage?.trim() || '🚫 You do not have permission to use this.';
            if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
            await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
            return false;
        }
    }

    // ── Cooldown check ───────────────────────────────────────────────────────
    if (perms.cooldown > 0 && userId) {
        const key   = `${doc._id}:${currentStateId}:${userId}`;
        const last  = _cooldownMap.get(key) || 0;
        const now   = Date.now();
        const elapsed = (now - last) / 1000;
        if (elapsed < perms.cooldown) {
            const remaining = Math.ceil(perms.cooldown - elapsed);
            const msg = perms.denyMessage?.trim()
                || `⏳ Please wait **${remaining}s** before using this again.`;
            if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
            await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
            return false;
        }
        _cooldownMap.set(key, now);
        setTimeout(() => _cooldownMap.delete(key), perms.cooldown * 1000 + 500);
    }

    return true;
}

async function _execute(interaction, doc, currentStateId, targetStateId, rawActions, flowCtx = null) {
    const machineDef   = doc.machine;
    const initialState = machineDef.states[machineDef.initial] || {};
    const targetState  = machineDef.states[targetStateId];
    if (!targetState) return;

    const actions   = _normalizeActions(rawActions);
    const clickedId = interaction.isButton() ? interaction.customId : null;

    // ACK Discord immediately — always deferUpdate so followUp still works for ephemeral
    if (!interaction.deferred && !interaction.replied)
        await interaction.deferUpdate();

    // Helper: ephemeral messages must be edited via editReply(), not message.edit()
    const _isEphemeral = () => interaction.message?.flags?.has?.(MessageFlags.Ephemeral);
    const _editMsg = p => _isEphemeral() ? interaction.editReply(p) : interaction.message.edit(p);

    // Default context: target state's full content
    const ctx = {
        embeds:     [...(targetState.embeds     || [])],
        components: [...(targetState.components || [])],
        dirty:      actions.some(a => CONTENT_ACTION_TYPES.has(a.type)),
    };

    const restoreSchedules = []; // { ms, docId, channelId, msgId }

    // ── Process each step in the pipeline ────────────────────────────────────
    for (const action of actions) {
        switch (action.type) {

            case 'update_content':
                ctx.embeds     = [...(targetState.embeds     || [])];
                ctx.components = [...(targetState.components || [])];
                ctx.dirty = true;
                break;

            case 'replace_embeds':
                ctx.embeds = [...(targetState.embeds || [])];
                ctx.dirty  = true;
                break;

            case 'append_embeds':
                ctx.embeds = [...(initialState.embeds || []), ...(targetState.embeds || [])];
                ctx.dirty  = true;
                break;

            case 'update_components':
                ctx.components = [...(targetState.components || [])];
                ctx.dirty      = true;
                break;

            case 'disable_component': {
                const cid = action.customId || clickedId;
                if (cid) { ctx.components = _mutateBtn(ctx.components, cid, { disabled: true }); ctx.dirty = true; }
                break;
            }

            case 'enable_component':
                if (action.customId) { ctx.components = _mutateBtn(ctx.components, action.customId, { disabled: false }); ctx.dirty = true; }
                break;

            case 'hide_component': {
                if (!action.customId) break;
                ctx.components = _removeComponent(ctx.components, action.customId);
                ctx.dirty = true;
                if (Number(action.duration) > 0) {
                    restoreSchedules.push({
                        ms:        Number(action.duration),
                        docId:     doc._id,
                        channelId: doc.channelId,
                        msgId:     interaction.message?.id,
                        userId:    interaction.user?.id,
                    });
                }
                break;
            }

            case 'send_ephemeral': {
                const ePayload = buildDiscordPayload({
                    embeds:     targetState.embeds     || [],
                    components: targetState.components || [],
                });
                await interaction.followUp({
                    ...(ePayload.embeds?.length ? ePayload : { content: '(No content configured)' }),
                    flags: MessageFlags.Ephemeral,
                }).catch(e => logger.warn('[emped] followUp failed:', { error: e?.message }));
                break;
            }

            case 'send_to_channel': {
                if (!action.channelId) break;
                const ch = await interaction.client.channels.fetch(action.channelId).catch(() => null);
                if (ch) {
                    const chPayload = buildDiscordPayload({
                        embeds:     targetState.embeds     || [],
                        components: targetState.components || [],
                    });
                    await ch.send(chPayload).catch(e => logger.warn('[emped] send_to_channel failed:', { error: e?.message }));
                }
                break;
            }

            // ── Open DM Flow ──────────────────────────────────────────────────
            // Sends target state to the user's DM and tracks the DM message so
            // button/select interactions inside the DM continue the same flow.
            // On complete_flow the stored returnActions fire back in the guild.
            case 'open_dm': {
                const dmUserId  = interaction.user?.id;
                const dmUser    = dmUserId
                    ? await interaction.client.users.fetch(dmUserId).catch(() => null)
                    : null;
                if (!dmUser) break;
                const dmPayload = buildDiscordPayload({
                    embeds:     targetState.embeds     || [],
                    components: targetState.components || [],
                });
                try {
                    const dmMsg = await dmUser.send(dmPayload);
                    // Track DM message state so DM interactions can look up this doc
                    EmbedMessage.updateOne(
                        { _id: doc._id },
                        { $set: { [`instanceStates.${dmMsg.id}`]: targetStateId } }
                    ).catch(e => logger.warn('[emped] open_dm state save failed:', { error: e?.message }));
                    // Store rich flow context so origin-aware actions work in DM
                    _registerFlowContext(dmMsg.id, {
                        docId:        String(doc._id),
                        guildId:      interaction.guildId   || null,
                        channelId:    interaction.channelId || null,
                        originMsgId:  interaction.message?.id || null,
                        userId:       dmUserId,
                        returnActions: _parseReturnActions(action),
                    }, Number(action.timeout) > 0 ? Number(action.timeout) : 10 * 60_000);
                    // Ephemeral confirmation in the originating channel
                    const confirmText = action.confirmMessage?.trim() || '📬 Check your DMs to continue!';
                    await interaction.followUp({ content: confirmText, flags: MessageFlags.Ephemeral }).catch(() => {});
                } catch (e) {
                    if (e.code === 50007) {
                        // User has DMs disabled
                        const failText = action.failMessage?.trim() || '❌ Could not send you a DM. Please enable DMs from server members first.';
                        await interaction.followUp({ content: failText, flags: MessageFlags.Ephemeral }).catch(() => {});
                    } else {
                        logger.warn('[emped] open_dm failed:', { error: e?.message });
                    }
                }
                break;
            }

            // ── Open Channel Flow ─────────────────────────────────────────────
            // Sends target state to a specific channel (with user mention) and
            // tracks the new message so interactions there continue the same flow.
            // On complete_flow the stored returnActions fire back in the origin.
            case 'open_channel_flow': {
                if (!action.channelId) {
                    logger.warn('[emped] open_channel_flow: no channelId configured');
                    break;
                }
                const flowCh = await interaction.client.channels.fetch(action.channelId).catch(() => null);
                if (!flowCh) {
                    logger.warn('[emped] open_channel_flow: channel not found', { channelId: action.channelId });
                    break;
                }
                const flowPayload = buildDiscordPayload({
                    embeds:     targetState.embeds     || [],
                    components: targetState.components || [],
                });
                // Optionally mention the user so they know where to continue
                if (action.mention !== 'no' && interaction.user?.id)
                    flowPayload.content = `<@${interaction.user.id}>`;
                const flowMsg = await flowCh.send(flowPayload)
                    .catch(e => { logger.warn('[emped] open_channel_flow send failed:', { error: e?.message }); return null; });
                if (flowMsg) {
                    EmbedMessage.updateOne(
                        { _id: doc._id },
                        { $set: { [`instanceStates.${flowMsg.id}`]: targetStateId } }
                    ).catch(e => logger.warn('[emped] open_channel_flow state save failed:', { error: e?.message }));
                    // Store flow context for origin-aware return actions
                    _registerFlowContext(flowMsg.id, {
                        docId:        String(doc._id),
                        guildId:      interaction.guildId   || null,
                        channelId:    interaction.channelId || null,
                        originMsgId:  interaction.message?.id || null,
                        userId:       interaction.user?.id  || null,
                        returnActions: _parseReturnActions(action),
                    }, Number(action.timeout) > 0 ? Number(action.timeout) : 10 * 60_000);
                }
                break;
            }

            // ── Add / Remove Role (works in guild and from DM with flowCtx) ───────
            case 'add_role': {
                if (!action.roleId) break;
                const _gId = interaction.guildId || flowCtx?.guildId;
                const _uId = interaction.user?.id  || flowCtx?.userId;
                if (!_gId || !_uId) break;
                const _guild  = await interaction.client.guilds.fetch(_gId).catch(() => null);
                const _member = _guild && await _guild.members.fetch(_uId).catch(() => null);
                if (_member)
                    await _member.roles.add(action.roleId)
                        .catch(e => logger.warn('[emped] add_role failed:', { error: e?.message }));
                break;
            }

            case 'remove_role': {
                if (!action.roleId) break;
                const _gId = interaction.guildId || flowCtx?.guildId;
                const _uId = interaction.user?.id  || flowCtx?.userId;
                if (!_gId || !_uId) break;
                const _guild  = await interaction.client.guilds.fetch(_gId).catch(() => null);
                const _member = _guild && await _guild.members.fetch(_uId).catch(() => null);
                if (_member)
                    await _member.roles.remove(action.roleId)
                        .catch(e => logger.warn('[emped] remove_role failed:', { error: e?.message }));
                break;
            }

            // ── Advanced Role Automation  (via role_automation.js engine) ─────────────
            // All of these support: conditions, anti-abuse, denyMessage

            case 'role_toggle':
            case 'role_exclusive':
            case 'role_temp':
            case 'role_conditional':
            case 'role_sequence':
            case 'fire_webhook': {
                const raResult = await executeRoleAction(
                    interaction.client, interaction, action, doc, flowCtx
                );
                // role_toggle: smart added/removed feedback with template vars
                if (action.type === 'role_toggle' && action.feedbackMessage && raResult.granted) {
                    const added = !raResult.had;
                    const rawMsg = added
                        ? (action.addedMessage?.trim()   || action.feedbackMessage)
                        : (action.removedMessage?.trim() || action.feedbackMessage);
                    // Build a minimal ctx so {{member.mention}} etc. work in feedback
                    const _uid = interaction.user?.id;
                    const _ctx = { member: { id: _uid, mention: `<@${_uid}>`, tag: interaction.user?.tag || '', username: interaction.user?.username || '' }, result: raResult };
                    if (rawMsg) await interaction.followUp({ content: resolveTemplate(rawMsg, _ctx), flags: 64 }).catch(() => {});
                }
                // role_temp: expiry feedback with [expiry] and {{result.expiresAt}} support
                if (action.type === 'role_temp' && raResult.granted && raResult.expiresAt && action.confirmMessage) {
                    const until   = `<t:${Math.floor(raResult.expiresAt.getTime() / 1000)}:R>`;
                    const _uid    = interaction.user?.id;
                    const _ctx    = { member: { id: _uid, mention: `<@${_uid}>`, tag: interaction.user?.tag || '', username: interaction.user?.username || '' }, result: raResult, expiry: until };
                    const rawMsg  = action.confirmMessage.replace(/\[expiry\]/g, until);
                    await interaction.followUp({ content: resolveTemplate(rawMsg, _ctx), flags: 64 }).catch(() => {});
                }
                // role_sequence: top-level feedback after all sub-actions complete
                if (action.type === 'role_sequence' && raResult.granted && action.feedbackMessage) {
                    await interaction.followUp({ content: action.feedbackMessage, flags: 64 }).catch(() => {});
                }
                break;
            }

            // ── Branch: evaluate conditions → redirect to different target state ──
            // Does NOT send a message on its own; only overrides what state gets
            // displayed + persisted.  Put at the START of the pipeline.
            case 'role_check_branch': {
                const _branchGuildId = interaction.guildId || flowCtx?.guildId;
                const _branchUserId  = interaction.user?.id || flowCtx?.userId;
                if (!_branchGuildId || !_branchUserId) break;

                const _branchGuild  = await interaction.client.guilds.fetch(_branchGuildId).catch(() => null);
                const _branchMember = _branchGuild && await _branchGuild.members.fetch(_branchUserId).catch(() => null);
                if (!_branchMember) break;

                const { passed } = await evalBranchConditions(_branchMember, action, _branchGuildId);
                const branchTarget = passed ? action.thenTarget : action.elseTarget;

                if (branchTarget && machineDef.states[branchTarget]) {
                    const branchState = machineDef.states[branchTarget];
                    // Override the content that will be sent to Discord
                    ctx.embeds     = [...(branchState.embeds     || [])];
                    ctx.components = [...(branchState.components || [])];
                    ctx.dirty      = true;
                    // Override the persisted state ID
                    ctx.resolvedTargetStateId = branchTarget;
                }
                break;
            }

            // ── XP grant (gamification) ───────────────────────────────────────
            case 'grant_xp': {
                const _xpGuildId = interaction.guildId || flowCtx?.guildId;
                const _xpUserId  = interaction.user?.id || flowCtx?.userId;
                if (_xpGuildId && _xpUserId)
                    await grantXP(_xpGuildId, _xpUserId, Number(action.xp) || 0,
                                  action.track === 'voice' ? 'voice' : 'text');
                break;
            }

            // ────────────────────────────────────────────────────────────────
            case 'send_dm_message': {
                const _userId = interaction.user?.id;
                const _user   = _userId && await interaction.client.users.fetch(_userId).catch(() => null);
                if (!_user) break;
                const _dmP = buildDiscordPayload({
                    embeds:     targetState.embeds     || [],
                    components: targetState.components || [],
                });
                await _user.send(_dmP).catch(e => {
                    if (e.code !== 50007 /* Cannot message this user */)
                        logger.warn('[emped] send_dm_message failed:', { error: e?.message });
                });
                break;
            }

            // ── Origin-aware actions (require an active flowCtx) ──────────────

            // Send target state embeds to the channel where the flow was started.
            case 'send_to_origin': {
                const _fCtx = flowCtx || _flowContexts.get(interaction.message?.id);
                if (!_fCtx?.channelId) {
                    logger.warn('[emped] send_to_origin: no active flow context for this message');
                    break;
                }
                const _ch = await interaction.client.channels.fetch(_fCtx.channelId).catch(() => null);
                if (_ch) {
                    const _p = buildDiscordPayload({
                        embeds:     targetState.embeds     || [],
                        components: targetState.components || [],
                    });
                    await _ch.send(_p).catch(e => logger.warn('[emped] send_to_origin failed:', { error: e?.message }));
                }
                break;
            }

            // Edit the original guild message that triggered open_dm / open_channel_flow.
            case 'edit_origin_message': {
                const _fCtx = flowCtx || _flowContexts.get(interaction.message?.id);
                if (!_fCtx?.channelId || !_fCtx?.originMsgId) {
                    logger.warn('[emped] edit_origin_message: no flow context or originMsgId');
                    break;
                }
                const _ch  = await interaction.client.channels.fetch(_fCtx.channelId).catch(() => null);
                const _msg = _ch && await _ch.messages.fetch(_fCtx.originMsgId).catch(() => null);
                if (_msg) {
                    const _p = buildDiscordPayload({
                        embeds:     targetState.embeds     || [],
                        components: targetState.components || [],
                    });
                    await _msg.edit(_p).catch(e => logger.warn('[emped] edit_origin_message failed:', { error: e?.message }));
                }
                break;
            }

            // Mark DM / channel flow as complete; execute returnActions in the origin guild.
            case 'complete_flow': {
                const _fCtx = flowCtx || _flowContexts.get(interaction.message?.id);
                if (!_fCtx) {
                    logger.warn('[emped] complete_flow: no active flow context for this message');
                    break;
                }
                if (_fCtx.returnActions?.length) {
                    const _originDoc = await EmbedMessage.findById(_fCtx.docId).lean();
                    if (_originDoc)
                        await _executeReturnActions(interaction.client, _originDoc, _fCtx, targetState)
                            .catch(e => logger.warn('[emped] complete_flow returnActions failed:', { error: e?.message }));
                }
                _releaseFlowContext(interaction.message?.id);
                break;
            }

            case 'delay': {
                // Flush any pending content edit BEFORE sleeping
                if (ctx.dirty) {
                    const p = buildDiscordPayload({ embeds: ctx.embeds, components: ctx.components });
                    await _editMsg(p)
                        .catch(e => logger.warn('[emped] pre-delay edit failed:', { error: e?.message }));
                    ctx.dirty = false;
                }
                await _sleep(action.ms);
                break;
            }

            default:
                logger.warn('[emped] Unknown action type: "' + action.type + '"');
        }
    }

    // ── Flush final pending content edit ─────────────────────────────────────
    if (ctx.dirty) {
        const payload = buildDiscordPayload({ embeds: ctx.embeds, components: ctx.components });
        await _editMsg(payload)
            .catch(e => logger.warn('[emped] Final edit failed:', { error: e?.message }));
    }

    // ── Schedule component restores (hide_component with duration) ────────────
    for (const { ms, docId, channelId, msgId } of restoreSchedules) {
        setTimeout(async () => {
            try {
                const freshDoc   = await EmbedMessage.findById(docId).lean();
                if (!freshDoc) return;
                // Restore must resolve the per-user key if multiUser is on.
                // We stored userId in the closure via restoreSchedules entry.
                const _rUserId   = restoreSchedules.find(r => r.msgId === msgId)?.userId;
                const _rStateKey = (freshDoc.machine?.multiUser && msgId && _rUserId)
                    ? `${msgId}:${_rUserId}`
                    : msgId;
                const curStateId  = freshDoc.instanceStates?.[_rStateKey] || freshDoc.machine?.initial;
                const curState    = freshDoc.machine?.states?.[curStateId];
                if (!curState) return;
                const restPayload = buildDiscordPayload({
                    embeds:     curState.embeds     || [],
                    components: curState.components || [],
                });
                const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
                const msg     = channel && await channel.messages.fetch(msgId).catch(() => null);
                if (msg) await msg.edit(restPayload);
            } catch (e) {
                logger.warn('[emped] hide_component restore failed:', { error: e?.message });
            }
        }, ms);
    }

    // ── Persist the new instance state for this Discord message ───────────────
    const discordMsgId = interaction.message?.id;
    if (discordMsgId) {
        // DM interactions are inherently per-user — always key by message ID only.
        // Guild multi-user flows key by "msgId:userId" so each user has its own state.
        const userId   = interaction.user?.id;
        const stateKey = (!interaction.guildId)
            ? discordMsgId
            : (doc.machine?.multiUser && userId)
                ? `${discordMsgId}:${userId}`
                : discordMsgId;
        EmbedMessage.updateOne(
            { _id: doc._id },
            { $set: { [`instanceStates.${stateKey}`]: ctx.resolvedTargetStateId || targetStateId } }
        ).catch(e => logger.warn('[emped] instanceState save failed:', { error: e?.message }));
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// RETURN-ACTION EXECUTOR  —  Guild-side pipeline after complete_flow
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Execute the `returnActions` pipeline stored in a flow context.
 * Runs without an active interaction (bot-initiated), using the stored origin data.
 *
 * Supported return-action types:
 *   add_role             Add a role to the user in the origin guild
 *   remove_role          Remove a role from the user in the origin guild
 *   send_to_origin       Send target state embed to the origin channel
 *   send_to_channel      Send target state embed to a configured channel
 *   edit_origin_message  Edit the original triggering message in the guild
 *
 * @param {import('discord.js').Client} client
 * @param {object}  doc          EmbedMessage lean doc (for context, not execution)
 * @param {object}  fCtx         Flow context ({ guildId, channelId, originMsgId, userId })
 * @param {object}  targetState  The state whose embeds/components are the payload
 */
async function _executeReturnActions(client, doc, fCtx, targetState) {
    const payload = buildDiscordPayload({
        embeds:     targetState.embeds     || [],
        components: targetState.components || [],
    });

    for (const action of _normalizeActions(fCtx.returnActions)) {
        try {
            switch (action.type) {
                case 'add_role': {
                    if (!action.roleId || !fCtx.guildId || !fCtx.userId) break;
                    const g = await client.guilds.fetch(fCtx.guildId).catch(() => null);
                    const m = g && await g.members.fetch(fCtx.userId).catch(() => null);
                    if (m) await m.roles.add(action.roleId);
                    break;
                }
                case 'remove_role': {
                    if (!action.roleId || !fCtx.guildId || !fCtx.userId) break;
                    const g = await client.guilds.fetch(fCtx.guildId).catch(() => null);
                    const m = g && await g.members.fetch(fCtx.userId).catch(() => null);
                    if (m) await m.roles.remove(action.roleId);
                    break;
                }
                case 'send_to_origin':
                case 'send_to_channel': {
                    const cid = action.channelId || fCtx.channelId;
                    if (!cid) break;
                    const ch = await client.channels.fetch(cid).catch(() => null);
                    if (ch) await ch.send(payload);
                    break;
                }
                case 'edit_origin_message': {
                    if (!fCtx.channelId || !fCtx.originMsgId) break;
                    const ch  = await client.channels.fetch(fCtx.channelId).catch(() => null);
                    const msg = ch && await ch.messages.fetch(fCtx.originMsgId).catch(() => null);
                    if (msg) await msg.edit(payload);
                    break;
                }
                default:
                    logger.warn('[emped] returnAction: unsupported type "' + action.type + '"');
            }
        } catch (e) {
            logger.warn(`[emped] returnAction "${action.type}" failed:`, { error: e?.message });
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// SMART TRIGGER ENGINE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * In-memory cache of EmbedMessage docs that have smart triggers.
 * TTL: 5 min — or forced zero by invalidateTriggerCache() after a dashboard save.
 */
let _triggerDocs  = [];
let _triggerDocsTs = 0;

/** Export: bust the cache so changes saved via the dashboard take effect immediately. */
function invalidateTriggerCache() { _triggerDocsTs = 0; }

async function _refreshTriggerDocs() {
    try {
        // 'machine.triggers.0' is the most reliable way to check for a non-empty array
        // on a Mixed-type field — avoids the broken $not/$size combo on nested Mixed fields.
        _triggerDocs  = await EmbedMessage.find(
            { 'machine.triggers.0': { $exists: true } }
        ).lean();
        _triggerDocsTs = Date.now();
        logger.info(`[emped] Trigger cache refreshed — ${_triggerDocs.length} doc(s) with triggers`);
    } catch (e) {
        logger.warn('[emped] refreshTriggerDocs failed:', { error: e?.message });
    }
}

async function _ensureTriggerCache() {
    if (Date.now() - _triggerDocsTs > 5 * 60_000) await _refreshTriggerDocs();
}

/**
 * Minimal 5-field cron expression matcher.
 * Supports: * | exact | a-b (range) | a,b (list) | *\/n (step)
 */
function _cronMatches(schedule, date) {
    try {
        const parts = (schedule || '').trim().split(/\s+/);
        if (parts.length !== 5) return false;
        const [cMin, cHour, cDom, cMon, cDow] = parts;
        const check = (pat, val) => {
            if (pat === '*') return true;
            if (/^\d+$/.test(pat)) return +pat === val;
            if (pat.includes(',')) return pat.split(',').some(p => check(p.trim(), val));
            const step  = pat.match(/^\*\/(\d+)$/);   if (step)  return val % +step[1] === 0;
            const range = pat.match(/^(\d+)-(\d+)$/); if (range) return val >= +range[1] && val <= +range[2];
            return false;
        };
        return check(cMin,  date.getMinutes())    &&
               check(cHour, date.getHours())      &&
               check(cDom,  date.getDate())       &&
               check(cMon,  date.getMonth() + 1) &&
               check(cDow,  date.getDay());
    } catch { return false; }
}

/** Default action per trigger type when none is explicitly configured. */
function _defaultTriggerAction(type) {
    if (['member_join', 'role_add', 'role_remove'].includes(type)) return 'send_dm';
    if (type === 'message') return 'send_reply';
    return 'send_to_channel';
}

/**
 * Execute a smart trigger autonomously (no Discord interaction context).
 *
 * Actions:
 *   edit_message    — edit the existing live Discord message to the target state
 *   send_to_channel — send embed to a channel (trigger.channelOverride > doc.channelId)
 *   send_dm         — DM the member (member_join / role_add / role_remove)
 *   send_reply      — reply to the triggering message (message keyword events)
 *
 * @param {import('discord.js').Client} client
 * @param {object} doc     — EmbedMessage lean document
 * @param {object} trigger — one entry from machine.triggers[]
 * @param {object} [ctx]   — { member?, message? }
 */
async function _fireTrigger(client, doc, trigger, ctx = {}) {
    const machine       = doc.machine;
    const targetStateId = trigger.targetState || machine?.initial;
    const targetState   = machine?.states?.[targetStateId];
    if (!targetState) {
        logger.warn('[emped] Smart trigger: targetState not found', { target: trigger.targetState });
        return;
    }
    const payload = buildDiscordPayload({
        embeds:     targetState.embeds     || [],
        components: targetState.components || [],
    });
    const rawActions = (trigger.actions || []).length
        ? trigger.actions
        : [_defaultTriggerAction(trigger.type)];

    for (const act of rawActions) {
        const type   = typeof act === 'string' ? act : act?.type;
        const params = typeof act === 'object'  ? act : {};
        try {
            switch (type) {
                case 'edit_message': {
                    if (!doc.messageId || !doc.channelId) break;
                    const ch  = await client.channels.fetch(doc.channelId).catch(() => null);
                    const msg = ch && await ch.messages.fetch(doc.messageId).catch(() => null);
                    if (!msg) break;
                    await msg.edit(payload);
                    EmbedMessage.updateOne(
                        { _id: doc._id },
                        { $set: { [`instanceStates.${doc.messageId}`]: targetStateId } }
                    ).catch(() => {});
                    break;
                }
                case 'send_to_channel': {
                    const cid = params.channelId || trigger.channelOverride || doc.channelId;
                    if (!cid) break;
                    const ch = await client.channels.fetch(cid).catch(() => null);
                    if (ch) await ch.send(payload);
                    break;
                }
                case 'send_dm': {
                    if (!ctx.member) break;
                    const user = ctx.member.user;
                    if (!user || user.bot) break;
                    // buildDiscordPayload may return an empty object if state has no embeds/components.
                    // Discord rejects empty messages, so fall back to a content string.
                    const hasContent = payload.embeds?.length || payload.components?.length || payload.content;
                    if (!hasContent) {
                        logger.warn('[emped] send_dm: target state has no embeds/components — skipping DM');
                        break;
                    }
                    try {
                        await user.send(payload);
                    } catch (dmErr) {
                        // 50007 = Cannot send messages to this user (no mutual guilds, DMs closed, etc.)
                        // These are expected failures — log at debug level, not warn.
                        if (dmErr?.code === 50007 || dmErr?.code === 50013) {
                            logger.debug(`[emped] send_dm skipped for ${user.id}: ${dmErr.message}`);
                        } else {
                            throw dmErr;
                        }
                    }
                    break;
                }
                case 'send_reply': {
                    if (ctx.message) await ctx.message.reply(payload);
                    break;
                }
                default:
                    logger.warn('[emped] Smart trigger: unknown action "' + type + '"');
            }
        } catch (e) {
            logger.warn(`[emped] trigger action "${type}" failed:`, { error: e?.message });
        }
    }
}

/** Runs every 60 s — fires any cron triggers whose schedule matches the current minute. */
async function _cronTick(client) {
    await _ensureTriggerCache();
    const now = new Date();
    for (const doc of _triggerDocs) {
        for (const trigger of (doc.machine?.triggers || [])) {
            if (!trigger.enabled || trigger.type !== 'cron') continue;
            if (_cronMatches(trigger.schedule, now)) {
                _fireTrigger(client, doc, trigger, {})
                    .catch(e => logger.warn('[emped] cron trigger failed:', { error: e?.message }));
            }
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// INTERACTION ROUTER
// ═════════════════════════════════════════════════════════════════════════════

// Guard against duplicate registration on hot-reload / multiple execute() calls
const _registeredClients = new WeakSet();

/**
 * Register the interactionCreate event handler.
 * Loaded automatically by index.js via loadFiles('systems', ...).
 *
 * @param {import('discord.js').Client} client
 */
function registerHandlers(client) {
    if (_registeredClients.has(client)) {
        logger.warn('[EmbedFlow] Handler already registered — skipping duplicate');
        return;
    }
    _registeredClients.add(client);

    // ── Smart Triggers: cron tick every 60 s ─────────────────────────────
    setInterval(() => _cronTick(client), 60_000);

    // ── Smart Triggers: member join ───────────────────────────────────────
    client.on('guildMemberAdd', async member => {
        await _ensureTriggerCache();
        for (const doc of _triggerDocs.filter(d => d.guildId === member.guild.id)) {
            for (const tr of (doc.machine?.triggers || [])) {
                if (!tr.enabled || tr.type !== 'member_join') continue;
                logger.info(`[emped] Firing member_join trigger on doc "${doc.name}" for ${member.user?.tag}`);
                _fireTrigger(client, doc, tr, { member })
                    .catch(e => logger.warn('[emped] member_join trigger failed:', { error: e?.message }));
            }
        }
    });

    // ── Smart Triggers: member leave ──────────────────────────────────────
    client.on('guildMemberRemove', async member => {
        await _ensureTriggerCache();
        for (const doc of _triggerDocs.filter(d => d.guildId === member.guild?.id)) {
            for (const tr of (doc.machine?.triggers || [])) {
                if (!tr.enabled || tr.type !== 'member_leave') continue;
                _fireTrigger(client, doc, tr, { member })
                    .catch(e => logger.warn('[emped] member_leave trigger failed:', { error: e?.message }));
            }
        }
    });

    // ── Smart Triggers: role add / remove ─────────────────────────────────
    client.on('guildMemberUpdate', async (oldM, newM) => {
        const addedRoles   = newM.roles.cache.filter(r => !oldM.roles.cache.has(r.id));
        const removedRoles = oldM.roles.cache.filter(r => !newM.roles.cache.has(r.id));
        if (!addedRoles.size && !removedRoles.size) return;
        await _ensureTriggerCache();
        for (const doc of _triggerDocs.filter(d => d.guildId === newM.guild.id)) {
            for (const tr of (doc.machine?.triggers || [])) {
                if (!tr.enabled) continue;
                if (tr.type === 'role_add'    && tr.roleId && addedRoles.has(tr.roleId))
                    _fireTrigger(client, doc, tr, { member: newM })
                        .catch(e => logger.warn('[emped] role_add trigger failed:', { error: e?.message }));
                if (tr.type === 'role_remove' && tr.roleId && removedRoles.has(tr.roleId))
                    _fireTrigger(client, doc, tr, { member: newM })
                        .catch(e => logger.warn('[emped] role_remove trigger failed:', { error: e?.message }));
            }
        }
    });

    // ── Smart Triggers: message keyword / regex ───────────────────────────
    client.on('messageCreate', async message => {
        if (message.author.bot || !message.guildId) return;
        await _ensureTriggerCache();
        for (const doc of _triggerDocs.filter(d => d.guildId === message.guildId)) {
            for (const tr of (doc.machine?.triggers || [])) {
                if (!tr.enabled || tr.type !== 'message') continue;
                if (tr.channelId && tr.channelId !== message.channelId) continue;
                if (!tr.pattern) continue;
                let matched = false;
                try {
                    matched = tr.isRegex
                        ? new RegExp(tr.pattern, 'i').test(message.content)
                        : message.content.toLowerCase().includes(tr.pattern.toLowerCase());
                } catch { continue; }
                if (matched)
                    _fireTrigger(client, doc, tr, { message })
                        .catch(e => logger.warn('[emped] message trigger failed:', { error: e?.message }));
            }
        }
    });

    client.on('interactionCreate', async interaction => {
        try {
            const guildId  = interaction.guildId;
            const isFromDM = !guildId
                && (interaction.channel?.type === ChannelType.DM || !interaction.channel);

            // Allow guild interactions + DM button/select interactions (for open_dm flows).
            // Reject everything else that has no guild context.
            if (!guildId && !isFromDM) return;
            if (isFromDM && !interaction.isButton() && !interaction.isStringSelectMenu()) return;

            // ── Button ────────────────────────────────────────────────────────
            if (interaction.isButton()) {
                const customId     = interaction.customId;
                const discordMsgId = interaction.message?.id;

                let doc;
                if (guildId) {
                    // Guild context: standard lookup by guildId + componentId
                    doc = await EmbedMessage.findOne({ guildId, componentIds: customId }).lean();
                } else {
                    // DM context: find doc that owns both this componentId and this DM message
                    if (!discordMsgId) return;
                    doc = await EmbedMessage.findOne({
                        componentIds: customId,
                        [`instanceStates.${discordMsgId}`]: { $exists: true },
                    }).lean();
                }
                if (!doc?.machine?.states) return; // Not our embed message

                const userId         = interaction.user?.id;
                const instanceStates = doc.instanceStates || {};
                // DM messages are already per-user; multiUser key only applies in guild context
                const stateKey       = (guildId && doc.machine?.multiUser && discordMsgId && userId)
                    ? `${discordMsgId}:${userId}`
                    : discordMsgId;
                const currentStateId = (stateKey && instanceStates[stateKey])
                    || doc.machine.initial;

                const result = _computeTransition(doc.machine, currentStateId, customId);
                if (!result) return; // No valid transition from current state

                if (!await _checkPermissions(interaction, doc, currentStateId)) return;

                // Load flow context if this message is part of a DM/channel-forwarded flow
                const flowCtxBtn = discordMsgId ? (_flowContexts.get(discordMsgId) || null) : null;

                await _execute(
                    interaction, doc,
                    currentStateId, result.targetStateId, result.actions,
                    flowCtxBtn
                );

                // ── AutomationLink: fire cross-message links after execute ──
                if (guildId) {
                    try {
                        const AutomationLink = require('./schemas/AutomationLink');
                        const links = await AutomationLink.find({
                            guildId, sourceKind: 'embed', sourceId: doc._id.toString(), enabled: true,
                        }).lean();
                        for (const link of links) {
                            if (link.sourceButtonId && link.sourceButtonId !== customId) continue;
                            await _executeAutoLink(interaction, link);
                        }
                    } catch (linkErr) {
                        logger.warn('[emped] AutomationLink error:', { error: linkErr.message });
                    }
                }
                return;
            }

            // ── String Select Menu ────────────────────────────────────────────
            if (interaction.isStringSelectMenu()) {
                const menuCustomId  = interaction.customId;
                const selectedValue = interaction.values?.[0];
                if (!selectedValue) return;
                const discordMsgId  = interaction.message?.id;

                let doc;
                if (guildId) {
                    doc = await EmbedMessage.findOne({ guildId, componentIds: menuCustomId }).lean();
                } else {
                    if (!discordMsgId) return;
                    doc = await EmbedMessage.findOne({
                        componentIds: menuCustomId,
                        [`instanceStates.${discordMsgId}`]: { $exists: true },
                    }).lean();
                }
                if (!doc?.machine?.states) return;

                const userId         = interaction.user?.id;
                const instanceStates = doc.instanceStates || {};
                const stateKey       = (guildId && doc.machine?.multiUser && discordMsgId && userId)
                    ? `${discordMsgId}:${userId}`
                    : discordMsgId;
                const currentStateId = (stateKey && instanceStates[stateKey])
                    || doc.machine.initial;

                // Map selectedValue → option.customId → XState event
                const resolved = _resolveSelectEvent(doc.machine, menuCustomId, selectedValue);
                if (!resolved) return;

                const result = _computeTransition(doc.machine, currentStateId, resolved.eventId);
                if (!result) return;

                if (!await _checkPermissions(interaction, doc, currentStateId)) return;

                // Load flow context if this message is part of a DM/channel-forwarded flow
                const flowCtxSel = discordMsgId ? (_flowContexts.get(discordMsgId) || null) : null;

                await _execute(
                    interaction, doc,
                    currentStateId, result.targetStateId, result.actions,
                    flowCtxSel
                );

                // ── AutomationLink: fire cross-message links after execute ──
                if (guildId) {
                    try {
                        const AutomationLink = require('./schemas/AutomationLink');
                        const links = await AutomationLink.find({
                            guildId, sourceKind: 'embed', sourceId: doc._id.toString(), enabled: true,
                        }).lean();
                        for (const link of links) {
                            if (link.sourceButtonId && link.sourceButtonId !== menuCustomId) continue;
                            await _executeAutoLink(interaction, link);
                        }
                    } catch (linkErr) {
                        logger.warn('[emped] AutomationLink error:', { error: linkErr.message });
                    }
                }
                return;
            }

        } catch (err) {
            // Ignore expired interactions (user took too long)
            if (err.code === 10062) return;

            logger.error('[emped]', err);

            const errMsg = { content: '❌ An error occurred.', flags: MessageFlags.Ephemeral };
            try {
                if (interaction.replied || interaction.deferred) await interaction.followUp(errMsg);
                else await interaction.reply(errMsg);
            } catch (_) { /* silently ignore ack errors */ }
        }
    });

    logger.info('[EmbedFlow] XState interaction handlers registered ✓');
}

// ═════════════════════════════════════════════════════════════════════════════
// AUTOMATION LINK EXECUTOR  —  Cross-message link system
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Fire an AutomationLink: send the target message in response to the
 * source embed interaction having just fired.
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
        logger.warn('[emped] _executeAutoLink failed:', {
            error: e.message, targetId: link.targetId, targetKind: link.targetKind,
        });
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// SYSTEM EXPORT  (consumed by index.js loadFiles)
// ═════════════════════════════════════════════════════════════════════════════

module.exports = {
    name: 'emped',
    invalidateTriggerCache,
    execute(client) {
        registerHandlers(client);
        // Re-schedule all active temp role removals after restart
        restoreTempRoles(client)
            .catch(e => logger.warn('[emped] restoreTempRoles error:', { error: e?.message }));
    },
};

/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */
