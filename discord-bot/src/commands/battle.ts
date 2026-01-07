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
        teamA?: { name: string, collectionId: string };
        teamB?: { name: string, collectionId: string };
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
    team?: 'A' | 'B';
}

const activeLobbies: Map<string, Lobby> = new Map(); // Key: ChannelID
const activeBattles: Map<string, BattleManager> = new Map(); // Key: ChannelID

// Pending setup state for multi-step creation
interface PendingSetup {
    type?: 'UPLOAD' | 'PFP' | 'WALLET';
    mode?: string;
    teamA?: { name: string, id: string };
    teamB?: { name: string, id: string };
    venue?: string;
}
const pendingLobbySetup: Map<string, PendingSetup> = new Map(); // Key: UserId

async function validateAndGetPlayerData(
    user: User,
    type: 'UPLOAD' | 'PFP' | 'WALLET',
    options: { image?: Attachment, wallet?: string, selectedMint?: string, selectedCollectionGroup?: string, requiredCollection?: string }
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
        // If requiredCollection is set (Gang Mode), we MUST use it.
        const collectionFilter = options.requiredCollection || options.selectedCollectionGroup;
        const nfts = await verifyWalletAndGetNFTs(walletToUse, collectionFilter);
        
        if (nfts.length === 0) {
            if (collectionFilter) {
                // Fetch friendly name for error message
                const collections = await getAvailableCollections();
                const friendlyName = collections.get(collectionFilter) || collectionFilter;
                throw new Error(`No NFTs found in wallet from collection: **${friendlyName}**`);
            } else {
                throw new Error("No valid NFT found in this wallet!");
            }
        }
        
        let filteredNFTs = nfts;

        // Legacy check for multiple collections (should be handled before calling this now)
        if (!options.selectedCollectionGroup && !options.requiredCollection) {
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
            let requiredCollection: string | undefined;
            let selectedTeam: 'A' | 'B' | undefined;

            // Gang Mode: Ask for Team Selection
            if (lobby.settings.genre === 'GANG_MODE' && lobby.settings.teamA && lobby.settings.teamB) {
                const teamA = lobby.settings.teamA;
                const teamB = lobby.settings.teamB;

                const row = new ActionRowBuilder<ButtonBuilder>()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('join_team_a')
                            .setLabel(`Join ${teamA.name}`)
                            .setStyle(ButtonStyle.Danger),
                        new ButtonBuilder()
                            .setCustomId('join_team_b')
                            .setLabel(`Join ${teamB.name}`)
                            .setStyle(ButtonStyle.Primary)
                    );

                const response = await interaction.editReply({
                    content: `⚔️ **Choose Your Side!**\n🔴 **${teamA.name}** vs 🔵 **${teamB.name}**`,
                    components: [row]
                });

                try {
                    const confirmation = await response.awaitMessageComponent({ 
                        filter: i => i.user.id === interaction.user.id, 
                        time: 60000, 
                        componentType: ComponentType.Button 
                    });

                    if (confirmation.customId === 'join_team_a') {
                        requiredCollection = teamA.collectionId;
                        selectedTeam = 'A';
                        await confirmation.update({ content: `🔴 Selected **${teamA.name}**. Verifying wallet...`, components: [] });
                    } else {
                        requiredCollection = teamB.collectionId;
                        selectedTeam = 'B';
                        await confirmation.update({ content: `🔵 Selected **${teamB.name}**. Verifying wallet...`, components: [] });
                    }
                } catch (e) {
                    await interaction.editReply({ content: "❌ Selection timed out.", components: [] });
                    return;
                }
            }

            try {
                player = await validateAndGetPlayerData(interaction.user, lobby.settings.registrationType, {
                    image: interaction.options.getAttachment('image') || undefined,
                    wallet: interaction.options.getString('wallet') || undefined,
                    requiredCollection: requiredCollection
                });
                
                if (selectedTeam) {
                    player.team = selectedTeam;
                }

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

            const playerList = lobby.players.map((p, i) => `**${i + 1}.** ${p.username} ${p.team ? `(${p.team})` : ''}`).join('\n');
            
            let description = `**Host:** <@${lobby.hostId}>\n**Mode:** ${lobby.settings.registrationType}\n**Players:** ${lobby.players.length}/${lobby.maxPlayers}\n\n**Registered Fighters:**\n${playerList}\n\nType \`/battle join\` to enter!`;
            
            if (lobby.settings.genre === 'GANG_MODE' && lobby.settings.teamA && lobby.settings.teamB) {
                 description = `**Host:** <@${lobby.hostId}>\n**Mode:** Gang War\n**Matchup:** ${lobby.settings.teamA.name} 🆚 ${lobby.settings.teamB.name}\n**Players:** ${lobby.players.length}/${lobby.maxPlayers}\n\n**Registered Fighters:**\n${playerList}\n\nType \`/battle join\` to pick your side!`;
            }

            const updateEmbed = new EmbedBuilder()
                .setTitle(`⚔️ ${lobby.settings.genre === 'GANG_MODE' ? 'GANG WAR' : 'BATTLE ROYALE'}: ${lobby.settings.arena}`)
                .setDescription(description)
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
                            try {
                                const channel = await interaction.client.channels.fetch(channelId) as TextChannel;
                                if (channel) {
                                    await startBattleLogic(channel, currentLobby);
                                } else {
                                    console.error("Auto-start failed: Channel not found");
                                    activeLobbies.delete(channelId);
                                }
                            } catch (e) {
                                console.error("Auto-start error:", e);
                            }
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

        // Enforce Even Brackets (2-24)
        const isGangMode = lobby.settings.genre === 'GANG_MODE'; 
        
        if (isGangMode) {
             const validGangCounts = [4, 8, 16];
             if (!validGangCounts.includes(lobby.players.length)) {
                 await interaction.reply({ content: `❌ **Gang Mode Requires 4, 8, or 16 Players!**\nCurrent count: ${lobby.players.length}.\n\nPlease wait for more players or kick someone to match the bracket.`, ephemeral: true });
                 return;
             }
        } else {
            if (lobby.players.length < 2 || lobby.players.length > 24 || lobby.players.length % 2 !== 0) {
                 await interaction.reply({ content: `❌ **Even Brackets Enforced!**\nCurrent player count: ${lobby.players.length}.\nRequired: Even number between 2 and 24.\n\nPlease wait for more players or kick someone to match the bracket.`, ephemeral: true });
                 return;
             }
        }

        // Cancel auto-start if manually started
        if (lobby.autoStartTimer) clearTimeout(lobby.autoStartTimer);
        if (lobby.countdownInterval) clearInterval(lobby.countdownInterval);

        if (!interaction.channel) {
            await interaction.reply({ content: "❌ Error: Channel context not found.", ephemeral: true });
            return;
        }

        await interaction.reply({ content: "🚀 Battle Started Manually!", ephemeral: true });
        try {
            await startBattleLogic(interaction.channel as TextChannel, lobby);
        } catch (e: any) {
            console.error("Battle Start Error:", e);
            await interaction.followUp({ content: `❌ Battle crashed: ${e.message}`, ephemeral: true });
        }
    }
}

