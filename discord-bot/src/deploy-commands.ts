import { REST, Routes } from 'discord.js';
import * as dotenv from 'dotenv';
import * as comicCommand from './commands/comic';
import * as adminCommand from './commands/admin';

dotenv.config();

const commands = [
    comicCommand.data.toJSON(),
    adminCommand.data.toJSON()
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');

        if (!process.env.CLIENT_ID) throw new Error("Missing CLIENT_ID in .env");

        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands },
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})();
