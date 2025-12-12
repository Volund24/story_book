import { Client, GatewayIntentBits, Collection, Events } from 'discord.js';
import * as dotenv from 'dotenv';
import { initDB } from './db';
import * as comicCommand from './commands/comic';
import * as adminCommand from './commands/admin';
import * as battleCommand from './commands/battle';

dotenv.config();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Command Collection
const commands = new Collection<string, any>();
commands.set(comicCommand.data.name, comicCommand);
commands.set(adminCommand.data.name, adminCommand);
commands.set(battleCommand.data.name, battleCommand);

client.once(Events.ClientReady, async c => {
    console.log(`Ready! Logged in as ${c.user.tag}`);
    await initDB();
    console.log('Database initialized.');
});

client.on(Events.InteractionCreate, async interaction => {
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
