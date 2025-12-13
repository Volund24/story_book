import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, TextChannel } from 'discord.js';
import { getUser, updateUser, getConfig } from '../db';
import { verifyWalletAndGetNFT } from '../logic/SolanaVerifier';

// In-memory lobby state (for now, could be DB later)
interface Lobby {
    hostId: string;
    channelId: string;
    players: Player[];
    maxPlayers: number;
    status: 'OPEN' | 'IN_PROGRESS' | 'COMPLETED';
    settings: {
        arena: string;
        genre: string;
        registrationType: 'UPLOAD' | 'PFP' | 'WALLET';
    };
}

interface Player {
    id: string;
    username: string;
    avatarUrl: string;
    isOnline: boolean;
    walletAddress?: string;
    nftAttributes?: any[];
}

const activeLobbies: Map<string, Lobby> = new Map(); // Key: ChannelID

export const data = new SlashCommandBuilder()
    .setName('battle')
    .setDescription('Infinite Heroes Battle Royale')
    .addSubcommand(sub =>
        sub
            .setName('create')
            .setDescription('Start a new Battle Lobby')
            .addIntegerOption(opt => opt.setName('players').setDescription('Max Players (2-16)').setMinValue(2).setMaxValue(16).setRequired(true))
            .addStringOption(opt => 
                opt.setName('type')
                    .setDescription('Registration Type')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Image Upload', value: 'UPLOAD' },
                        { name: 'Discord PFP', value: 'PFP' },
                        { name: 'Solana Wallet', value: 'WALLET' }
                    )
            )
            .addStringOption(opt => opt.setName('arena').setDescription('Battle Arena/Theme').setRequired(false))
    )
    .addSubcommand(sub =>
        sub
            .setName('join')
            .setDescription('Join the current lobby')
            .addAttachmentOption(opt => opt.setName('image').setDescription('Your Character Image (Required for UPLOAD type)').setRequired(false))
            .addStringOption(opt => opt.setName('wallet').setDescription('Your Solana Wallet Address (Required for WALLET type)').setRequired(false))
    )
    .addSubcommand(sub =>
        sub
            .setName('start')
            .setDescription('Start the Battle (Host Only)')
    )
    .addSubcommand(sub =>
        sub
            .setName('reset')
            .setDescription('Force reset the lobby in this channel (Host/Admin Only)')
    );

