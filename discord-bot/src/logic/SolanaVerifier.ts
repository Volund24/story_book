import { Connection, PublicKey } from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { fetchDigitalAsset, mplTokenMetadata } from '@metaplex-foundation/mpl-token-metadata';
import { publicKey } from '@metaplex-foundation/umi';

// Initialize Solana Connection (Mainnet)
const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';
const umi = createUmi(RPC_ENDPOINT).use(mplTokenMetadata());

export interface NFTData {
    name: string;
    image: string;
    attributes: { trait_type: string; value: string }[];
    rarityRank?: number; // Placeholder for future rarity logic
}

/**
 * Verifies if a wallet owns an NFT from a specific collection (or any NFT if collection not specified)
 * Returns the NFT metadata if found, null otherwise.
 */
export async function verifyWalletAndGetNFT(walletAddress: string, collectionAddress?: string): Promise<NFTData | null> {
    try {
        const owner = new PublicKey(walletAddress);
        const connection = new Connection(RPC_ENDPOINT);

        // 1. Fetch all token accounts for this wallet
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, {
            programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
        });

        // 2. Filter for NFTs (Amount = 1, Decimals = 0)
        const nftMints = tokenAccounts.value
            .filter(t => {
                const amount = t.account.data.parsed.info.tokenAmount;
                return amount.uiAmount === 1 && amount.decimals === 0;
            })
            .map(t => t.account.data.parsed.info.mint);

        if (nftMints.length === 0) return null;

        // 3. Check each NFT against the collection (or just pick the first one if no collection specified)
        // Note: For production, we should optimize this to not fetch metadata for EVERY token.
        // But for now, we iterate until we find a match.
        
        for (const mint of nftMints) {
            try {
                const asset = await fetchDigitalAsset(umi, publicKey(mint));
                
                // Check Collection
                let isMatch = false;
                if (!collectionAddress) {
                    isMatch = true; // Accept any NFT if no collection specified
                } else if (asset.metadata.collection?.__option === 'Some' && asset.metadata.collection.value.verified) {
                    if (asset.metadata.collection.value.key.toString() === collectionAddress) {
                        isMatch = true;
                    }
                }

                if (isMatch) {
                    // Fetch JSON Metadata (Image, Attributes)
                    const response = await fetch(asset.metadata.uri);
                    const json = await response.json();

                    return {
                        name: asset.metadata.name,
                        image: json.image,
                        attributes: json.attributes || []
                    };
                }
            } catch (e) {
                console.warn(`Failed to fetch metadata for mint ${mint}`, e);
                continue;
            }
        }

        return null; // No matching NFT found

    } catch (error) {
        console.error("Solana Verification Error:", error);
        return null;
    }
}
