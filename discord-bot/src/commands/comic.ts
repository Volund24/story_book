import { 
    SlashCommandBuilder, 
    ChatInputCommandInteraction, 
    EmbedBuilder, 
    ChannelType, 
    TextChannel, 
    ActionRowBuilder, 
    StringSelectMenuBuilder, 
    StringSelectMenuOptionBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle,
    Interaction,
    Attachment
} from 'discord.js';
import { getUser, updateUser, getConfig } from '../db';
import { StoryGenerator } from '../logic/StoryGenerator';

// --- State Management ---
interface ComicSession {
    userId: string;
    channelId: string;
    heroImage: string;
    costarImage?: string;
    costarRole?: string;
    genre: string;
    tone: string;
    artStyle: string;
    textBoxStyle: string;
    title: string;
    heroName: string;
    heroGender: string;
    costarName?: string;
    costarGender?: string;
    customPremise?: string;
    isCustomGenre: boolean;
}

// In-memory storage for active setup sessions
const sessions = new Map<string, ComicSession>();

// --- Constants ---
const GENRES = [
    "Superhero Action", "Classic Horror", "High Fantasy", "Dark Sci-Fi", 
    "Neon Noir Detective", "Wasteland Apocalypse", "Romance", "Thriller", "Mystery", "Custom"
];

const TONES = [
    "Serious & Gritty", "Lighthearted & Fun", "Dark & Brooding", 
    "Comedic", "Dramatic & Operatic", "Wholesome"
];

const ART_STYLES = [
    "Modern Comic Book", "Classic Golden Age", "Noir Black & White", 
    "Oil Painting", "Cyberpunk Digital", "Watercolor", "Manga"
];

const TEXT_STYLES = [
    "Classic White", "Dark Mode", "Yellowed Parchment", "Futuristic HUD", "Rough Sketch"
];

const GENDERS = ["Male", "Female", "Non-Binary/Other"];

export const data = new SlashCommandBuilder()
    .setName('comic')
    .setDescription('Infinite Heroes Comic Commands')
    .addSubcommand(sub =>
        sub
            .setName('create')
            .setDescription('Start a new comic generation')
            .addAttachmentOption(option => option.setName('image').setDescription('Your Hero NFT/Image').setRequired(true))
            .addAttachmentOption(option => option.setName('costar').setDescription('Optional: Villain or Co-Star Image').setRequired(false))
            .addStringOption(option => 
                option.setName('costar_role')
                    .setDescription('Role of the second character (if uploaded)')
                    .setRequired(false)
                    .addChoices(
                        { name: 'Villain', value: 'Villain' },
                        { name: 'Sidekick', value: 'Sidekick' },
                        { name: 'Love Interest', value: 'Love Interest' },
                        { name: 'Rival', value: 'Rival' }
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

        // 2. Validate Channel
        if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
            await interaction.reply({ content: "❌ This command can only be used in text channels.", ephemeral: true });
            return;
        }

        const image = interaction.options.getAttachment('image', true);
        const costar = interaction.options.getAttachment('costar', false);
        const costarRole = interaction.options.getString('costar_role', false) || (costar ? 'Sidekick' : undefined);

        // Initialize Session
        const session: ComicSession = {
            userId: interaction.user.id,
            channelId: interaction.channelId,
            heroImage: image.url,
            costarImage: costar ? costar.url : undefined,
            costarRole: costarRole,
            genre: GENRES[0],
            tone: TONES[0],
            artStyle: ART_STYLES[0],
            textBoxStyle: TEXT_STYLES[0],
            title: "Infinite Heroes",
            heroName: "The Hero",
            heroGender: "Male", // Default
            costarName: costar ? (costarRole === 'Villain' ? "The Villain" : "The Partner") : undefined,
            costarGender: costar ? "Male" : undefined, // Default
            isCustomGenre: false
        };

        sessions.set(interaction.user.id, session);

        await sendDashboard(interaction, session);
    }
}

