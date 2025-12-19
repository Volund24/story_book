import { REST, Routes } from 'discord.js';
import * as dotenv from 'dotenv';
import * as adminCommand from './commands/admin';
import * as battleCommand from './commands/battle';
import * as helpCommand from './commands/help';
import * as walletCommand from './commands/wallet';

dotenv.config();

const commands = [
    adminCommand.data.toJSON(),
    battleCommand.data.toJSON(),
    helpCommand.data.toJSON(),
    walletCommand.data.toJSON()
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
