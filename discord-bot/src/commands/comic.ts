import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, ChannelType } from 'discord.js';
import { getUser, updateUser, getConfig } from '../db';

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

        // 2. Create Webhook for this channel (if possible) or use interaction response
        // For the "Live Stream" feature, we need a Webhook URL to pass to the Web App.
        let webhookUrl = "";
        if (interaction.channel && interaction.channel.type === ChannelType.GuildText) {
            try {
                const webhooks = await interaction.channel.fetchWebhooks();
                let hook = webhooks.find(w => w.name === 'Infinite Heroes Bot');
                if (!hook) {
                    hook = await interaction.channel.createWebhook({
                        name: 'Infinite Heroes Bot',
                        avatar: interaction.client.user?.displayAvatarURL(),
                    });
                }
                webhookUrl = hook.url;
            } catch (e) {
                console.error("Failed to create webhook", e);
                // Fallback: We can't stream if we can't make a webhook, but we can still generate.
            }
        }

        // 3. Generate Magic Link
        const image = interaction.options.getAttachment('image', true);
        const genre = interaction.options.getString('genre', true);
        const baseUrl = process.env.WEB_APP_URL || 'http://localhost:5173';
        
        const params = new URLSearchParams();
        params.append('hero_url', image.url);
        params.append('genre', genre);
        if (webhookUrl) params.append('webhook', webhookUrl);

        const magicLink = `${baseUrl}/?${params.toString()}`;

        // 4. Update User State
        await updateUser(interaction.user.id, { last_generation: now });

        // 5. Reply
        const embed = new EmbedBuilder()
            .setTitle("⚡ Infinite Heroes Generator")
            .setDescription(`Your custom **${genre}** comic is ready to be forged!`)
            .addFields({ name: "Magic Link", value: `[Click here to Start Generation](${magicLink})` })
            .setImage(image.url)
            .setColor(0xFFD700)
            .setFooter({ text: "Clicking the link will open the Web App and start the live stream in this channel." });

        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
}
