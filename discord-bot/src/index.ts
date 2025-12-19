import { Client, GatewayIntentBits, Collection, Events } from 'discord.js';
import * as dotenv from 'dotenv';
import { initDB } from './db';
import * as adminCommand from './commands/admin';
import * as battleCommand from './commands/battle';
import * as helpCommand from './commands/help';
import * as walletCommand from './commands/wallet';

dotenv.config();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Command Collection
const commands = new Collection<string, any>();
commands.set(adminCommand.data.name, adminCommand);
commands.set(battleCommand.data.name, battleCommand);
commands.set(helpCommand.data.name, helpCommand);
commands.set(walletCommand.data.name, walletCommand);

client.once(Events.ClientReady, async c => {
    console.log(`Ready! Logged in as ${c.user.tag}`);
    await initDB();
    console.log('Database initialized.');
});

client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'admin_config_modal') {
            try {
                // @ts-ignore
                await adminCommand.handleModal(interaction);
            } catch (error) {
                console.error(error);
                await interaction.reply({ content: 'Error saving configuration.', ephemeral: true });
            }
        } else if (interaction.customId.startsWith('battle_')) {
            try {
                // @ts-ignore
                await battleCommand.handleInteraction(interaction);
            } catch (error) {
                console.error(error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: 'Error processing modal.', ephemeral: true });
                }
            }
        }
        return;
    }

    if (interaction.isStringSelectMenu()) {
        if (interaction.customId.startsWith('battle_')) {
            try {
                // @ts-ignore
                await battleCommand.handleInteraction(interaction);
            } catch (error) {
                console.error(error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: 'Error processing selection.', ephemeral: true });
                }
            }
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = commands.get(interaction.commandName);

    if (!command) {
        console.error(`No command matching ${interaction.commandName} was found.`);
        return;
    }

    try {
        await command.execute(interaction);
    } catch (error) {
        console.error(error);
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: 'There was an error while executing this command!', ephemeral: true });
        } else {
            await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
