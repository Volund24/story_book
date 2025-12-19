import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';

export const data = new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show available commands');

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.reply({
        content: `**Infinite Heroes Battle Bot Commands:**

**⚔️ Battle**
\`/battle create\` - Start a new battle lobby (Opens Setup Wizard).
\`/battle join\` - Join an existing lobby.
\`/battle start\` - Start the battle (Host only).
\`/battle reset\` - Reset the lobby (Host only).

**💳 Wallet**
\`/wallet check\` - Check connected wallet.
\`/wallet set\` - Add or change your wallet address.
`,
        ephemeral: true
    });
}
