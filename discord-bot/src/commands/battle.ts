import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, TextChannel, User, Attachment, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ModalSubmitInteraction, StringSelectMenuInteraction } from 'discord.js';
import { getUser, updateUser, getConfig } from '../db';
import { verifyWalletAndGetNFTs, NFTData } from '../logic/SolanaVerifier';
import { BattleManager } from '../logic/BattleManager';

// Custom Error for Multiple NFTs
class MultipleNFTsError extends Error {
    nfts: NFTData[];
    wallet: string;
    constructor(nfts: NFTData[], wallet: string) {
        super("Multiple NFTs found");
        this.nfts = nfts;
        this.wallet = wallet;
    }
}

// Custom Error for Multiple Collections
class MultipleCollectionsError extends Error {
    groups: string[];
    wallet: string;
    constructor(groups: string[], wallet: string) {
        super("Multiple Collections found");
        this.groups = groups;
        this.wallet = wallet;
    }
}

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
const activeBattles: Map<string, BattleManager> = new Map(); // Key: ChannelID

async function validateAndGetPlayerData(
    user: User,
    type: 'UPLOAD' | 'PFP' | 'WALLET',
    options: { image?: Attachment, wallet?: string, selectedMint?: string, selectedCollectionGroup?: string }
): Promise<Player> {
    let avatarUrl = user.displayAvatarURL({ extension: 'png', size: 512 });
    let walletAddress: string | undefined;
    let nftAttributes: any[] | undefined;

    if (type === 'UPLOAD') {
        if (!options.image) throw new Error("You must upload an image!");
        avatarUrl = options.image.url;
    } else if (type === 'WALLET') {
        // Check if wallet is provided OR in DB
        let walletToUse = options.wallet;
        if (!walletToUse) {
            const dbUser = await getUser(user.id);
            if (dbUser && dbUser.wallet_address) {
                walletToUse = dbUser.wallet_address;
            }
        }

        if (!walletToUse) throw new Error("You must provide a Solana Wallet Address (or set it via /wallet set)!");
        
        const nfts = await verifyWalletAndGetNFTs(walletToUse);
        if (nfts.length === 0) throw new Error("No valid NFT found in this wallet! (Must be a single NFT, not a token)");
        
        let filteredNFTs = nfts;

        // Check for multiple collections
        const enablePartners = await getConfig('enable_partners') === 'true';
        if (enablePartners) {
            // Get unique groups from the NFTs found in wallet
            const groups = Array.from(new Set(nfts.map(n => n.collectionGroup || 'Unknown'))).filter(g => g !== 'Unknown');
            
            if (options.selectedCollectionGroup) {
                filteredNFTs = nfts.filter(n => n.collectionGroup === options.selectedCollectionGroup);
                if (filteredNFTs.length === 0) throw new Error("No NFTs found in the selected collection.");
            } else if (groups.length > 1) {
                // If user has NFTs from multiple configured collections, ask them to choose
                throw new MultipleCollectionsError(groups, walletToUse);
            }
        }

        let selectedNFT: NFTData;

        if (options.selectedMint) {
            const found = filteredNFTs.find(n => n.mint === options.selectedMint);
            if (!found) throw new Error("Selected NFT not found in wallet (or verification failed).");
            selectedNFT = found;
        } else {
            // Pick a random NFT from the valid ones (filtered by collection if applicable)
            selectedNFT = filteredNFTs[Math.floor(Math.random() * filteredNFTs.length)];
        }
        
        avatarUrl = selectedNFT.image;
        walletAddress = walletToUse;
        nftAttributes = selectedNFT.attributes;
    }

    return {
        id: user.id,
        username: user.username,
        avatarUrl,
        isOnline: true,
        walletAddress,
        nftAttributes
    };
}

