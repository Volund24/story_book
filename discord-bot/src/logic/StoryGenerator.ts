import { GoogleGenAI } from '@google/genai';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, EmbedBuilder, TextChannel, WebhookClient, AttachmentBuilder } from 'discord.js';
import PDFDocument from 'pdfkit';
import axios from 'axios';
import { Readable } from 'stream';

// --- Constants ---
const MAX_STORY_PAGES = 10;
const BACK_COVER_PAGE = 11;
const TOTAL_PAGES = 11;
const DECISION_PAGES: number[] = []; // No interactive pauses
const MODEL_V3 = "gemini-3-pro-image-preview";
const MODEL_IMAGE_GEN_NAME = MODEL_V3;
const MODEL_TEXT_NAME = MODEL_V3;

const GENRES = ["Classic Horror", "Superhero Action", "Dark Sci-Fi", "High Fantasy", "Neon Noir Detective", "Wasteland Apocalypse", "Lighthearted Comedy", "Teen Drama / Slice of Life", "Custom"];
const TONES = [
    "ACTION-HEAVY (Short, punchy dialogue. Focus on kinetics.)",
    "INNER-MONOLOGUE (Heavy captions revealing thoughts.)",
    "QUIPPY (Characters use humor as a defense mechanism.)",
    "OPERATIC (Grand, dramatic declarations and high stakes.)",
    "CASUAL (Natural dialogue, focus on relationships/gossip.)",
    "WHOLESOME (Warm, gentle, optimistic.)"
];

const LANGUAGES = [
    { code: 'en-US', name: 'English (US)' },
    // ... add others if needed, defaulting to English for now
];

interface ComicFace {
    id: string;
    type: 'cover' | 'story' | 'back_cover';
    imageUrl?: string;
    narrative?: Beat;
    choices: string[];
    resolvedChoice?: string;
    pageIndex: number;
    isDecisionPage?: boolean;
}

interface Beat {
    caption?: string;
    dialogue?: string;
    scene: string;
    choices: string[];
    focus_char: 'hero' | 'friend' | 'other';
}

interface Persona {
    base64: string;
    desc: string;
}

export class StoryGenerator {
    private ai: GoogleGenAI;
    private hero: Persona;
    private friend: Persona | null;
    private genre: string;
    private tone: string;
    private language: string = 'en-US';
    private history: ComicFace[] = [];
    private channel: TextChannel;
    private interactionUser: any; // Discord User
    private webhook: WebhookClient | null = null;

    constructor(apiKey: string, heroUrl: string, friendUrl: string | null, genre: string, channel: TextChannel, user: any, webhookUrl?: string) {
        this.ai = new GoogleGenAI({ apiKey });
        this.hero = { base64: '', desc: 'The Main Hero' }; // Will load async
        this.friend = friendUrl ? { base64: '', desc: 'The Sidekick/Rival' } : null;
        this.genre = genre;
        this.channel = channel;
        this.interactionUser = user;
        
        // Pick a random tone based on genre
        let availableTones = TONES;
        if (genre === "Teen Drama / Slice of Life" || genre === "Lighthearted Comedy") {
            availableTones = TONES.filter(t => t.includes("CASUAL") || t.includes("WHOLESOME") || t.includes("QUIPPY"));
        } else if (genre === "Classic Horror") {
            availableTones = TONES.filter(t => t.includes("INNER-MONOLOGUE") || t.includes("OPERATIC"));
        }
        this.tone = availableTones[Math.floor(Math.random() * availableTones.length)];

        if (webhookUrl) {
            this.webhook = new WebhookClient({ url: webhookUrl });
        }

        // We need to load images before starting, but constructor is sync. 
        // We'll call a prepare() method.
        this.hero.base64 = heroUrl; // Temporarily store URL
        if (this.friend) this.friend.base64 = friendUrl!;
    }

    private async urlToBase64(url: string): Promise<string> {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return Buffer.from(response.data, 'binary').toString('base64');
    }

