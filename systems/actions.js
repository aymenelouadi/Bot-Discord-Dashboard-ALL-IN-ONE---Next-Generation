/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

/**
 * Actions System — Routes button, select menu, and modal interactions
 * for actions_enabled (enabled_*), actions_label (label_*),
 * and actions_color (color_*) commands.
 */

module.exports = {
    name: 'actions-system',

    execute(client) {
        client.on('interactionCreate', async (interaction) => {
            try {
                const id = interaction.customId || '';

                // ── actions_enabled ────────────────────────────────────────────
                if (id.startsWith('enabled_')) {
                    const command = client.commands.get('actions_enabled');
                    if (!command) return;
                    if (interaction.isButton()) await command.handleButton(interaction);
                    else if (interaction.isStringSelectMenu()) await command.handleSelectMenu(interaction);
                    return;
                }

                // ── actions_label ──────────────────────────────────────────────
                if (id.startsWith('label_')) {
                    const command = client.commands.get('actions_label');
                    if (!command) return;
                    if (interaction.isButton()) await command.handleButton(interaction);
                    else if (interaction.isStringSelectMenu()) await command.handleSelectMenu(interaction);
                    else if (interaction.isModalSubmit()) await command.handleModal(interaction);
                    return;
                }

                // ── actions_color ──────────────────────────────────────────────
                if (id.startsWith('color_')) {
                    const command = client.commands.get('actions_color');
                    if (!command) return;
                    if (interaction.isButton()) await command.handleButton(interaction);
                    else if (interaction.isStringSelectMenu()) await command.handleSelectMenu(interaction);
                    else if (interaction.isModalSubmit()) await command.handleModal(interaction);
                    return;
                }

                // ── actions_log ────────────────────────────────────────────────
                if (id.startsWith('log_')) {
                    const command = client.commands.get('actions_log');
                    if (!command) return;
                    if (interaction.isButton()) await command.handleButton(interaction);
                    else if (interaction.isStringSelectMenu()) await command.handleSelectMenu(interaction);
                    return;
                }

                // ── actions_role_jail ──────────────────────────────────────────
                if (
                    id.startsWith('jail_role_') ||
                    (id.startsWith('page_') && !id.startsWith('page_rooms_'))
                ) {
                    const command = client.commands.get('actions_role_jail');
                    if (!command) return;
                    if (interaction.isButton()) await command.handleButton(interaction);
                    else if (interaction.isRoleSelectMenu()) await command.handleSelectMenu(interaction);
                    return;
                }

                // ── actions_show_room_jail ─────────────────────────────────────
                if (id.startsWith('jail_rooms_')) {
                    const command = client.commands.get('actions_show_room_jail');
                    if (!command) return;
                    if (interaction.isButton()) await command.handleButton(interaction);
                    else if (interaction.isChannelSelectMenu()) await command.handleChannelSelect(interaction);
                    return;
                }

                // ── actions_mute_role ──────────────────────────────────────────
                if (id.startsWith('mute_role_')) {
                    const command = client.commands.get('actions_role_mute');
                    if (!command) return;
                    if (interaction.isButton()) await command.handleButton(interaction);
                    else if (interaction.isRoleSelectMenu()) await command.handleRoleSelect(interaction);
                    return;
                }

            } catch (error) {
                console.error('[Actions System] interactionCreate error:', error);
                try {
                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.reply({ content: 'حدث خطأ في تنفيذ الطلب', ephemeral: true });
                    }
                } catch (_) {}
            }
        });

        console.log('[system] Actions system loaded');
    }
};


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */