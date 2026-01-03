import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, TextChannel, User, Attachment, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ModalSubmitInteraction, StringSelectMenuInteraction } from 'discord.js';
import { getUser, updateUser, getConfig } from '../db';
import { verifyWalletAndGetNFTs, NFTData, getAvailableCollections } from '../logic/SolanaVerifier';
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

// Custom Error for Multiple Collections (Legacy, but kept for safety)
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
    autoStartTimer?: NodeJS.Timeout;
    countdownInterval?: NodeJS.Timeout;
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
        
        // Pass the selected collection group to the verifier
        const nfts = await verifyWalletAndGetNFTs(walletToUse, options.selectedCollectionGroup);
        
        if (nfts.length === 0) {
            if (options.selectedCollectionGroup) {
                throw new Error(`No NFTs found in wallet from collection: ${options.selectedCollectionGroup}`);
            } else {
                throw new Error("No valid NFT found in this wallet!");
            }
        }
        
        let filteredNFTs = nfts;

        // Legacy check for multiple collections (should be handled before calling this now)
        if (!options.selectedCollectionGroup) {
            const enablePartners = await getConfig('enable_partners') === 'true';
            if (enablePartners) {
                const groups = Array.from(new Set(nfts.map(n => n.collectionGroup || 'Unknown'))).filter(g => g !== 'Unknown');
                if (groups.length > 1) {
                    throw new MultipleCollectionsError(groups, walletToUse);
                }
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
    )
    .addSubcommand(sub =>
        sub
            .setName('fill_bots')
            .setDescription('DEBUG: Add dummy bots to the lobby')
            .addIntegerOption(opt => opt.setName('count').setDescription('Number of bots to add').setRequired(true))
    );

export async function execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();
    const channelId = interaction.channelId;

    if (subcommand === 'fill_bots') {
        const lobby = activeLobbies.get(channelId);
        if (!lobby || lobby.status !== 'OPEN') {
            await interaction.reply({ content: "❌ No open lobby in this channel.", ephemeral: true });
            return;
        }

        const count = interaction.options.getInteger('count', true);
        const addedBots: string[] = [];

        for (let i = 0; i < count; i++) {
            if (lobby.players.length >= lobby.maxPlayers) break;
            
            const botId = `bot_${Date.now()}_${i}`;
            const botName = `Bot Fighter ${i + 1}`;
            // Use a generic placeholder image
            const botAvatar = "https://cdn.discordapp.com/embed/avatars/0.png"; 

            lobby.players.push({
                id: botId,
                username: botName,
                avatarUrl: botAvatar,
                isOnline: true,
                gender: 'Male' // Default for bots
            } as any); // Cast to any to bypass strict Player type if needed, or update Player type
            
            addedBots.push(botName);
        }

        await interaction.reply({ content: `🤖 **Added ${addedBots.length} Bots:**\n${addedBots.join(', ')}\n\nTotal Players: ${lobby.players.length}/${lobby.maxPlayers}` });
        
        // Update Lobby UI if possible (optional, but good for UX)
        return;
    }

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
                    // Note: error.groups contains the IDs/Labels from the error, but we want friendly names if possible.
                    // However, MultipleCollectionsError is thrown deep inside.
                    // Let's re-fetch available collections to get friendly names matching the error groups.
                    const availableCollections = await getAvailableCollections();
                    
                    const select = new StringSelectMenuBuilder()
                        .setCustomId('battle_join_collection_select')
                        .setPlaceholder('Select a Collection')
                        .addOptions(error.groups.map(g => {
                            const name = availableCollections.get(g) || g;
                            return { label: name.substring(0, 100), value: g };
                        }));
                    
                    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
                    
                    const response = await interaction.editReply({
                        content: "⚠️ **Multiple Collections Found!**\nPlease select which collection you want to use:",
                        components: [row]
                    });

                    try {
                        const confirmation = await response.awaitMessageComponent({ filter: i => i.user.id === interaction.user.id, time: 60000, componentType: ComponentType.StringSelect });
                        
                        const selectedGroup = (confirmation as StringSelectMenuInteraction).values[0];
                        const friendlyName = availableCollections.get(selectedGroup) || selectedGroup;
                        
                        await confirmation.update({ content: `✅ Selected **${friendlyName}**. Entering arena...`, components: [] });
                        
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
                .setThumbnail(player.avatarUrl);

            await interaction.editReply({ embeds: [updateEmbed] });
            
            if (lobby.players.length === lobby.maxPlayers) {
                const host = await interaction.client.users.fetch(lobby.hostId);
                await interaction.followUp(`📢 **Lobby Full!** Starting in 5 minutes...`);
                
                // Start Countdown
                let timeLeft = 300; // 5 minutes in seconds
                
                // Clear any existing timer
                if (lobby.autoStartTimer) clearTimeout(lobby.autoStartTimer);
                if (lobby.countdownInterval) clearInterval(lobby.countdownInterval);

                lobby.countdownInterval = setInterval(async () => {
                    timeLeft -= 60;
                    if (timeLeft > 0) {
                        if (interaction.channel && 'send' in interaction.channel) {
                            await (interaction.channel as TextChannel).send(`⏳ **Battle starting in ${timeLeft / 60} minutes...**`);
                        }
                        
                        // Pings
                        if (timeLeft === 300 || timeLeft === 180) { // 5m (already sent above), 3m
                             if (interaction.channel && 'send' in interaction.channel) {
                                await (interaction.channel as TextChannel).send(`@everyone 📢 **Battle starting in ${timeLeft / 60} minutes!** Join now if spots open! (Wait, it's full)`);
                             }
                        }
                    } else {
                        if (lobby.countdownInterval) clearInterval(lobby.countdownInterval);
                    }
                }, 60000);

                // Final 30s ping
                setTimeout(async () => {
                     if (activeLobbies.has(channelId)) {
                        if (interaction.channel && 'send' in interaction.channel) {
                            await (interaction.channel as TextChannel).send(`@everyone ⚠️ **Battle starting in 30 seconds!**`);
                        }
                     }
                }, 270000); // 4m 30s

                // Auto Start
                lobby.autoStartTimer = setTimeout(async () => {
                    if (activeLobbies.has(channelId)) {
                        const currentLobby = activeLobbies.get(channelId);
                        if (currentLobby && currentLobby.status === 'OPEN') {
                            await startBattleLogic(interaction.channel as TextChannel, currentLobby);
                        }
                    }
                }, 300000); // 5 minutes
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

        // Enforce Even Brackets (Powers of 2: 2, 4, 8, 16)
        const validCounts = [2, 4, 8, 16];
        // Gang Mode Exception
        const isGangMode = lobby.settings.genre === 'GANG_MODE'; 
        
        if (!isGangMode && !validCounts.includes(lobby.players.length)) {
             await interaction.reply({ content: `❌ **Even Brackets Enforced!**\nCurrent player count: ${lobby.players.length}.\nRequired: 2, 4, 8, or 16 players.\n\nPlease wait for more players or kick someone to match the bracket.`, ephemeral: true });
             return;
        }

        // Cancel auto-start if manually started
        if (lobby.autoStartTimer) clearTimeout(lobby.autoStartTimer);
        if (lobby.countdownInterval) clearInterval(lobby.countdownInterval);

        await interaction.reply({ content: "🚀 Battle Started Manually!", ephemeral: true });
        await startBattleLogic(interaction.channel as TextChannel, lobby);
    }
}

async function startBattleLogic(channel: TextChannel, lobby: Lobby) {
    lobby.status = 'IN_PROGRESS';
    
    const battle = new BattleManager(channel.id, channel, {
        arena: lobby.settings.arena,
        genre: lobby.settings.genre,
        style: "Comic Book" // Default style
    });

    lobby.players.forEach(p => battle.addPlayer(p));
    activeBattles.set(channel.id, battle);
    activeLobbies.delete(channel.id); // Remove lobby once battle starts

    await battle.startBattle();
}

// Handle Select Menu and Modals
export async function handleInteraction(interaction: StringSelectMenuInteraction | ModalSubmitInteraction) {
    // Step 1: Registration Type Selected -> Show Game Mode Select
    if (interaction.isStringSelectMenu() && interaction.customId === 'battle_create_type') {
        const type = interaction.values[0];
        
        // Check if Gang Mode is enabled via config
        const enablePartners = await getConfig('enable_partners') === 'true';
        const partnerCollections = await getConfig('partner_collections');
        const hasPartners = enablePartners || (partnerCollections && partnerCollections.length > 0);

        const modeSelect = new StringSelectMenuBuilder()
            .setCustomId(`battle_create_mode_${type}`)
            .setPlaceholder('Select Game Mode')
            .addOptions(
                { label: 'Battle Royale', value: 'BATTLE_ROYALE', description: 'Standard Tournament Bracket (1v1)', emoji: '🏆' }
            );

        if (hasPartners) {
            modeSelect.addOptions(
                { label: 'Gang Mode', value: 'GANG_MODE', description: 'Team Battle (3v3, 5v5, etc.)', emoji: '👊' }
            );
        }

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(modeSelect);
        
        await interaction.update({ content: "⚔️ **Select Game Mode**", components: [row] });
    }

    // Step 2: Game Mode Selected -> Show Venue Select
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('battle_create_mode_')) {
        const type = interaction.customId.replace('battle_create_mode_', '') as 'UPLOAD' | 'PFP' | 'WALLET';
        const mode = interaction.values[0];

        const venueSelect = new StringSelectMenuBuilder()
            .setCustomId(`battle_create_venue_${type}_${mode}`)
            .setPlaceholder('Select Venue')
            .addOptions(
                { label: 'The Void', value: 'The Void', description: 'A dark, empty expanse', emoji: '⚫' },
                { label: 'Cyber City', value: 'Cyber City', description: 'Neon-lit futuristic streets', emoji: '🏙️' },
                { label: 'Ancient Colosseum', value: 'Ancient Colosseum', description: 'Gladiator arena', emoji: '🏛️' },
                { label: 'Magma Chamber', value: 'Magma Chamber', description: 'Volcanic underground', emoji: '🌋' },
                { label: 'Sky Sanctuary', value: 'Sky Sanctuary', description: 'Floating islands', emoji: '☁️' }
            );

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(venueSelect);
        
        await interaction.update({ content: "🏟️ **Select Venue**", components: [row] });
    }

    // Step 3: Venue Selected -> Show Final Settings Modal
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('battle_create_venue_')) {
        const parts = interaction.customId.split('_');
        // battle_create_venue_TYPE_MODE
        const type = parts[3] as 'UPLOAD' | 'PFP' | 'WALLET';
        const mode = parts[4]; 
        const venue = interaction.values[0];
        const safeVenue = venue.replace(/\s/g, '_');

        const modal = new ModalBuilder()
            .setCustomId(`battle_create_final_${type}_${mode}_${safeVenue}`)
            .setTitle('Final Settings');

        let playersLabel = "Max Players (2, 4, 8, 16)";
        let defaultPlayers = "2";

        if (mode === 'GANG_MODE') {
            playersLabel = "Total Players (4-24, Even Only)";
            defaultPlayers = "6"; // Default to 3v3
        }

        const playersInput = new TextInputBuilder()
            .setCustomId('max_players')
            .setLabel(playersLabel)
            .setStyle(TextInputStyle.Short)
            .setValue(defaultPlayers)
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(playersInput)
        );

        if (type === 'WALLET') {
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

    // Step 4: Modal Submitted -> Create Lobby
    if (interaction.isModalSubmit() && interaction.customId.startsWith('battle_create_final_')) {
        const parts = interaction.customId.split('_');
        // battle, create, final, TYPE, MODE, VENUE
        const type = parts[3] as 'UPLOAD' | 'PFP' | 'WALLET';
        const mode = parts[4];
        const venue = parts.slice(5).join(' ').replace(/_/g, ' '); // Reconstruct venue

        const maxPlayers = parseInt(interaction.fields.getTextInputValue('max_players'));
        const channelId = interaction.channelId!;

        // Enforce Bracket Rules
        if (mode === 'GANG_MODE') {
            // Gang Mode: 4-24 players, Even numbers only
            if (isNaN(maxPlayers) || maxPlayers < 4 || maxPlayers > 24 || maxPlayers % 2 !== 0) {
                await interaction.reply({ 
                    content: "❌ **Invalid Player Count for Gang Mode!**\nMust be between 4 and 24, and an EVEN number (e.g., 6 for 3v3, 10 for 5v5).", 
                    ephemeral: true 
                });
                return;
            }
        } else {
            // Battle Royale: Powers of 2 (2, 4, 8, 16)
            const validCounts = [2, 4, 8, 16];
            if (!validCounts.includes(maxPlayers)) {
                await interaction.reply({ content: "❌ **Even Brackets Only!** Max players must be 2, 4, 8, or 16.", ephemeral: true });
                return;
            }
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
                let selectedCollectionGroup: string | undefined;

                if (type === 'WALLET') {
                    wallet = interaction.fields.getTextInputValue('wallet_address');
                    // Also save to DB for future convenience?
                    await updateUser(interaction.user.id, { wallet_address: wallet });

                    // Check for multiple collections BEFORE verifying wallet
                    const availableCollections = await getAvailableCollections();
                    
                    if (availableCollections.size > 1) {
                        // Ask user to select collection
                        const select = new StringSelectMenuBuilder()
                            .setCustomId('battle_create_collection_select_temp')
                            .setPlaceholder('Select a Collection')
                            .addOptions(Array.from(availableCollections.entries()).map(([id, name]) => ({ 
                                label: name.substring(0, 100), 
                                value: id 
                            })));
                        
                        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
                        
                        const response = await interaction.editReply({
                            content: "⚠️ **Multiple Collections Available!**\nPlease select which collection you want to use for your fighter:",
                            components: [row]
                        });

                        try {
                            const confirmation = await response.awaitMessageComponent({ 
                                filter: i => i.user.id === interaction.user.id, 
                                time: 60000, 
                                componentType: ComponentType.StringSelect 
                            });
                            
                            selectedCollectionGroup = (confirmation as StringSelectMenuInteraction).values[0];
                            
                            // Get the label for the selected group to show a friendly name
                            const friendlyName = availableCollections.get(selectedCollectionGroup) || selectedCollectionGroup;

                            await confirmation.update({ content: `✅ Selected **${friendlyName}**. Verifying wallet...`, components: [] });
                        } catch (e) {
                            await interaction.editReply({ content: "❌ Selection timed out. Lobby creation cancelled.", components: [] });
                            return;
                        }
                    } else if (availableCollections.size === 1) {
                        selectedCollectionGroup = availableCollections.keys().next().value;
                    }
                }

                try {
                    hostPlayer = await validateAndGetPlayerData(interaction.user, type, { wallet, selectedCollectionGroup });
                } catch (error) {
                    if (error instanceof MultipleCollectionsError) {
                        // This fallback should rarely be hit now, but kept for safety
                        const availableCollections = await getAvailableCollections();
                        
                        const select = new StringSelectMenuBuilder()
                            .setCustomId('battle_create_collection_select')
                            .setPlaceholder('Select a Collection')
                            .addOptions(error.groups.map(g => {
                                const name = availableCollections.get(g) || g;
                                return { label: name.substring(0, 100), value: g };
                            }));
                        
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
                            const friendlyName = availableCollections.get(selectedGroup) || selectedGroup;
                            
                            await confirmation.update({ content: `✅ Selected **${friendlyName}**. Creating lobby...`, components: [] });
                            
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
                    arena: venue,
                    genre: mode,
                    registrationType: type
                }
            };

            activeLobbies.set(channelId, lobby);

            const playerList = lobby.players.length > 0 ? `**1.** ${lobby.players[0].username}` : 'Waiting for host to join...';
            const thumbnail = lobby.players.length > 0 ? lobby.players[0].avatarUrl : undefined;

            const embed = new EmbedBuilder()
                .setTitle(`⚔️ ${mode.replace('_', ' ')}: ${venue}`)
                .setDescription(`**Host:** ${interaction.user.username}\n**Type:** ${type}\n**Players:** ${lobby.players.length}/${maxPlayers}\n\n**Registered Fighters:**\n${playerList}\n\nType \`/battle join\` to enter!`)
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
