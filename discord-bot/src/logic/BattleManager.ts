import { TextChannel, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { GoogleGenAI } from '@google/genai';
import PDFDocument from 'pdfkit';
import Jimp from 'jimp';

// --- Types ---

export interface BattlePlayer {
    id: string;
    username: string;
    avatarUrl: string;
    walletAddress?: string;
    gender: 'Male' | 'Female'; // Default Male
    status: 'ALIVE' | 'ELIMINATED' | 'WINNER';
    roundWins: number;
    nftAttributes?: any[]; // For styling based on NFT traits
}

export interface BattleSettings {
    arena: string;
    genre: string;
    style: string; // e.g., "Comic Book", "Manga", "Realistic"
}

export interface RoundResult {
    roundNumber: number;
    winnerId: string;
    loserId: string;
    narrative: string;
    imageUrl: string; // The generated battle scene
    headToHeadUrl?: string; // The face-off image
}

export class BattleManager {
    public lobbyId: string;
    public channelId: string;
    public players: Map<string, BattlePlayer>;
    public settings: BattleSettings;
    public round: number;
    public history: RoundResult[];
    public status: 'WAITING' | 'IN_PROGRESS' | 'COMPLETED';
    
    private channel: TextChannel;
    private genAI: GoogleGenAI;
    private victoryPages: string[] = []; // Store victory images for PDF

    public matchQueue: { p1: BattlePlayer, p2: BattlePlayer }[] = [];

    constructor(lobbyId: string, channel: TextChannel, settings: BattleSettings) {
        this.lobbyId = lobbyId;
        this.channelId = channel.id;
        this.channel = channel;
        this.settings = settings;
        this.players = new Map();
        this.round = 0;
        this.history = [];
        this.status = 'WAITING';
        
        // Initialize Gemini
        this.genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_KEY });
    }

    addPlayer(playerData: { id: string; username: string; avatarUrl: string; walletAddress?: string; nftAttributes?: any[] }) {
        // Gender enforcement logic: Default to Male unless explicitly detected/stated
        const gender: 'Male' | 'Female' = 'Male'; 

        const player: BattlePlayer = {
            ...playerData,
            gender,
            status: 'ALIVE',
            roundWins: 0
        };
        this.players.set(player.id, player);
    }

    async startBattle() {
        this.status = 'IN_PROGRESS';
        this.round = 1;
        await this.channel.send({ content: `⚔️ **The Battle Begins!** ⚔️\nArena: **${this.settings.arena}** | Genre: **${this.settings.genre}**` });
        
        // Generate Initial Bracket
        this.generateBracket();
        
        await this.processRound();
    }

    private generateBracket() {
        const alivePlayers = Array.from(this.players.values()).filter(p => p.status === 'ALIVE');
        
        // Shuffle
        for (let i = alivePlayers.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [alivePlayers[i], alivePlayers[j]] = [alivePlayers[j], alivePlayers[i]];
        }

        this.matchQueue = [];
        // Pair up
        for (let i = 0; i < alivePlayers.length; i += 2) {
            if (i + 1 < alivePlayers.length) {
                this.matchQueue.push({ p1: alivePlayers[i], p2: alivePlayers[i+1] });
            } else {
                // Odd number, bye round? Or handle differently. 
                // For now, auto-win or wait? 
                // Let's just push them as a "bye" (p2 is same as p1, handle in logic)
                // Actually, better to just leave them in 'ALIVE' and they fight next round winners.
                // But for simplicity in this loop, let's just add them to the next pool implicitly.
            }
        }
    }

    async processRound() {
        // Check if we have matches in the queue
        if (this.matchQueue.length === 0) {
            // Check if we have a winner
            const alivePlayers = Array.from(this.players.values()).filter(p => p.status === 'ALIVE');
            
            if (alivePlayers.length === 1) {
                await this.endBattle(alivePlayers[0]);
                return;
            }
            
            if (alivePlayers.length === 0) {
                await this.endBattle(); // Draw?
                return;
            }

            // Generate next round bracket
            this.generateBracket();
            
            if (this.matchQueue.length === 0 && alivePlayers.length > 1) {
                // Should not happen if logic is correct, but safety net
                console.error("Stuck in loop, forcing random match");
                this.matchQueue.push({ p1: alivePlayers[0], p2: alivePlayers[1] });
            }
        }

        const match = this.matchQueue.shift();
        if (!match) return;

        const { p1, p2 } = match;

        await this.channel.send(`🥊 **Round ${this.round}**: ${p1.username} vs ${p2.username}!`);

        try {
            // --- SCENE 1: HEAD TO HEAD ---
            const headToHeadUrl = await this.generateHeadToHead(p1, p2);
            if (headToHeadUrl) {
                const buffer = Buffer.from(headToHeadUrl.split(',')[1], 'base64');
                const attachment = new AttachmentBuilder(buffer, { name: 'h2h.png' });
                await this.channel.send({ content: "**FIGHTERS APPROACH!**", files: [attachment] });
            } else {
                // Debug message if image fails
                // await this.channel.send("⚠️ H2H Image generation failed (API Error or Safety).");
            }

            // --- SCENE 2: ACTION SEQUENCE ---
            const { narrative, imageUrl } = await this.generateActionSequence(p1, p2);

            // Determine Winner (Random for now - TODO: Add stats logic)
            const winner = Math.random() > 0.5 ? p1 : p2;
            const loser = winner === p1 ? p2 : p1;

            // Update Stats
            winner.roundWins++;
            loser.status = 'ELIMINATED';

            // Send Result
            const embed = new EmbedBuilder()
                .setTitle(`Round ${this.round} Result`)
                .setDescription(`**${p1.username}** vs **${p2.username}**\n\n${narrative}\n\n🏆 **Winner:** ${winner.username}`)
                .setColor(0xFF0000);

            const files: AttachmentBuilder[] = [];
            if (imageUrl && imageUrl.startsWith('data:image')) {
                const base64Data = imageUrl.split(',')[1];
                const buffer = Buffer.from(base64Data, 'base64');
                const attachment = new AttachmentBuilder(buffer, { name: 'action.png' });
                embed.setImage('attachment://action.png');
                files.push(attachment);
            } else {
                 // await this.channel.send("⚠️ Action Image generation failed.");
            }

            await this.channel.send({ embeds: [embed], files });

            // Save History
            this.history.push({
                roundNumber: this.round,
                winnerId: winner.id,
                loserId: loser.id,
                narrative,
                imageUrl,
                headToHeadUrl
            });

            this.round++;
            
            // Continue to next match
            setTimeout(() => this.processRound(), 8000); 

        } catch (error) {
            console.error("Round failed:", error);
            await this.channel.send("❌ An error occurred during the round. Skipping...");
            // Force eliminate one to prevent infinite loop
            p2.status = 'ELIMINATED';
            this.processRound();
        }
    }

    private async fetchImageAsBase64(url: string): Promise<string> {
        try {
            const response = await fetch(url);
            const arrayBuffer = await response.arrayBuffer();
            return Buffer.from(arrayBuffer).toString('base64');
        } catch (e) {
            console.error("Failed to fetch image:", url, e);
            return "";
        }
    }

    async generateHeadToHead(p1: BattlePlayer, p2: BattlePlayer): Promise<string> {
        const p1Img = await this.fetchImageAsBase64(p1.avatarUrl);
        const p2Img = await this.fetchImageAsBase64(p2.avatarUrl);
        
        let imageUrl = "";
        try {
            const contents: any[] = [];
            if (p1Img) contents.push({ text: "REFERENCE 1 [LEFT FIGHTER]:" }, { inlineData: { mimeType: 'image/png', data: p1Img } });
            if (p2Img) contents.push({ text: "REFERENCE 2 [RIGHT FIGHTER]:" }, { inlineData: { mimeType: 'image/png', data: p2Img } });
            
            contents.push({ text: `
                STYLE: ${this.settings.style} comic book art.
                SCENE: Intense stare-down before the fight. Split screen or close-up face-off.
                ARENA: ${this.settings.arena} background.
                INSTRUCTIONS:
                - FIGHTER 1 on the left, FIGHTER 2 on the right.
                - High tension, dramatic lighting, "VS" energy.
                - Maintain character likeness.
            ` });

            const imgRes = await this.genAI.models.generateContent({
                model: "gemini-2.0-flash-exp",
                contents: contents
            });
            
            const part = imgRes.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
            if (part?.inlineData?.data) {
                imageUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
            } else {
                console.log("No inlineData in H2H response:", JSON.stringify(imgRes, null, 2));
            }
        } catch (e: any) {
            console.error("H2H Gen Failed", e);
            if (e.message) console.error("Error Message:", e.message);
        }
        return imageUrl;
    }

    async generateActionSequence(p1: BattlePlayer, p2: BattlePlayer): Promise<{ narrative: string, imageUrl: string }> {
        const p1Img = await this.fetchImageAsBase64(p1.avatarUrl);
        const p2Img = await this.fetchImageAsBase64(p2.avatarUrl);

        // 1. Generate Narrative
        const narrativePrompt = `
        Write a short, intense battle scene (max 50 words) between two fighters in a ${this.settings.arena} (${this.settings.genre} style).
        Fighter 1: ${p1.username} (Gender: ${p1.gender})
        Fighter 2: ${p2.username} (Gender: ${p2.gender})
        Describe the action vividly. Who strikes first? What is the clash like?
        `;
        
        let narrative = "The fighters clash!";
        try {
            const textRes = await this.genAI.models.generateContent({
                model: "gemini-1.5-flash",
                contents: narrativePrompt
            });
            // Safely extract text
            narrative = textRes.candidates?.[0]?.content?.parts?.[0]?.text || "The battle rages on!";
        } catch (e) {
            console.error("Text Gen Failed", e);
        }

        // 2. Generate Image
        let imageUrl = "";
        try {
            const contents: any[] = [];
            if (p1Img) contents.push({ text: "REFERENCE 1 [FIGHTER 1]:" }, { inlineData: { mimeType: 'image/png', data: p1Img } });
            if (p2Img) contents.push({ text: "REFERENCE 2 [FIGHTER 2]:" }, { inlineData: { mimeType: 'image/png', data: p2Img } });
            
            contents.push({ text: `
                STYLE: ${this.settings.style} comic book art, dynamic action shot.
                SCENE: ${narrative}
                ARENA: ${this.settings.arena}
                INSTRUCTIONS:
                - Show FIGHTER 1 fighting FIGHTER 2.
                - Maintain character likeness from references.
                - High energy, impact lines, dramatic lighting.
            ` });

            const imgRes = await this.genAI.models.generateContent({
                model: "gemini-2.0-flash-exp", // Updated to a model that might support image gen or at least is valid
                contents: contents,
                // config: { responseMimeType: 'application/json' } // Removed as it might conflict with image gen
            });
            
            // Check for image data in response
            // Note: The SDK response structure for images might vary. 
            // Based on App.tsx: part.inlineData.data
            const part = imgRes.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
            if (part?.inlineData?.data) {
                imageUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
            } else {
                 console.log("No inlineData in response:", JSON.stringify(imgRes, null, 2));
            }
        } catch (e: any) {
            console.error("Image Gen Failed", e);
            if (e.message) console.error("Error Message:", e.message);
        }

        return { narrative, imageUrl };
    }

    async endBattle(winner?: BattlePlayer) {
        this.status = 'COMPLETED';
        if (winner) {
            await this.channel.send(`🏆 **TOURNAMENT CHAMPION:** ${winner.username}!\nGenerating victory package... (This may take a moment)`);

            try {
                const winnerImg = await this.fetchImageAsBase64(winner.avatarUrl);
                
                // --- VEO VIDEO PROMPT ---
                const veoPrompt = `
                    **VEO VIDEO PROMPT:**
                    Create a cinematic victory video for ${winner.username}.
                    Setting: ${this.settings.arena}.
                    Action: The champion stands triumphant, raising their arms in victory. Confetti falls.
                    Style: ${this.settings.style} animation.
                `;
                
                await this.channel.send({ 
                    content: `🎥 **Champion Video Prompt (VEO):**\n\`\`\`${veoPrompt}\`\`\`\n*(Copy this prompt to generate your video!)*` 
                });

                // 1. Generate Victory Montage (3-panel)
                const montagePrompt = `
                    STYLE: ${this.settings.style} comic book page, 3 distinct panels.
                    SUBJECT: Highlights of ${winner.username}'s tournament victory.
                    Panel 1: A fierce clash in the early rounds.
                    Panel 2: A desperate moment turned into a counter-attack.
                    Panel 3: The final winning strike.
                    ARENA: ${this.settings.arena}.
                    INSTRUCTIONS: Use REFERENCE 1 for the main character. Make it look like a cohesive comic page.
                `;

                const montageContents = [
                    { text: "REFERENCE 1 [CHAMPION]:" },
                    { inlineData: { mimeType: 'image/png', data: winnerImg } },
                    { text: montagePrompt }
                ];

                const montageRes = await this.genAI.models.generateContent({
                    model: "gemini-3-pro-image-preview",
                    contents: montageContents
                });
                
                let montageUrl = "";
                const mPart = montageRes.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
                if (mPart?.inlineData?.data) montageUrl = `data:${mPart.inlineData.mimeType};base64,${mPart.inlineData.data}`;

                // 2. Generate Back Cover
                const coverPrompt = `
                    STYLE: ${this.settings.style} comic book full-page back cover art. Masterpiece.
                    SCENE: ${winner.username} celebrating their victory in the ${this.settings.arena}.
                    ACTION: They are holding/wearing a Golden Crown.
                    ATMOSPHERE: Triumphant, epic, cinematic lighting.
                    TEXT: "CHAMPION" (integrated into art if possible).
                    INSTRUCTIONS: Use REFERENCE 1 for the character.
                `;

                const coverContents = [
                    { text: "REFERENCE 1 [CHAMPION]:" },
                    { inlineData: { mimeType: 'image/png', data: winnerImg } },
                    { text: coverPrompt }
                ];

                const coverRes = await this.genAI.models.generateContent({
                    model: "gemini-3-pro-image-preview",
                    contents: coverContents,
                    config: { imageConfig: { aspectRatio: '2:3' } } // Portrait for cover
                });

                let coverUrl = "";
                const cPart = coverRes.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
                if (cPart?.inlineData?.data) coverUrl = `data:${cPart.inlineData.mimeType};base64,${cPart.inlineData.data}`;

                // Send Montage
                if (montageUrl) {
                    const buffer = Buffer.from(montageUrl.split(',')[1], 'base64');
                    const attachment = new AttachmentBuilder(buffer, { name: 'montage.png' });
                    await this.channel.send({ content: "**Victory Highlights**", files: [attachment] });
                    this.victoryPages.push(montageUrl);
                }

                // Send Cover
                if (coverUrl) {
                    const buffer = Buffer.from(coverUrl.split(',')[1], 'base64');
                    const attachment = new AttachmentBuilder(buffer, { name: 'cover.png' });
                    await this.channel.send({ content: `**The Champion: ${winner.username}**!`, files: [attachment] });
                    this.victoryPages.push(coverUrl);
                }

                // --- GENERATE PDF ---
                await this.generateAndUploadPDF();

            } catch (e) {
                console.error("Victory generation failed", e);
                await this.channel.send("❌ Failed to generate victory images, but the glory is still yours!");
            }

        } else {
            await this.channel.send("The battle ended with no winner?");
        }
    }

    private async generateAndUploadPDF() {
        await this.channel.send("📚 **Compiling Full Comic Book Issue...**");

        const doc = new PDFDocument({ autoFirstPage: false });
        const buffers: Buffer[] = [];

        doc.on('data', buffers.push.bind(buffers));
        
        const pdfPromise = new Promise<Buffer>((resolve) => {
            doc.on('end', () => {
                resolve(Buffer.concat(buffers));
            });
        });

        // Collect all pages: History (H2H + Action) + Victory Pages
        const allImages: string[] = [];
        
        for (const round of this.history) {
            if (round.headToHeadUrl) allImages.push(round.headToHeadUrl);
            if (round.imageUrl) allImages.push(round.imageUrl);
        }
        
        // Add victory pages
        allImages.push(...this.victoryPages);

        if (allImages.length === 0) {
            await this.channel.send("⚠️ No images to compile for PDF.");
            return;
        }

        for (const imgData of allImages) {
            if (!imgData.startsWith('data:image')) continue;
            
            let imgBuffer = Buffer.from(imgData.split(',')[1], 'base64');
            
            try {
                // Compress image using Jimp to reduce PDF size
                const image = await Jimp.read(imgBuffer);
                image.resize(600, Jimp.AUTO); // Resize width to 600px
                image.quality(60); // Set JPEG quality to 60%
                imgBuffer = await image.getBufferAsync(Jimp.MIME_JPEG) as any;
            } catch (e) {
                console.error("Error compressing image:", e);
                // Fallback to original buffer if compression fails
            }
            
            doc.addPage({ size: [480, 720], margin: 0 });
            doc.image(imgBuffer, 0, 0, { width: 480, height: 720 });
        }

        doc.end();
        const pdfBuffer = await pdfPromise;

        const attachment = new AttachmentBuilder(pdfBuffer, { name: 'Infinite-Heroes-Tournament.pdf' });
        await this.channel.send({
            content: "✅ **Full Tournament Comic Ready!** Download below.",
            files: [attachment]
        });
    }
}