async function sendDashboard(interaction: ChatInputCommandInteraction | any, session: ComicSession) {
    const embed = new EmbedBuilder()
        .setTitle(`🎨 Comic Setup: ${session.title}`)
        .setDescription(`Configure your story settings below.\n\n**Hero:** ${session.heroName} (${session.heroGender})\n**Co-Star:** ${session.costarName ? `${session.costarName} (${session.costarGender})` : 'None'} - ${session.costarRole || 'N/A'}\n**Genre:** ${session.isCustomGenre ? session.customPremise : session.genre}\n**Tone:** ${session.tone}\n**Art Style:** ${session.artStyle}\n**Text Style:** ${session.textBoxStyle}`)
        .setColor(0x0099FF)
        .setThumbnail(session.heroImage);

    // Dropdowns
    const genreSelect = new StringSelectMenuBuilder()
        .setCustomId('select_genre')
        .setPlaceholder('Select Genre')
        .addOptions(GENRES.map(g => new StringSelectMenuOptionBuilder().setLabel(g).setValue(g).setDefault(g === session.genre)));

    const toneSelect = new StringSelectMenuBuilder()
        .setCustomId('select_tone')
        .setPlaceholder('Select Tone')
        .addOptions(TONES.map(t => new StringSelectMenuOptionBuilder().setLabel(t).setValue(t).setDefault(t === session.tone)));

    const styleSelect = new StringSelectMenuBuilder()
        .setCustomId('select_style')
        .setPlaceholder('Select Art Style')
        .addOptions(ART_STYLES.map(s => new StringSelectMenuOptionBuilder().setLabel(s).setValue(s).setDefault(s === session.artStyle)));
    
    const textSelect = new StringSelectMenuBuilder()
        .setCustomId('select_text')
        .setPlaceholder('Select Text Box Style')
        .addOptions(TEXT_STYLES.map(s => new StringSelectMenuOptionBuilder().setLabel(s).setValue(s).setDefault(s === session.textBoxStyle)));

    // Gender Selectors
    const heroGenderSelect = new StringSelectMenuBuilder()
        .setCustomId('select_hero_gender')
        .setPlaceholder('Select Hero Gender')
        .addOptions(GENDERS.map(g => new StringSelectMenuOptionBuilder().setLabel(`Hero: ${g}`).setValue(g).setDefault(g === session.heroGender)));

    // Buttons
    const detailsBtn = new ButtonBuilder()
        .setCustomId('btn_details')
        .setLabel('📝 Set Title & Names')
        .setStyle(ButtonStyle.Secondary);

    const startBtn = new ButtonBuilder()
        .setCustomId('btn_start')
        .setLabel('🚀 Start Generation')
        .setStyle(ButtonStyle.Success);

    const components: ActionRowBuilder<any>[] = [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(genreSelect),
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(toneSelect),
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(styleSelect),
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(textSelect)
    ];

    // Discord allows max 5 ActionRows per message.
    // We have 4 rows already.
    // If we have a costar, we need a row for their gender.
    // And we ALWAYS need a row for the buttons.
    // This means we have 6 rows total if costar is present, which crashes Discord.
    
    // Solution: Combine Hero Gender and Co-Star Gender into one row if possible? 
    // No, Select Menus take full width.
    
    // Alternative: Move Text Style or Art Style to a second page? Or remove one?
    // Or, combine the Gender selection into the "Details" modal?
    
    // Let's move Gender selection to the "Details" modal to save space on the main dashboard.
    // This keeps the main dashboard clean with 4 dropdowns + 1 button row = 5 rows (Perfect).

    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(detailsBtn, startBtn));

    const payload = { 
        content: '', 
        embeds: [embed], 
        components: components as any,
        ephemeral: true 
    };

    if (interaction.replied || interaction.deferred) {
        await interaction.editReply(payload);
    } else {
        await interaction.reply(payload);
    }
}