    public async start() {
        // 1. Load Images
        this.hero.base64 = await this.urlToBase64(this.hero.base64);
        if (this.friend) {
            this.friend.base64 = await this.urlToBase64(this.friend.base64);
        }

        await this.sendUpdate(`🎬 **Starting Generation**\n**Genre:** ${this.genre}\n**Tone:** ${this.tone}\n**Hero:** Loaded\n**Co-Star:** ${this.friend ? 'Loaded' : 'None'}`);

        // 2. Generate Cover
        await this.generateSinglePage(0, 'cover');

        // 3. Generate All Pages (Linear Flow)
        for (let i = 1; i <= MAX_STORY_PAGES; i++) {
            await this.generateSinglePage(i, 'story');
        }

        // 4. Back Cover & PDF
        await this.generateSinglePage(BACK_COVER_PAGE, 'back_cover');
        await this.generateAndUploadPDF();
    }

    private async handleDecision(page: ComicFace) {
        const row = new ActionRowBuilder<ButtonBuilder>();
        
        page.choices.forEach((choice, index) => {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`choice_${index}`)
                    .setLabel(choice.substring(0, 80)) // Discord limit
                    .setStyle(ButtonStyle.Primary)
            );
        });

        const embed = new EmbedBuilder()
            .setTitle("🤔 What happens next?")
            .setDescription(`The story pauses! Choose the path:\n\n${page.choices.map((c, i) => `**${i+1}.** ${c}`).join('\n')}`)
            .setColor(0x0099FF)
            .setFooter({ text: "You have 30 seconds to choose. Defaulting to Option 1." });

        const message = await this.channel.send({ 
            content: `<@${this.interactionUser.id}>`,
            embeds: [embed], 
            components: [row] 
        });

        try {
            const confirmation = await message.awaitMessageComponent({ 
                filter: i => i.user.id === this.interactionUser.id, 
                componentType: ComponentType.Button, 
                time: 30000 
            });

            const choiceIndex = parseInt(confirmation.customId.split('_')[1]);
            const selectedChoice = page.choices[choiceIndex];
            
            await confirmation.update({ content: `✅ **Selected:** ${selectedChoice}`, components: [], embeds: [] });
            page.resolvedChoice = selectedChoice;
            
            await this.continueGeneration(4);

        } catch (e) {
            // Timeout
            await message.edit({ content: `⏰ **Timeout!** Defaulting to: ${page.choices[0]}`, components: [], embeds: [] });
            page.resolvedChoice = page.choices[0];
            await this.continueGeneration(4);
        }
    }

    private async continueGeneration(startPage: number) {
        for (let i = startPage; i <= MAX_STORY_PAGES; i++) {
            await this.generateSinglePage(i, 'story');
        }
        // Back Cover
        await this.generateSinglePage(BACK_COVER_PAGE, 'back_cover');
        
        // Final PDF
        await this.generateAndUploadPDF();
    }

    private async generateSinglePage(pageNum: number, type: ComicFace['type']) {
        const isDecision = DECISION_PAGES.includes(pageNum);
        let beat: Beat;

        if (type === 'cover') {
            beat = { scene: "Cover Art", choices: [], focus_char: 'hero' };
        } else if (type === 'back_cover') {
            beat = { scene: "Thematic teaser image", choices: [], focus_char: 'other' };
        } else {
            beat = await this.generateBeat(pageNum, isDecision);
        }

        // Store in history
        const face: ComicFace = {
            id: `page-${pageNum}`,
            type,
            narrative: beat,
            choices: beat.choices,
            pageIndex: pageNum,
            isDecisionPage: isDecision
        };
        this.history.push(face);

        // Generate Image
        const imageUrl = await this.generateImage(beat, type);
        face.imageUrl = imageUrl;

        // Post to Discord
        if (imageUrl) {
            await this.postPanelToDiscord(face);
        }
    }

    private async generateBeat(pageNum: number, isDecisionPage: boolean): Promise<Beat> {
        const isFinalPage = pageNum === MAX_STORY_PAGES;
        const langName = "English"; // Hardcoded for now

        // History Context
        const relevantHistory = this.history
            .filter(p => p.type === 'story' && p.narrative && p.pageIndex < pageNum)
            .sort((a, b) => a.pageIndex - b.pageIndex);

        const historyText = relevantHistory.map(p => 
            `[Page ${p.pageIndex}] [Focus: ${p.narrative?.focus_char}] (Caption: "${p.narrative?.caption || ''}") (Dialogue: "${p.narrative?.dialogue || ''}") (Scene: ${p.narrative?.scene}) ${p.resolvedChoice ? `-> USER CHOICE: "${p.resolvedChoice}"` : ''}`
        ).join('\n');

        let friendInstruction = "Not yet introduced.";
        if (this.friend) {
            friendInstruction = "ACTIVE and PRESENT (User Provided). Ensure they are woven into the scene.";
        }

        let coreDriver = `GENRE: ${this.genre}. TONE: ${this.tone}.`;
        
        let instruction = `Continue the story. ALL OUTPUT TEXT MUST BE IN ${langName.toUpperCase()}. ${coreDriver}`;
        
        if (isFinalPage) {
            instruction += " FINAL PAGE. KARMIC CLIFFHANGER REQUIRED. Text must end with 'TO BE CONTINUED...'.";
        } else if (isDecisionPage) {
            instruction += " End with a PSYCHOLOGICAL choice about VALUES or RISK. The options must NOT be simple physical actions.";
        } else {
            if (pageNum === 1) instruction += " INCITING INCIDENT. Establish the mood.";
            else if (pageNum <= 4) instruction += " RISING ACTION. Focus on dialogue and challenges.";
            else if (pageNum <= 8) instruction += " COMPLICATION. A twist occurs!";
            else instruction += " CLIMAX. The confrontation.";
        }

        const prompt = `
You are writing a comic book script. PAGE ${pageNum} of ${MAX_STORY_PAGES}.
TARGET LANGUAGE: ${langName}.
${coreDriver}

CHARACTERS:
- HERO: Active.
- CO-STAR: ${friendInstruction}

PREVIOUS PANELS:
${historyText.length > 0 ? historyText : "Start the adventure."}

RULES:
1. NO REPETITION.
2. IF CO-STAR IS ACTIVE, THEY MUST APPEAR FREQUENTLY.
3. VARIETY.
4. LANGUAGE: ${langName}.

INSTRUCTION: ${instruction}

OUTPUT STRICT JSON ONLY:
{
  "caption": "Unique narrator text. (max 25 words).",
  "dialogue": "Unique speech. (max 20 words). Optional.",
  "scene": "Vivid visual description (ALWAYS IN ENGLISH). MUST mention 'HERO' or 'CO-STAR' if present.",
  "focus_char": "hero" OR "friend" OR "other",
  "choices": ["Option A", "Option B"] (Only if decision page)
}
`;
        try {
            const res = await this.ai.models.generateContent({ 
                model: MODEL_TEXT_NAME, 
                contents: prompt, 
                config: { responseMimeType: 'application/json' } 
            });
            
            let rawText = res.text || "{}";
            rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(rawText);
            
            if (!isDecisionPage) parsed.choices = [];
            if (isDecisionPage && (!parsed.choices || parsed.choices.length < 2)) parsed.choices = ["Fight back", "Run away"];
            
            return parsed as Beat;
        } catch (e) {
            console.error("Beat generation failed", e);
            return { caption: "...", scene: "A mysterious scene.", focus_char: 'hero', choices: [] };
        }
    }

    private async generateImage(beat: Beat, type: ComicFace['type']): Promise<string> {
        const contents: any[] = [];
        
        contents.push({ text: "REFERENCE 1 [HERO]:" });
        contents.push({ inlineData: { mimeType: 'image/jpeg', data: this.hero.base64 } });
        
        if (this.friend) {
            contents.push({ text: "REFERENCE 2 [CO-STAR]:" });
            contents.push({ inlineData: { mimeType: 'image/jpeg', data: this.friend.base64 } });
        }

        let promptText = `STYLE: ${this.genre} comic book art, detailed ink, vibrant colors. `;
        
        if (type === 'cover') {
            promptText += `TYPE: Comic Book Cover. TITLE: "INFINITE HEROES". Main visual: Dynamic action shot of [HERO].`;
        } else if (type === 'back_cover') {
            promptText += `TYPE: Comic Back Cover. FULL PAGE VERTICAL ART. Text: "NEXT ISSUE SOON".`;
        } else {
            promptText += `TYPE: Vertical comic panel. SCENE: ${beat.scene}. `;
            promptText += `INSTRUCTIONS: Maintain strict character likeness. If scene mentions 'HERO', use REFERENCE 1. If 'CO-STAR', use REFERENCE 2.`;
            if (beat.caption) promptText += ` INCLUDE CAPTION BOX: "${beat.caption}"`;
            if (beat.dialogue) promptText += ` INCLUDE SPEECH BUBBLE: "${beat.dialogue}"`;
        }

        contents.push({ text: promptText });

        try {
            const res = await this.ai.models.generateContent({
                model: MODEL_IMAGE_GEN_NAME,
                contents: contents,
                config: { imageConfig: { aspectRatio: '2:3' } }
            });
            
            const part = res.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
            return part?.inlineData?.data ? `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` : '';
        } catch (e) {
            console.error("Image generation failed", e);
            return '';
        }
    }

    private async postPanelToDiscord(face: ComicFace) {
        if (!face.imageUrl) return;

        // Convert base64 to buffer
        const base64Data = face.imageUrl.split(',')[1];
        const buffer = Buffer.from(base64Data, 'base64');
        const attachment = new AttachmentBuilder(buffer, { name: `panel-${face.pageIndex}.jpg` });

        const embed = new EmbedBuilder()
            .setTitle(face.type === 'cover' ? "Comic Cover" : `Page ${face.pageIndex}`)
            .setImage(`attachment://panel-${face.pageIndex}.jpg`)
            .setColor(0xFF0000);

        if (face.narrative) {
            if (face.narrative.caption) embed.setDescription(`*${face.narrative.caption}*`);
            if (face.narrative.dialogue) embed.addFields({ name: "Dialogue", value: `"${face.narrative.dialogue}"` });
        }

        if (this.webhook) {
            await this.webhook.send({
                embeds: [embed],
                files: [attachment],
                username: 'Infinite Heroes Bot',
                avatarURL: 'https://i.imgur.com/AfFp7pu.png'
            });
        } else {
            await this.channel.send({ embeds: [embed], files: [attachment] });
        }
    }

    private async sendUpdate(text: string) {
        if (this.webhook) {
            await this.webhook.send({ content: text, username: 'Infinite Heroes Bot' });
        } else {
            await this.channel.send(text);
        }
    }

    private async generateAndUploadPDF() {
        await this.sendUpdate("📚 **Compiling PDF Issue...**");

        const doc = new PDFDocument({ autoFirstPage: false });
        const buffers: Buffer[] = [];

        doc.on('data', buffers.push.bind(buffers));
        
        const pdfPromise = new Promise<Buffer>((resolve) => {
            doc.on('end', () => {
                resolve(Buffer.concat(buffers));
            });
        });

        // Add pages
        const sortedFaces = this.history.filter(f => f.imageUrl).sort((a, b) => a.pageIndex - b.pageIndex);
        
        for (const face of sortedFaces) {
            if (!face.imageUrl) continue;
            const imgBuffer = Buffer.from(face.imageUrl.split(',')[1], 'base64');
            
            doc.addPage({ size: [480, 720], margin: 0 });
            doc.image(imgBuffer, 0, 0, { width: 480, height: 720 });
        }

        doc.end();
        const pdfBuffer = await pdfPromise;

        const attachment = new AttachmentBuilder(pdfBuffer, { name: 'Infinite-Heroes-Issue.pdf' });
        
        if (this.webhook) {
            await this.webhook.send({
                content: "✅ **Full Issue Ready!** Download below (Available for 24h).",
                files: [attachment]
            });
        } else {
            await this.channel.send({
                content: "✅ **Full Issue Ready!** Download below (Available for 24h).",
                files: [attachment]
            });
        }
    }
}
