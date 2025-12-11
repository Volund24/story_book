import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, ChannelType, TextChannel } from 'discord.js';
import { getUser, updateUser, getConfig } from '../db';
import { StoryGenerator } from '../logic/StoryGenerator';

export const data = new SlashCommandBuilder()
    .setName('comic')
    .setDescription('Infinite Heroes Comic Commands')
    .addSubcommand(sub =>
        sub
            .setName('create')
            .setDescription('Start a new comic generation')
            .addAttachmentOption(option => option.setName('image').setDescription('Your Hero NFT/Image').setRequired(true))
            .addStringOption(option => 
                option.setName('genre')
                    .setDescription('Select a genre')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Classic Horror', value: 'Classic Horror' },
                        { name: 'Superhero Action', value: 'Superhero Action' },
                        { name: 'Dark Sci-Fi', value: 'Dark Sci-Fi' },
                        { name: 'High Fantasy', value: 'High Fantasy' },
                        { name: 'Neon Noir Detective', value: 'Neon Noir Detective' },
                        { name: 'Wasteland Apocalypse', value: 'Wasteland Apocalypse' },
                        { name: 'Lighthearted Comedy', value: 'Lighthearted Comedy' },
                        { name: 'Teen Drama', value: 'Teen Drama / Slice of Life' },
                        { name: 'Custom', value: 'Custom' }
                    )
            )
            .addAttachmentOption(option => option.setName('costar').setDescription('Optional: Villain or Co-Star Image').setRequired(false))
    )
    .addSubcommand(sub =>
        sub
            .setName('status')
            .setDescription('Check your tokens and cooldown')
    );

export async function execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();
    const user = await getUser(interaction.user.id);

    if (subcommand === 'status') {
        const cooldownMs = parseInt(await getConfig('cooldown_ms') || '86400000');
        const now = Date.now();
        const timeSince = now - (user.last_generation || 0);
        const onCooldown = timeSince < cooldownMs;
        
        let statusMsg = `**Tokens:** ${user.tokens}\n`;
        if (onCooldown) {
            const remaining = Math.ceil((cooldownMs - timeSince) / (1000 * 60 * 60));
            statusMsg += `**Cooldown:** ⏳ Wait ${remaining} more hours.`;
        } else {
            statusMsg += `**Cooldown:** ✅ Ready to generate!`;
        }

        await interaction.reply({ content: statusMsg, ephemeral: true });
        return;
    }

    if (subcommand === 'create') {
        // 1. Check Cooldown & Tokens
        const cooldownMs = parseInt(await getConfig('cooldown_ms') || '86400000');
        const now = Date.now();
        if (now - (user.last_generation || 0) < cooldownMs) {
            const remaining = Math.ceil((cooldownMs - (now - user.last_generation)) / (1000 * 60 * 60));
            await interaction.reply({ content: `⏳ You are on cooldown. Please wait ${remaining} hours or use a token.`, ephemeral: true });
            return;
        }

        const image = interaction.options.getAttachment('image', true);
        const costar = interaction.options.getAttachment('costar', false);
        const genre = interaction.options.getString('genre', true);
        
        // 2. Validate Channel
        if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
            await interaction.reply({ content: "❌ This command can only be used in text channels.", ephemeral: true });
            return;
        }

        // 3. Acknowledge
        await interaction.reply({ 
            content: `⚡ **Initializing Infinite Heroes Generator...**\n**Genre:** ${genre}\n**Hero:** Uploaded\n**Co-Star:** ${costar ? 'Uploaded' : 'None'}\n\n*Generating Page 1... (This may take 10-20 seconds)*`, 
            ephemeral: false 
        });

        // 4. Start Generation
        try {
            const generator = new StoryGenerator(
                process.env.GEMINI_KEY || '', 
                image.url, 
                costar ? costar.url : null, 
                genre, 
                interaction.channel as TextChannel, 
                interaction.user
            );

            // Fire and forget - the generator handles the rest
            generator.start().catch(err => {
                console.error("Generation Error:", err);
                interaction.followUp({ content: `❌ **Generation Failed:** ${err.message}`, ephemeral: true });
            });

            // Update User State
            await updateUser(interaction.user.id, { last_generation: now });

        } catch (error) {
            console.error(error);
            await interaction.followUp({ content: "❌ Failed to start generation process.", ephemeral: true });
        }
    }
}