export async function execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();
    const channelId = interaction.channelId;

    if (subcommand === 'reset') {
        const lobby = activeLobbies.get(channelId);
        if (!lobby) {
            await interaction.reply({ content: "ℹ️ No active lobby to reset.", ephemeral: true });
            return;
        }

        // Check permissions (Host or Admin)
        // Note: For now, we just check if they are the host. 
        // Real admin check would require checking interaction.member.permissions
        if (interaction.user.id !== lobby.hostId) {
             await interaction.reply({ content: "❌ Only the Host can reset the lobby.", ephemeral: true });
             return;
        }

        activeLobbies.delete(channelId);
        await interaction.reply({ content: "🗑️ **Lobby has been reset.** You can now create a new one." });
        return;
    }

    if (subcommand === 'create') {
        if (activeLobbies.has(channelId)) {
            await interaction.reply({ content: "❌ A lobby is already active in this channel!", ephemeral: true });
            return;
        }

        const maxPlayers = interaction.options.getInteger('players', true);
        const regType = interaction.options.getString('type', true) as 'UPLOAD' | 'PFP' | 'WALLET';
        const arena = interaction.options.getString('arena') || 'The Void';

        const lobby: Lobby = {
            hostId: interaction.user.id,
            channelId: channelId,
            players: [],
            maxPlayers: maxPlayers,
            status: 'OPEN',
            settings: {
                arena: arena,
                genre: 'Action', // Default, host can change later?
                registrationType: regType
            }
        };

        // Auto-register the host
        let hostAvatar = interaction.user.displayAvatarURL({ extension: 'png', size: 512 });
        // If UPLOAD type, host needs to join manually or we default to PFP for now
        if (regType === 'PFP') {
             lobby.players.push({
                id: interaction.user.id,
                username: interaction.user.username,
                avatarUrl: hostAvatar,
                isOnline: true
            });
        }

        activeLobbies.set(channelId, lobby);

        const playerList = lobby.players.length > 0 ? `**1.** ${lobby.players[0].username}` : 'Waiting for players...';

        const embed = new EmbedBuilder()
            .setTitle(`⚔️ BATTLE ROYALE: ${arena}`)
            .setDescription(`**Host:** ${interaction.user.username}\n**Mode:** ${regType}\n**Players:** ${lobby.players.length}/${maxPlayers}\n\n**Registered Fighters:**\n${playerList}\n\nType \`/battle join\` to enter!`)
            .setColor(0xFFD700);

        await interaction.reply({ embeds: [embed] });
        return;
    }

    if (subcommand === 'join') {
        const lobby = activeLobbies.get(channelId);
        if (!lobby || lobby.status !== 'OPEN') {
            await interaction.reply({ content: "❌ No open lobby in this channel.", ephemeral: true });
            return;
        }

        if (lobby.players.find(p => p.id === interaction.user.id)) {
            await interaction.reply({ content: "⚠️ You are already registered!", ephemeral: true });
            return;
        }

        if (lobby.players.length >= lobby.maxPlayers) {
            await interaction.reply({ content: "❌ Lobby is full!", ephemeral: true });
            return;
        }

        let avatarUrl = interaction.user.displayAvatarURL({ extension: 'png', size: 512 });
        let walletAddress: string | undefined;
        let nftAttributes: any[] | undefined;
        
        if (lobby.settings.registrationType === 'UPLOAD') {
            const attachment = interaction.options.getAttachment('image');
            if (!attachment) {
                await interaction.reply({ content: "❌ You must upload an image to join this battle!", ephemeral: true });
                return;
            }
            avatarUrl = attachment.url;
        } else if (lobby.settings.registrationType === 'WALLET') {
            const wallet = interaction.options.getString('wallet');
            if (!wallet) {
                await interaction.reply({ content: "❌ You must provide a Solana Wallet Address!", ephemeral: true });
                return;
            }
            
            await interaction.deferReply(); // Verification might take a moment
            
            const nftData = await verifyWalletAndGetNFT(wallet);
            if (!nftData) {
                await interaction.editReply({ content: "❌ No valid NFT found in this wallet! (Must be a single NFT, not a token)" });
                return;
            }
            
            avatarUrl = nftData.image;
            walletAddress = wallet;
            nftAttributes = nftData.attributes;
            
            // Resume normal flow (but use editReply instead of reply)
            lobby.players.push({
                id: interaction.user.id,
                username: interaction.user.username,
                avatarUrl: avatarUrl,
                isOnline: true,
                walletAddress,
                nftAttributes
            });

            const playerList = lobby.players.map((p, i) => `**${i + 1}.** ${p.username}`).join('\n');
            const updateEmbed = new EmbedBuilder()
                .setTitle(`⚔️ BATTLE ROYALE: ${lobby.settings.arena}`)
                .setDescription(`**Host:** <@${lobby.hostId}>\n**Mode:** ${lobby.settings.registrationType}\n**Players:** ${lobby.players.length}/${lobby.maxPlayers}\n\n**Registered Fighters:**\n${playerList}\n\nType \`/battle join\` to enter!`)
                .setColor(0xFFD700)
                .setThumbnail(lobby.players[0].avatarUrl);

            await interaction.editReply({ embeds: [updateEmbed] });
            
            if (lobby.players.length === lobby.maxPlayers) {
                const host = await interaction.client.users.fetch(lobby.hostId);
                await interaction.followUp(`📢 **Lobby Full!** ${host.toString()}, type \`/battle start\` to begin!`);
            }
            return;
        }

        // Default PFP or UPLOAD flow (non-wallet)
        lobby.players.push({
            id: interaction.user.id,
            username: interaction.user.username,
            avatarUrl: avatarUrl,
            isOnline: true
        });

        // Update the lobby embed
        const playerList = lobby.players.map((p, i) => `**${i + 1}.** ${p.username}`).join('\n');
        const updateEmbed = new EmbedBuilder()
            .setTitle(`⚔️ BATTLE ROYALE: ${lobby.settings.arena}`)
            .setDescription(`**Host:** <@${lobby.hostId}>\n**Mode:** ${lobby.settings.registrationType}\n**Players:** ${lobby.players.length}/${lobby.maxPlayers}\n\n**Registered Fighters:**\n${playerList}\n\nType \`/battle join\` to enter!`)
            .setColor(0xFFD700)
            .setThumbnail(lobby.players[0].avatarUrl); // Show host avatar as thumbnail

        await interaction.reply({ embeds: [updateEmbed] });
        
        // Check if full
        if (lobby.players.length === lobby.maxPlayers) {
            const host = await interaction.client.users.fetch(lobby.hostId);
            await interaction.followUp(`📢 **Lobby Full!** ${host.toString()}, type \`/battle start\` to begin!`);
        }
        return;
    }

    if (subcommand === 'start') {
        const lobby = activeLobbies.get(channelId);
        if (!lobby) {
            await interaction.reply({ content: "❌ No lobby found.", ephemeral: true });
            return;
        }

        if (interaction.user.id !== lobby.hostId) {
            await interaction.reply({ content: "❌ Only the Host can start the battle.", ephemeral: true });
            return;
        }

        if (lobby.players.length < 2) {
            await interaction.reply({ content: "❌ Need at least 2 players to start.", ephemeral: true });
            return;
        }

        lobby.status = 'IN_PROGRESS';
        await interaction.reply({ content: `🔥 **THE BATTLE BEGINS!**\nArena: ${lobby.settings.arena}\nFighters: ${lobby.players.map(p => p.username).join(', ')}` });

        // TODO: Trigger the Battle Engine here
        // await startBattle(lobby);
        
        // Cleanup for now
        activeLobbies.delete(channelId);
    }
}
