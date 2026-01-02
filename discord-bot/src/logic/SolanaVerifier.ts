import { Connection, PublicKey } from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { fetchDigitalAsset, mplTokenMetadata } from '@metaplex-foundation/mpl-token-metadata';
import { publicKey } from '@metaplex-foundation/umi';
import { getConfig } from '../db';

// Initialize Solana Connection (Mainnet)
const RPC_ENDPOINT = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const umi = createUmi(RPC_ENDPOINT).use(mplTokenMetadata());

export interface NFTData {
    name: string;
    image: string;
    attributes: { trait_type: string; value: string }[];
    rarityRank?: number; // Placeholder for future rarity logic
    mint: string;
    collectionName?: string;
    collectionGroup?: string;
}

// Cache for collection names to avoid repeated RPC calls
const collectionNameCache = new Map<string, string>();

// Hardcoded Collection Names (Address -> Name)
const KNOWN_COLLECTIONS: Record<string, string> = {
    "6BJuVsENAMUEvR9ftviSVb5JokS12pF3FF2EnExdc2UD": "Gainz",
    // Add more here if needed
};

/**
 * Helper to get the list of configured collections (Label -> IDs)
 */
export async function getAvailableCollections(): Promise<Map<string, string>> {
    const serverCollection = await getConfig('server_collection');
    const partnerCollectionsStr = await getConfig('partner_collections');
    const enablePartners = await getConfig('enable_partners') === 'true';

    const groups = new Set<string>();
    if (serverCollection) {
        serverCollection.split(',').forEach(s => { if(s.trim()) groups.add(s.trim()); });
    }
    if (enablePartners && partnerCollectionsStr) {
        partnerCollectionsStr.split(',').forEach(s => { if(s.trim()) groups.add(s.trim()); });
    }
    
    const map = new Map<string, string>();
    
    for (const g of groups) {
        // 1. Check Hardcoded List
        if (KNOWN_COLLECTIONS[g]) {
            map.set(g, KNOWN_COLLECTIONS[g]);
            continue;
        }

        // 2. Check Cache
        if (collectionNameCache.has(g)) {
            map.set(g, collectionNameCache.get(g)!);
            continue;
        }

        // 3. If it looks like an address, try to fetch its name (Fallback)
        if (g.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
            try {
                console.log(`Fetching metadata for collection: ${g}`);
                const asset = await fetchDigitalAsset(umi, publicKey(g));
                const name = asset.metadata.name;
                console.log(`Resolved collection ${g} to name: ${name}`);
                map.set(g, name);
                collectionNameCache.set(g, name);
            } catch (e) {
                console.error(`Failed to fetch name for collection ${g}:`, e);
                const fallback = `${g.substring(0, 4)}...${g.substring(g.length - 4)}`;
                map.set(g, fallback);
                collectionNameCache.set(g, fallback);
            }
        } else {
            // It's likely a slug or name already
            map.set(g, g);
            collectionNameCache.set(g, g);
        }
    }
    
    return map;
}

/**
 * Verifies if a wallet owns NFTs from a specific collection (or any NFT if collection not specified)
 * Returns a list of valid NFT metadata.
 */