export const data = new SlashCommandBuilder()
    .setName('battle')
    .setDescription('Infinite Heroes Battle Royale')
    .addSubcommand(sub =>
        sub
            .setName('create')
            .setDescription('Start a new Battle Lobby (Opens Wizard)')
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

        // Step 1: Select Menu for Type
        const select = new StringSelectMenuBuilder()
            .setCustomId('battle_create_type')
            .setPlaceholder('Select Registration Mode')
            .addOptions(
                { label: 'Solana Wallet (NFT)', value: 'WALLET', description: 'Use an NFT from your wallet', emoji: '💳' },
                { label: 'Discord PFP', value: 'PFP', description: 'Use your Discord Profile Picture', emoji: '🖼️' },
                { label: 'Image Upload', value: 'UPLOAD', description: 'Upload a custom image', emoji: '📤' },
            );

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

        await interaction.reply({ 
            content: "⚔️ **Create Battle Lobby**\nSelect how players will register:", 
            components: [row],
            ephemeral: true 
        });
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

        await interaction.deferReply();

        try {
            let player: Player;
            try {
                player = await validateAndGetPlayerData(interaction.user, lobby.settings.registrationType, {
                    image: interaction.options.getAttachment('image') || undefined,
                    wallet: interaction.options.getString('wallet') || undefined
                });
            } catch (error) {
                if (error instanceof MultipleCollectionsError) {
                    // Show Select Menu for Collections
                    const select = new StringSelectMenuBuilder()
                        .setCustomId('battle_join_collection_select')
                        .setPlaceholder('Select a Collection')
                        .addOptions(error.groups.map(g => ({ label: g, value: g })));
                    
                    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
                    
                    const response = await interaction.editReply({
                        content: "⚠️ **Multiple Collections Found!**\nPlease select which collection you want to use:",
                        components: [row]
                    });

                    try {
                        const confirmation = await response.awaitMessageComponent({ filter: i => i.user.id === interaction.user.id, time: 60000, componentType: ComponentType.StringSelect });
                        
                        const selectedGroup = (confirmation as StringSelectMenuInteraction).values[0];
                        await confirmation.update({ content: `✅ Selected **${selectedGroup}**. Entering arena...`, components: [] });
                        
                        player = await validateAndGetPlayerData(interaction.user, lobby.settings.registrationType, {
                            image: interaction.options.getAttachment('image') || undefined,
                            wallet: interaction.options.getString('wallet') || undefined,
                            selectedCollectionGroup: selectedGroup
                        });
                    } catch (e) {
                        await interaction.editReply({ content: "❌ Selection timed out or failed.", components: [] });
                        return;
                    }
                } else {
                    throw error;
                }
            }

            lobby.players.push(player);

            const playerList = lobby.players.map((p, i) => `**${i + 1}.** ${p.username}`).join('\n');
            const updateEmbed = new EmbedBuilder()
                .setTitle(`⚔️ BATTLE ROYALE: ${lobby.settings.arena}`)
                .setDescription(`**Host:** <@${lobby.hostId}>\n**Mode:** ${lobby.settings.registrationType}\n**Players:** ${lobby.players.length}/${lobby.maxPlayers}\n\n**Registered Fighters:**\n${playerList}\n\nType \`/battle join\` to enter!`)
                .addFields(
                    { name: '📜 Rules', value: '• Online players beat offline players.\n• NFT Stats based on rarity traits.' },
                    { name: '🎮 Commands', value: '• \`/battle join\` - Join Lobby\n• \`/wallet set\` - Link Wallet' }
                )
                .setColor(0xFFD700)
                .setThumbnail(lobby.players[0].avatarUrl);

            await interaction.editReply({ embeds: [updateEmbed] });
            
            if (lobby.players.length === lobby.maxPlayers) {
                const host = await interaction.client.users.fetch(lobby.hostId);
                await interaction.followUp(`📢 **Lobby Full!** ${host.toString()}, type \`/battle start\` to begin!`);
            }
        } catch (error: any) {
            await interaction.editReply({ content: `❌ Failed to join: ${error.message}` });
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
        
        if (!(interaction.channel instanceof TextChannel)) {
             await interaction.reply({ content: "❌ Battles can only be run in Text Channels.", ephemeral: true });
             return;
        }

        const battleManager = new BattleManager(channelId, interaction.channel, {
            arena: lobby.settings.arena,
            genre: lobby.settings.genre,
            style: "Comic Book"
        });

        for (const p of lobby.players) {
            battleManager.addPlayer(p);
        }

        activeBattles.set(channelId, battleManager);
        activeLobbies.delete(channelId);

        await interaction.reply({ content: `🔥 **THE BATTLE BEGINS!**\nArena: ${lobby.settings.arena}\nFighters: ${lobby.players.map(p => p.username).join(', ')}` });

        // Start the battle logic
        await battleManager.startBattle();
    }
}

