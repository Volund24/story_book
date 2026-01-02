import { Client, GatewayIntentBits, Collection, Events } from 'discord.js';
import * as dotenv from 'dotenv';
import { initDB } from './db';
import * as comicCommand from './commands/comic';
import * as adminCommand from './commands/admin';

dotenv.config();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Command Collection
const commands = new Collection<string, any>();
commands.set(comicCommand.data.name, comicCommand);
commands.set(adminCommand.data.name, adminCommand);

client.once(Events.ClientReady, async c => {
    console.log(`Ready! Logged in as ${c.user.tag}`);
    await initDB();
    console.log('Database initialized.');
});

client.on(Events.InteractionCreate, async interaction => {
    // Handle Slash Commands
    if (interaction.isChatInputCommand()) {
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
        return;
    }

    // Handle Interactive Components (Buttons, Select Menus, Modals)
    if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
        // Currently only comic command has interactive components
        try {
            await comicCommand.handleInteraction(interaction);
        } catch (error) {
            console.error("Interaction Error:", error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '❌ Interaction failed.', ephemeral: true });
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