export async function verifyWalletAndGetNFTs(walletAddress: string, targetCollectionGroup?: string): Promise<NFTData[]> {
    try {
        // Load Config
        const serverCollection = await getConfig('server_collection');
        const partnerCollectionsStr = await getConfig('partner_collections');
        const enablePartners = await getConfig('enable_partners') === 'true';

        // Map of Collection ID -> Config Label (e.g. "gainz")
        const validCollections = new Map<string, string>();
        
        const processConfigItem = async (item: string, label: string) => {
            const s = item.trim();
            if (s.length === 0) return;
            
            // If a target is specified, skip if this item doesn't match the target label
            if (targetCollectionGroup && label !== targetCollectionGroup) return;

            // Check if it looks like a Solana Public Key
            if (s.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
                validCollections.set(s, label);
            } else {
                // Assume it's a slug and try to resolve it
                console.log(`[Verifier] Config item '${s}' is not a key, attempting to resolve as slug...`);
                const resolved = await resolveCollectionFromSlug(s);
                resolved.forEach(id => validCollections.set(id, label));
                console.log(`[Verifier] Resolved '${s}' to: ${resolved.join(', ')}`);
            }
        };

        if (serverCollection) {
            for (const item of serverCollection.split(',')) {
                await processConfigItem(item, item); // Use item as label for server collection? Or "Server"?
                // For simplicity, let's assume server collection items are their own group unless defined otherwise
            }
        }
        if (enablePartners && partnerCollectionsStr) {
            for (const item of partnerCollectionsStr.split(',')) {
                await processConfigItem(item, item);
            }
        }

        const allowAny = validCollections.size === 0 && !targetCollectionGroup;
        
        console.log(`[Verifier] Checking wallet: ${walletAddress}`);
        console.log(`[Verifier] Valid Collections: ${Array.from(validCollections.keys()).join(', ')} (AllowAny: ${allowAny})`);

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

        console.log(`[Verifier] Found ${nftMints.length} potential NFTs in wallet.`);

        if (nftMints.length === 0) return [];

        const validNFTs: NFTData[] = [];

        // 3. Check each NFT against the collection (Parallelized with Rate Limiting)
        // Public RPCs have strict rate limits. We must be conservative.
        const BATCH_SIZE = 3; 
        const DELAY_MS = 1000; // 1 second delay between batches

        const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

        for (let i = 0; i < nftMints.length; i += BATCH_SIZE) {
            const batch = nftMints.slice(i, i + BATCH_SIZE);
            
            await Promise.all(batch.map(async (mint) => {
                try {
                    const asset = await fetchDigitalAsset(umi, publicKey(mint));
                    
                    // Check Collection
                    let isMatch = false;
                    let matchedGroup: string | undefined;

                    if (allowAny) {
                        isMatch = true; 
                        matchedGroup = "Any";
                    } else {
                        // 1. Check MCC (Verified Collection)
                        if (asset.metadata.collection?.__option === 'Some' && asset.metadata.collection.value.verified) {
                            const collectionKey = asset.metadata.collection.value.key.toString();
                            if (validCollections.has(collectionKey)) {
                                isMatch = true;
                                matchedGroup = validCollections.get(collectionKey);
                            }
                        }

                        // 2. Check Creators (if not matched yet)
                        if (!isMatch && asset.metadata.creators.__option === 'Some') {
                            for (const creator of asset.metadata.creators.value) {
                                if (creator.verified && validCollections.has(creator.address.toString())) {
                                    isMatch = true;
                                    matchedGroup = validCollections.get(creator.address.toString());
                                    break;
                                }
                            }
                        }
                    }

                    if (isMatch) {
                        // Fetch JSON Metadata (Image, Attributes)
                        const response = await fetch(asset.metadata.uri);
                        const json = await response.json();

                        validNFTs.push({
                            name: asset.metadata.name,
                            image: json.image,
                            attributes: json.attributes || [],
                            mint: mint,
                            collectionName: asset.metadata.symbol,
                            collectionGroup: matchedGroup
                        });
                    }
                } catch (e) {
                    // Only log critical errors, suppress 429s if they are handled by retries or just skip
                    // console.warn(`Failed to fetch metadata for mint ${mint}`, e);
                }
            }));

            // Add delay between batches to respect rate limits
            if (i + BATCH_SIZE < nftMints.length) {
                await sleep(DELAY_MS);
            }
        }
        
        console.log(`[Verifier] Total valid NFTs found: ${validNFTs.length}`);
        return validNFTs;

    } catch (error) {
        console.error("Solana Verification Error:", error);
        return [];
    }
}

// Legacy wrapper for backward compatibility if needed, but we should update callers
export async function verifyWalletAndGetNFT(walletAddress: string): Promise<NFTData | null> {
    const nfts = await verifyWalletAndGetNFTs(walletAddress);
    return nfts.length > 0 ? nfts[0] : null;
}

/**
 * Resolves a HowRare.is slug to a Solana Collection Address (Mint) AND/OR Creator Address.
 * It does this by fetching the collection items from HowRare, picking the first one,
 * and checking its on-chain collection verification data and creators.
 */
export async function resolveCollectionFromSlug(slug: string): Promise<string[]> {
    try {
        const cleanSlug = slug.replace(/^\//, '').trim();
        if (!cleanSlug) return [];
        
        const url = `https://api.howrare.is/v0.1/collections/${cleanSlug}`;
        const response = await fetch(url);
        
        if (!response.ok) {
            console.error(`HowRare API error for ${slug}: ${response.statusText}`);
            return [];
        }

        const data = await response.json();
        const items = data.result?.data?.items;

        if (!items || !Array.isArray(items) || items.length === 0) {
            return [];
        }

        // Get the first mint
        const firstItem = items[0];
        const mintAddress = firstItem.mint;

        if (!mintAddress) return [];

        // Fetch on-chain data
        const asset = await fetchDigitalAsset(umi, publicKey(mintAddress));
        const ids: string[] = [];

        // 1. MCC (Verified Collection)
        if (asset.metadata.collection?.__option === 'Some' && asset.metadata.collection.value.verified) {
            ids.push(asset.metadata.collection.value.key.toString());
        }

        // 2. First Creator (Verified) - For Legacy Collections
        if (asset.metadata.creators.__option === 'Some' && asset.metadata.creators.value.length > 0) {
            const firstCreator = asset.metadata.creators.value[0];
            if (firstCreator.verified) {
                ids.push(firstCreator.address.toString());
            }
        }
        
        return ids;

    } catch (error) {
        console.error(`Error resolving slug ${slug}:`, error);
        return [];
    }
}