async function startBattleLogic(channel: TextChannel, lobby: Lobby) {
    lobby.status = 'IN_PROGRESS';
    
    const battle = new BattleManager(channel.id, channel, {
        arena: lobby.settings.arena,
        genre: lobby.settings.genre,
        style: "Comic Book", // Default style
        teamA: lobby.settings.teamA?.name,
        teamB: lobby.settings.teamB?.name
    });

    lobby.players.forEach(p => battle.addPlayer(p));
    activeBattles.set(channel.id, battle);
    activeLobbies.delete(channel.id); // Remove lobby once battle starts

    await battle.startBattle();
}

// Handle Select Menu and Modals
export async function handleInteraction(interaction: StringSelectMenuInteraction | ModalSubmitInteraction) {
    const userId = interaction.user.id;

    // Step 1: Registration Type Selected -> Show Game Mode Select
    if (interaction.isStringSelectMenu() && interaction.customId === 'battle_create_type') {
        const type = interaction.values[0] as 'UPLOAD' | 'PFP' | 'WALLET';
        
        // Initialize pending setup
        pendingLobbySetup.set(userId, { type });

        // Check if Gang Mode is enabled via config
        const enablePartners = await getConfig('enable_partners') === 'true';
        const partnerCollections = await getConfig('partner_collections');
        const hasPartners = enablePartners || (partnerCollections && partnerCollections.length > 0);

        const modeSelect = new StringSelectMenuBuilder()
            .setCustomId(`battle_create_mode`)
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

    // Step 2: Game Mode Selected -> Show Venue OR Team Select
    if (interaction.isStringSelectMenu() && interaction.customId === 'battle_create_mode') {
        const mode = interaction.values[0];
        const setup = pendingLobbySetup.get(userId);
        if (!setup) {
            await interaction.reply({ content: "❌ Session expired. Please start over.", ephemeral: true });
            return;
        }
        setup.mode = mode;
        pendingLobbySetup.set(userId, setup);

        if (mode === 'GANG_MODE') {
            // Show Team A Select
            const availableCollections = await getAvailableCollections();
            const select = new StringSelectMenuBuilder()
                .setCustomId('battle_create_teama')
                .setPlaceholder('Select Team A Collection')
                .addOptions(Array.from(availableCollections.entries()).map(([id, name]) => ({
                    label: name.substring(0, 100),
                    value: id
                })));

            const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
            await interaction.update({ content: "🔴 **Select Team A (Red Team)**", components: [row] });
        } else {
            // Show Venue Select
            const venueSelect = new StringSelectMenuBuilder()
                .setCustomId(`battle_create_venue`)
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
    }

    // Step 3: Team A Selected -> Show Team B Select
    if (interaction.isStringSelectMenu() && interaction.customId === 'battle_create_teama') {
        const teamAId = interaction.values[0];
        const setup = pendingLobbySetup.get(userId);
        if (!setup) return;

        const availableCollections = await getAvailableCollections();
        const teamAName = availableCollections.get(teamAId) || "Team A";
        
        setup.teamA = { name: teamAName, id: teamAId };
        pendingLobbySetup.set(userId, setup);

        // Filter out Team A from options? Maybe allow mirror match? Let's allow mirror match for now.
        const select = new StringSelectMenuBuilder()
            .setCustomId('battle_create_teamb')
            .setPlaceholder('Select Team B Collection')
            .addOptions(Array.from(availableCollections.entries()).map(([id, name]) => ({
                label: name.substring(0, 100),
                value: id
            })));

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
        await interaction.update({ content: `🔵 **Select Team B (Blue Team)**\nVs ${teamAName}`, components: [row] });
    }

    // Step 4: Team B Selected -> Show Venue Select
    if (interaction.isStringSelectMenu() && interaction.customId === 'battle_create_teamb') {
        const teamBId = interaction.values[0];
        const setup = pendingLobbySetup.get(userId);
        if (!setup) return;

        const availableCollections = await getAvailableCollections();
        const teamBName = availableCollections.get(teamBId) || "Team B";
        
        setup.teamB = { name: teamBName, id: teamBId };
        pendingLobbySetup.set(userId, setup);

        const venueSelect = new StringSelectMenuBuilder()
            .setCustomId(`battle_create_venue`)
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

    // Step 5: Venue Selected -> Show Final Settings Modal
    if (interaction.isStringSelectMenu() && interaction.customId === 'battle_create_venue') {
        const venue = interaction.values[0];
        const setup = pendingLobbySetup.get(userId);
        if (!setup) return;

        setup.venue = venue;
        pendingLobbySetup.set(userId, setup);

        const modal = new ModalBuilder()
            .setCustomId(`battle_create_final`)
            .setTitle('Final Settings');

        let playersLabel = "Max Players (2-24, Even Only)";
        let defaultPlayers = "6";

        if (setup.mode === 'GANG_MODE') {
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

        if (setup.type === 'WALLET') {
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

    // Step 6: Modal Submitted -> Create Lobby
    if (interaction.isModalSubmit() && interaction.customId === 'battle_create_final') {
        const setup = pendingLobbySetup.get(userId);
        if (!setup || !setup.type || !setup.mode || !setup.venue) {
             await interaction.reply({ content: "❌ Session expired or invalid. Please start over.", ephemeral: true });
             return;
        }

        const maxPlayers = parseInt(interaction.fields.getTextInputValue('max_players'));
        const channelId = interaction.channelId!;

        // Enforce Bracket Rules
        if (setup.mode === 'GANG_MODE') {
            // Gang Mode: Powers of 2 only (4, 8, 16)
            const validGangCounts = [4, 8, 16];
            if (!validGangCounts.includes(maxPlayers)) {
                await interaction.reply({ 
                    content: "❌ **Invalid Player Count for Gang Mode!**\nMust be 4, 8, or 16 to ensure even brackets.", 
                    ephemeral: true 
                });
                return;
            }
        } else {
            // Battle Royale: 2-24 players, Even numbers only
            if (isNaN(maxPlayers) || maxPlayers < 2 || maxPlayers > 24 || maxPlayers % 2 !== 0) {
                await interaction.reply({ content: "❌ **Invalid Player Count!**\nMust be between 2 and 24, and an EVEN number.", ephemeral: true });
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
            if (setup.type === 'UPLOAD') {
                // Do not register host yet
            } else {
                // For WALLET or PFP, try to register host
                let wallet = undefined;
                let selectedCollectionGroup: string | undefined;

                if (setup.type === 'WALLET') {
                    wallet = interaction.fields.getTextInputValue('wallet_address');
                    // Also save to DB for future convenience?
                    await updateUser(interaction.user.id, { wallet_address: wallet });

                    // If Gang Mode, Host MUST pick a team.
                    // But we are in the creation flow. Host is creating the lobby.
                    // Host should probably be prompted to join properly or we auto-assign if possible.
                    // For simplicity, let's make the Host join manually via /battle join if it's Gang Mode,
                    // OR ask them which team they are on.
                    // Actually, let's just create the lobby empty (or with host) and let them pick team.
                    
                    // If Gang Mode, we can't auto-register host easily without knowing their team.
                    // Let's skip auto-registration for Host in Gang Mode for now, OR default them to Team A?
                    // Let's default Host to Team A for simplicity, but verify they have the NFT.
                    
                    if (setup.mode === 'GANG_MODE') {
                        selectedCollectionGroup = setup.teamA!.id; // Host defaults to Team A
                    } else {
                        // Standard Battle Royale Logic (Multiple Collections Check)
                        const availableCollections = await getAvailableCollections();
                        if (availableCollections.size > 1) {
                             // ... (Existing logic for selection, but we can't do interactive select inside modal submit easily without complex followups)
                             // For now, let's just pick the first one or fail if multiple.
                             // Actually, we can just let validateAndGetPlayerData handle it?
                             // No, validate throws error.
                             // Let's just try to validate with NO specific collection, and if it fails, tell them to join manually.
                        }
                    }
                }

                try {
                    if (setup.mode === 'GANG_MODE') {
                        // Try Team A first
                        try {
                            hostPlayer = await validateAndGetPlayerData(interaction.user, setup.type, { 
                                wallet, 
                                requiredCollection: setup.teamA!.id
                            });
                            hostPlayer.team = 'A';
                        } catch (e) {
                            // Try Team B
                            console.log("Host not in Team A, trying Team B...");
                            hostPlayer = await validateAndGetPlayerData(interaction.user, setup.type, { 
                                wallet, 
                                requiredCollection: setup.teamB!.id
                            });
                            hostPlayer.team = 'B';
                        }
                    } else {
                        // Battle Royale: Try to join. If multiple collections, just pick one (suppress error)
                        try {
                            hostPlayer = await validateAndGetPlayerData(interaction.user, setup.type, { wallet });
                        } catch (e) {
                            if (e instanceof MultipleCollectionsError) {
                                // Pick the first one available to ensure Host is joined
                                const firstGroup = e.groups[0];
                                hostPlayer = await validateAndGetPlayerData(interaction.user, setup.type, { 
                                    wallet, 
                                    selectedCollectionGroup: firstGroup 
                                });
                            } else {
                                throw e;
                            }
                        }
                    }

                } catch (error) {
                    // If validation fails (e.g. multiple collections or wrong NFT), just create lobby empty
                    // and tell host to join manually.
                    console.log("Host auto-join failed:", error);
                }
            }

            const lobby: Lobby = {
                hostId: interaction.user.id,
                channelId: channelId,
                players: hostPlayer ? [hostPlayer] : [],
                maxPlayers: maxPlayers,
                status: 'OPEN',
                settings: {
                    arena: setup.venue,
                    genre: setup.mode,
                    registrationType: setup.type,
                    teamA: setup.teamA ? { name: setup.teamA.name, collectionId: setup.teamA.id } : undefined,
                    teamB: setup.teamB ? { name: setup.teamB.name, collectionId: setup.teamB.id } : undefined
                }
            };

            activeLobbies.set(channelId, lobby);
            pendingLobbySetup.delete(userId); // Cleanup

            const playerList = lobby.players.length > 0 ? `**1.** ${lobby.players[0].username} ${lobby.players[0].team ? `(${lobby.players[0].team})` : ''}` : 'Waiting for host to join...';
            const thumbnail = lobby.players.length > 0 ? lobby.players[0].avatarUrl : undefined;

            let description = `**Host:** ${interaction.user.username}\n**Type:** ${setup.type}\n**Players:** ${lobby.players.length}/${maxPlayers}\n\n**Registered Fighters:**\n${playerList}\n\nType \`/battle join\` to enter!`;
            
            if (setup.mode === 'GANG_MODE') {
                description = `**Host:** ${interaction.user.username}\n**Mode:** Gang War\n**Matchup:** ${setup.teamA!.name} 🆚 ${setup.teamB!.name}\n**Players:** ${lobby.players.length}/${maxPlayers}\n\n**Registered Fighters:**\n${playerList}\n\nType \`/battle join\` to pick your side!`;
            }

            const embed = new EmbedBuilder()
                .setTitle(`⚔️ ${setup.mode.replace('_', ' ')}: ${setup.venue}`)
                .setDescription(description)
                .addFields(
                    { name: '📜 Rules', value: '• Online players beat offline players.\n• NFT Stats based on rarity traits.' },
                    { name: '🎮 Commands', value: '• \`/battle join\` - Join Lobby\n• \`/wallet set\` - Link Wallet' }
                )
                .setColor(0xFFD700);
            
            if (thumbnail) embed.setThumbnail(thumbnail);

            await interaction.editReply({ embeds: [embed] });

            if (setup.type === 'UPLOAD') {
                await interaction.followUp({ content: `✅ **Lobby Created!** Host, please use \`/battle join image:<attachment>\` to register your fighter!`, ephemeral: true });
            } else if (!hostPlayer) {
                 await interaction.followUp({ content: `✅ **Lobby Created!** Host, please use \`/battle join\` to register your fighter! (Auto-join failed or required manual selection)`, ephemeral: true });
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