// Handle Select Menu and Modals
export async function handleInteraction(interaction: StringSelectMenuInteraction | ModalSubmitInteraction) {
    if (interaction.isStringSelectMenu() && interaction.customId === 'battle_create_type') {
        const type = interaction.values[0];
        
        const modal = new ModalBuilder()
            .setCustomId(`battle_create_modal_${type}`)
            .setTitle('Lobby Settings');

        const playersInput = new TextInputBuilder()
            .setCustomId('max_players')
            .setLabel("Max Players (2-16)")
            .setStyle(TextInputStyle.Short)
            .setValue('2')
            .setRequired(true);

        const arenaInput = new TextInputBuilder()
            .setCustomId('arena')
            .setLabel("Arena Name")
            .setStyle(TextInputStyle.Short)
            .setValue('The Void')
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(playersInput),
            new ActionRowBuilder<TextInputBuilder>().addComponents(arenaInput)
        );

        if (type === 'WALLET') {
            // Check if user has wallet in DB to pre-fill? (Can't async pre-fill easily in this flow without delay)
            // We'll just ask for it.
            const walletInput = new TextInputBuilder()
                .setCustomId('wallet_address')
                .setLabel("Your Wallet Address")
                .setStyle(TextInputStyle.Short)
                .setPlaceholder("Solana Address")
                .setRequired(true);
            
            modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(walletInput));
        }

        await interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('battle_create_modal_')) {
        const type = interaction.customId.replace('battle_create_modal_', '') as 'UPLOAD' | 'PFP' | 'WALLET';
        const maxPlayers = parseInt(interaction.fields.getTextInputValue('max_players'));
        const arena = interaction.fields.getTextInputValue('arena');
        const channelId = interaction.channelId!;

        if (isNaN(maxPlayers) || maxPlayers < 2 || maxPlayers > 16) {
            await interaction.reply({ content: "❌ Players must be between 2 and 16.", ephemeral: true });
            return;
        }

        if (activeLobbies.has(channelId)) {
            await interaction.reply({ content: "❌ A lobby is already active in this channel!", ephemeral: true });
            return;
        }

        await interaction.deferReply();

        try {
            let hostPlayer: Player | undefined;

            // For UPLOAD, we cannot get the image from Modal. Host must join manually.
            if (type === 'UPLOAD') {
                // Do not register host yet
            } else {
                // For WALLET or PFP, try to register host
                let wallet = undefined;
                if (type === 'WALLET') {
                    wallet = interaction.fields.getTextInputValue('wallet_address');
                    // Also save to DB for future convenience?
                    await updateUser(interaction.user.id, { wallet_address: wallet });
                }

                try {
                    hostPlayer = await validateAndGetPlayerData(interaction.user, type, { wallet });
                } catch (error) {
                    if (error instanceof MultipleCollectionsError) {
                        // Show Select Menu
                        const select = new StringSelectMenuBuilder()
                            .setCustomId('battle_create_collection_select')
                            .setPlaceholder('Select a Collection')
                            .addOptions(error.groups.map(g => ({ label: g, value: g })));
                        
                        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
                        
                        const response = await interaction.editReply({
                            content: "⚠️ **Multiple Collections Found!**\nPlease select which collection you want to use for your fighter:",
                            components: [row]
                        });

                        try {
                            const confirmation = await response.awaitMessageComponent({ 
                                filter: i => i.user.id === interaction.user.id, 
                                time: 60000, 
                                componentType: ComponentType.StringSelect 
                            });
                            
                            const selectedGroup = (confirmation as StringSelectMenuInteraction).values[0];
                            
                            await confirmation.update({ content: `✅ Selected **${selectedGroup}**. Creating lobby...`, components: [] });
                            
                            hostPlayer = await validateAndGetPlayerData(interaction.user, type, { 
                                wallet, 
                                selectedCollectionGroup: selectedGroup 
                            });
                        } catch (e) {
                            await interaction.editReply({ content: "❌ Selection timed out or failed. Lobby creation cancelled.", components: [] });
                            return;
                        }
                    } else {
                        throw error;
                    }
                }
            }

            const lobby: Lobby = {
                hostId: interaction.user.id,
                channelId: channelId,
                players: hostPlayer ? [hostPlayer] : [],
                maxPlayers: maxPlayers,
                status: 'OPEN',
                settings: {
                    arena: arena,
                    genre: 'Action',
                    registrationType: type
                }
            };

            activeLobbies.set(channelId, lobby);

            const playerList = lobby.players.length > 0 ? `**1.** ${lobby.players[0].username}` : 'Waiting for host to join...';
            const thumbnail = lobby.players.length > 0 ? lobby.players[0].avatarUrl : undefined;

            const embed = new EmbedBuilder()
                .setTitle(`⚔️ BATTLE ROYALE: ${arena}`)
                .setDescription(`**Host:** ${interaction.user.username}\n**Mode:** ${type}\n**Players:** ${lobby.players.length}/${maxPlayers}\n\n**Registered Fighters:**\n${playerList}\n\nType \`/battle join\` to enter!`)
                .addFields(
                    { name: '📜 Rules', value: '• Online players beat offline players.\n• NFT Stats based on rarity traits.' },
                    { name: '🎮 Commands', value: '• \`/battle join\` - Join Lobby\n• \`/wallet set\` - Link Wallet' }
                )
                .setColor(0xFFD700);
            
            if (thumbnail) embed.setThumbnail(thumbnail);

            await interaction.editReply({ embeds: [embed] });

            if (type === 'UPLOAD') {
                await interaction.followUp({ content: `✅ **Lobby Created!** Host, please use \`/battle join image:<attachment>\` to register your fighter!`, ephemeral: true });
            }

        } catch (error: any) {
            await interaction.editReply({ content: `❌ Failed to create lobby: ${error.message}` });
            activeLobbies.delete(channelId); // Cleanup
        }
    }

    /* 
    // Removed Select Menu Handler as we now auto-select random NFT
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('battle_select_nft_')) {
        ...
    } 
    */
}
