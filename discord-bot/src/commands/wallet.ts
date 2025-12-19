import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { getUser, updateUser } from '../db';

export const data = new SlashCommandBuilder()
    .setName('wallet')
    .setDescription('Manage your Solana wallet')
    .addSubcommand(sub =>
        sub
            .setName('check')
            .setDescription('Check your connected wallet')
    )
    .addSubcommand(sub =>
        sub
            .setName('set')
            .setDescription('Set or change your wallet address')
            .addStringOption(opt => opt.setName('address').setDescription('Solana Wallet Address').setRequired(true))
    );

export async function execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (subcommand === 'check') {
        const user = await getUser(userId);
        if (user && user.wallet_address) {
            await interaction.reply({ content: `✅ **Connected Wallet:** \`${user.wallet_address}\``, ephemeral: true });
        } else {
            await interaction.reply({ content: "❌ No wallet connected. Use `/wallet set <address>` to connect one.", ephemeral: true });
        }
    } else if (subcommand === 'set') {
        const address = interaction.options.getString('address', true);
        // Basic validation (Solana addresses are base58, usually 32-44 chars)
        if (address.length < 32 || address.length > 44) {
            await interaction.reply({ content: "❌ Invalid Solana address format.", ephemeral: true });
            return;
        }

        await updateUser(userId, { wallet_address: address });
        await interaction.reply({ content: `✅ Wallet updated to: \`${address}\``, ephemeral: true });
    }
}
