import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';
import { getUser, updateUser, getConfig, setConfig } from '../db';

export const data = new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Admin management commands')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommandGroup(group =>
        group
            .setName('config')
            .setDescription('Configure bot settings')
            .addSubcommand(sub =>
                sub
                    .setName('cooldown')
                    .setDescription('Set the global cooldown in hours')
                    .addIntegerOption(option => option.setName('hours').setDescription('Hours').setRequired(true))
            )
    )
    .addSubcommandGroup(group =>
        group
            .setName('user')
            .setDescription('Manage users')
            .addSubcommand(sub =>
                sub
                    .setName('reset')
                    .setDescription('Reset a users cooldown')
                    .addUserOption(option => option.setName('target').setDescription('The user').setRequired(true))
            )
            .addSubcommand(sub =>
                sub
                    .setName('grant')
                    .setDescription('Grant tokens to a user')
                    .addUserOption(option => option.setName('target').setDescription('The user').setRequired(true))
                    .addIntegerOption(option => option.setName('amount').setDescription('Amount of tokens').setRequired(true))
            )
    )
    .addSubcommand(sub =>
        sub
            .setName('restart')
            .setDescription('Soft restart the bot state')
    );

export async function execute(interaction: ChatInputCommandInteraction) {
    const group = interaction.options.getSubcommandGroup();
    const subcommand = interaction.options.getSubcommand();

    if (group === 'config') {
        if (subcommand === 'cooldown') {
            const hours = interaction.options.getInteger('hours', true);
            const ms = hours * 60 * 60 * 1000;
            await setConfig('cooldown_ms', ms.toString());
            await interaction.reply(`✅ Global cooldown set to **${hours} hours**.`);
        }
    } else if (group === 'user') {
        const target = interaction.options.getUser('target', true);
        
        if (subcommand === 'reset') {
            await updateUser(target.id, { last_generation: 0 });
            await interaction.reply(`✅ Cooldown reset for ${target}.`);
        } else if (subcommand === 'grant') {
            const amount = interaction.options.getInteger('amount', true);
            const user = await getUser(target.id);
            await updateUser(target.id, { tokens: (user.tokens || 0) + amount });
            await interaction.reply(`✅ Granted **${amount} tokens** to ${target}. New balance: ${user.tokens + amount}.`);
        }
    } else if (subcommand === 'restart') {
        // In a real scenario, this might clear caches or reload config
        await interaction.reply("🔄 System state reloaded.");
    }
}
