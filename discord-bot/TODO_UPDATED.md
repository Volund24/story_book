# Infinite Heroes Bot - Status & Todo

## Current Status (As of Session Wrap-up)
- **Branch**: `CollectionVersion`
- **Recent Changes**:
    - **Gang Mode**: Implemented UI for selecting Gangs and logic for handling them.
    - **Wallet Verification**: Optimized flow to "Select Collection -> Verify" to reduce RPC calls. Implemented batching (size 3, 1s delay) to avoid 429 errors.
    - **PDF Generation**: Restored `BattleManager.ts` logic and fixed syntax errors.
    - **Interaction Handling**: Centralized `battle_*` interaction routing in `index.ts`.
    - **Debug**: Added `/battle fill_bots` to quickly populate a lobby for testing.

## Todo List

### High Priority
- [ ] **Multi-User Testing**: Test the battle flow with multiple real users to ensure interaction handling works concurrently.
- [ ] **Full Battle Loop**: Run a complete battle from Lobby -> Start -> PDF Generation -> End to verify the entire pipeline.
- [ ] **Database Verification**: Confirm that Gang selections and Player stats are correctly persisted in Supabase.
- [ ] **Error Handling**: Add more robust error handling for PDF generation failures or network timeouts during battle.

### Medium Priority
- [ ] **Cleanup**: Remove `fill_bots` command before production deployment.
- [ ] **Refactoring**: Move interaction handlers from `index.ts` to dedicated handler files if `index.ts` grows too large.
- [ ] **Config**: Externalize batch size and delay settings for `SolanaVerifier` to environment variables.

### Low Priority
- [ ] **UI Polish**: Improve the formatting of the Battle Log and PDF output.
- [ ] **Metrics**: Add logging for RPC usage to monitor rate limits over time.
