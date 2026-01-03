# Infinite Heroes Bot - Status & Todo

## Current Status (Jan 2, 2026)
- **AI Models**: 
    - Text: `gemini-2.0-flash-exp` (Fixed 404 errors).
    - Image: `gemini-3-pro-image-preview` (Restored for reliability).
- **Battle Logic**: 
    - Implemented multi-scene battles (Best of 3 for 1v1/Finals, Best of 2 for others).
    - Fixed "Bot Stuck" issues by managing interaction timeouts better.
- **NFT Verification**: 
    - Optimized `SolanaVerifier` to use batch fetching (Chunk size 100) for faster scanning.
    - Fixed "Collection Name" resolution using Admin Config map.
- **Victory Package**: 
    - Generates "Victory Montage" (3-panel comic) and "Back Cover".
    - Generates a text prompt for Veo video creation.

## Todo List (Next Session)

### Critical Fixes
- [ ] **Veo Prompt Image Link**: The `avatarUrl` provided to Veo is often an Irys/Arweave link which Veo rejects. 
    - *Solution Idea*: Use the Discord attachment URL (proxy) or upload the image to a temporary public host if possible. Or rely on a detailed text description.
- [ ] **Front Cover Generation**: Implement a "Lobby Poster" / "Front Cover" generation at the start of the battle.
    - *Requirement*: Composite image of all fighters squaring up, tightening gloves, etc.
- [ ] **Story-to-Image Consistency**: Ensure the narrative text generated is strictly used as the prompt for the corresponding panel image.

### High Priority
- [ ] **Refine Battle Pacing**: Ensure the transition between scenes (1/3 -> 2/3 -> 3/3) is smooth and engaging.
- [ ] **PDF Compilation**: Verify the full PDF includes the new Front Cover, all Scene images, Victory Montage, and Back Cover.

### Backlog
- [ ] **Database Persistence**: Ensure match history and stats are saved to Supabase.
- [ ] **Gang Mode**: Re-verify Gang Mode logic with the new battle system.
