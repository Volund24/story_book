import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ModalSubmitInteraction } from 'discord.js';
import { getUser, updateUser, getConfig, setConfig } from '../db';
import { resolveCollectionFromSlug } from '../logic/SolanaVerifier';

export const data = new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Admin management commands')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
        sub
            .setName('setup')
            .setDescription('Configure bot settings (Opens Modal)')
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
    )
    .addSubcommand(sub =>
        sub
            .setName('help')
            .setDescription('Show admin help')
    );

export async function execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'setup') {
        const modal = new ModalBuilder()
            .setCustomId('admin_config_modal')
            .setTitle('Bot Configuration');

        // Get current values to pre-fill (optional, but nice)
        // Note: Modals don't support async pre-fill easily if we want to be fast, 
        // but we can try fetching.
        const currentCooldownMs = await getConfig('cooldown_ms') || '86400000';
        const currentCooldownHours = (parseInt(currentCooldownMs) / (1000 * 60 * 60)).toString();
        
        const currentServerCollectionSlug = await getConfig('server_collection_slug') || '';
        const currentServerCollection = await getConfig('server_collection') || '';
        const displayServerCollection = currentServerCollectionSlug || currentServerCollection;

        const currentPartnersSlug = await getConfig('partner_collections_slugs') || '';
        const currentPartners = await getConfig('partner_collections') || '';
        const displayPartners = currentPartnersSlug || currentPartners;

        const currentEnablePartners = await getConfig('enable_partners') || 'false';

        const cooldownInput = new TextInputBuilder()
            .setCustomId('cooldown_hours')
            .setLabel("Cooldown (Hours)")
            .setStyle(TextInputStyle.Short)
            .setValue(currentCooldownHours)
            .setRequired(true);

        const serverCollectionInput = new TextInputBuilder()
            .setCustomId('server_collection')
            .setLabel("Server Collection Slug (HowRare.is)")
            .setStyle(TextInputStyle.Short)
            .setValue(displayServerCollection)
            .setRequired(false); // Maybe optional?

        const partnerCollectionsInput = new TextInputBuilder()
            .setCustomId('partner_collections')
            .setLabel("Partner Slugs (Comma Separated)")
            .setStyle(TextInputStyle.Paragraph)
            .setValue(displayPartners)
            .setRequired(false);

        const enablePartnersInput = new TextInputBuilder()
            .setCustomId('enable_partners')
            .setLabel("Enable Partners? (true/false)")
            .setStyle(TextInputStyle.Short)
            .setValue(currentEnablePartners)
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(cooldownInput),
            new ActionRowBuilder<TextInputBuilder>().addComponents(serverCollectionInput),
            new ActionRowBuilder<TextInputBuilder>().addComponents(partnerCollectionsInput),
            new ActionRowBuilder<TextInputBuilder>().addComponents(enablePartnersInput)
        );

        await interaction.showModal(modal);
        return;
    }
    
    if (subcommand === 'help') {
        await interaction.reply({
            content: `**Admin Commands:**
\`/admin setup\` - Open configuration modal (Cooldown, Collections, etc.)
\`/admin user reset <target>\` - Reset a user's cooldown.
\`/admin user grant <target> <amount>\` - Grant tokens.
\`/admin restart\` - Soft restart.
`,
            ephemeral: true
        });
        return;
    }

    const group = interaction.options.getSubcommandGroup();

    if (group === 'user') {
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
        await interaction.reply("🔄 System state reloaded.");
    }
}

export async function handleModal(interaction: ModalSubmitInteraction) {
    const cooldown = interaction.fields.getTextInputValue('cooldown_hours');
    const serverCollectionInput = interaction.fields.getTextInputValue('server_collection');
    const partnerCollectionsInput = interaction.fields.getTextInputValue('partner_collections');
    const enablePartners = interaction.fields.getTextInputValue('enable_partners');

    // Validation
    const hours = parseInt(cooldown);
    if (isNaN(hours)) {
        await interaction.reply({ content: "❌ Cooldown must be a number.", ephemeral: true });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    // Resolve Server Collection
    let serverCollectionAddress = serverCollectionInput;
    if (serverCollectionInput && !serverCollectionInput.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
        // It's likely a slug
        const resolved = await resolveCollectionFromSlug(serverCollectionInput);
        if (resolved.length > 0) {
            serverCollectionAddress = resolved.join(',');
            await setConfig('server_collection_slug', serverCollectionInput);
            await interaction.followUp({ content: `ℹ️ Resolved slug '${serverCollectionInput}' to: ${serverCollectionAddress}`, ephemeral: true });
        } else {
            await interaction.editReply({ content: `❌ Could not resolve HowRare slug: ${serverCollectionInput}` });
            return;
        }
    } else {
        // It's an address or empty, clear the slug config
        await setConfig('server_collection_slug', '');
    }

    // Resolve Partners
    const partnerAddresses: string[] = [];
    const collectionMap: Record<string, string> = {}; // Address -> Name/Slug
    
    if (partnerCollectionsInput) {
        const inputs = partnerCollectionsInput.split(',').map(s => s.trim()).filter(s => s.length > 0);
        for (const input of inputs) {
            if (input.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
                partnerAddresses.push(input);
                // If it's an address, we don't know the name yet, but we can try to fetch it later or leave it blank
                // For now, let's just use the address as the name if we can't resolve it, 
                // but the verifier will try to fetch metadata.
            } else {
                const resolved = await resolveCollectionFromSlug(input);
                if (resolved.length > 0) {
                    partnerAddresses.push(...resolved);
                    // Map all resolved addresses to this slug
                    resolved.forEach(addr => {
                        collectionMap[addr] = input;
                    });
                } else {
                    await interaction.editReply({ content: `❌ Could not resolve HowRare slug: ${input}` });
                    return;
                }
            }
        }
    }

    // Also map server collection if it was a slug
    if (serverCollectionAddress && serverCollectionInput && !serverCollectionInput.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
         serverCollectionAddress.split(',').forEach(addr => {
             collectionMap[addr] = serverCollectionInput;
         });
    }

    await setConfig('cooldown_ms', (hours * 60 * 60 * 1000).toString());
    await setConfig('server_collection', serverCollectionAddress || '');
    await setConfig('partner_collections', partnerAddresses.join(','));
    await setConfig('collection_map', JSON.stringify(collectionMap));
    await setConfig('enable_partners', enablePartners.toLowerCase() === 'true' ? 'true' : 'false');

    await interaction.editReply({ content: "✅ Configuration saved successfully! Slugs resolved and mapped." });
}