// --- Interaction Handler (Called from index.ts) ---
export async function handleInteraction(interaction: Interaction) {
    if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;

    const session = sessions.get(interaction.user.id);
    if (!session) {
        if (interaction.isRepliable()) {
            await interaction.reply({ content: "❌ Session expired. Please run `/comic create` again.", ephemeral: true });
        }
        return;
    }

    // Handle Dropdowns
    if (interaction.isStringSelectMenu()) {
        const value = interaction.values[0];
        if (interaction.customId === 'select_genre') {
            session.genre = value;
            session.isCustomGenre = value === 'Custom';
        } else if (interaction.customId === 'select_tone') session.tone = value;
        else if (interaction.customId === 'select_style') session.artStyle = value;
        else if (interaction.customId === 'select_text') session.textBoxStyle = value;
        else if (interaction.customId === 'select_hero_gender') session.heroGender = value;
        else if (interaction.customId === 'select_costar_gender') session.costarGender = value;

        await interaction.deferUpdate();
        await sendDashboard(interaction, session);
    }

    // Handle Buttons
    if (interaction.isButton()) {
        if (interaction.customId === 'btn_details') {
            const modal = new ModalBuilder()
                .setCustomId('modal_details')
                .setTitle('Comic Details');

            const titleInput = new TextInputBuilder()
                .setCustomId('input_title')
                .setLabel("Comic Title")
                .setValue(session.title)
                .setStyle(TextInputStyle.Short);

            const heroInput = new TextInputBuilder()
                .setCustomId('input_hero')
                .setLabel("Hero Name & Gender (e.g. 'Batman (Male)')")
                .setValue(`${session.heroName} (${session.heroGender})`)
                .setStyle(TextInputStyle.Short);

            const premiseInput = new TextInputBuilder()
                .setCustomId('input_premise')
                .setLabel("Custom Premise / Theme (Optional)")
                .setValue(session.customPremise || "")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false);

            const rows = [
                new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
                new ActionRowBuilder<TextInputBuilder>().addComponents(heroInput),
                new ActionRowBuilder<TextInputBuilder>().addComponents(premiseInput)
            ];

            if (session.costarImage) {
                const costarInput = new TextInputBuilder()
                    .setCustomId('input_costar')
                    .setLabel(`${session.costarRole} Name & Gender`)
                    .setValue(`${session.costarName || 'Partner'} (${session.costarGender || 'Male'})`)
                    .setStyle(TextInputStyle.Short);
                rows.splice(2, 0, new ActionRowBuilder<TextInputBuilder>().addComponents(costarInput));
            }

            modal.addComponents(rows);
            await interaction.showModal(modal);
        }

        if (interaction.customId === 'btn_start') {
            await interaction.update({ content: "⚡ **Initializing Infinite Heroes Generator...**\n*Generating Page 1...*", components: [], embeds: [] });
            
            // Start Generation
            try {
                const generator = new StoryGenerator(
                    process.env.GEMINI_KEY || '', 
                    session.heroImage, 
                    session.costarImage || null, 
                    session.genre, 
                    interaction.channel as TextChannel, 
                    interaction.user,
                    undefined, // webhook
                    {
                        title: session.title,
                        heroName: session.heroName,
                        heroGender: session.heroGender,
                        costarName: session.costarName,
                        costarGender: session.costarGender,
                        costarRole: session.costarRole,
                        tone: session.tone,
                        artStyle: session.artStyle,
                        textBoxStyle: session.textBoxStyle,
                        customPremise: session.customPremise
                    }
                );

                // Fire and forget
                generator.start().catch(err => {
                    console.error("Generation Error:", err);
                    interaction.followUp({ content: `❌ **Generation Failed:** ${err.message}`, ephemeral: true });
                });
                
                // Clear session
                sessions.delete(interaction.user.id);

            } catch (error: any) {
                console.error(error);
                await interaction.followUp({ content: `Error starting generation: ${error.message}`, ephemeral: true });
            }
        }
    }

    // Handle Modal
    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'modal_details') {
            session.title = interaction.fields.getTextInputValue('input_title');
            
            // Parse Hero Name & Gender
            const heroRaw = interaction.fields.getTextInputValue('input_hero');
            // Simple regex to extract name and gender if provided in parens
            const heroMatch = heroRaw.match(/^(.*?)\s*\((.*?)\)$/);
            if (heroMatch) {
                session.heroName = heroMatch[1].trim();
                session.heroGender = heroMatch[2].trim();
            } else {
                session.heroName = heroRaw;
            }

            session.customPremise = interaction.fields.getTextInputValue('input_premise');
            
            if (session.costarImage) {
                const costarRaw = interaction.fields.getTextInputValue('input_costar');
                const costarMatch = costarRaw.match(/^(.*?)\s*\((.*?)\)$/);
                if (costarMatch) {
                    session.costarName = costarMatch[1].trim();
                    session.costarGender = costarMatch[2].trim();
                } else {
                    session.costarName = costarRaw;
                }
            }

            await interaction.deferUpdate();
            await sendDashboard(interaction, session);
        }
    }
}
