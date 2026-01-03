import { Connection, PublicKey } from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { fetchDigitalAsset, mplTokenMetadata, findMetadataPda, deserializeMetadata } from '@metaplex-foundation/mpl-token-metadata';
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
    "6a5FuaxdKmhjm5GnTXPcJnqCqFftvho2E5Wo7N7diXtx": "GAINZ",
    "D8bd7Mmev6nopizftEhn6UqFZ7xNKuy6XmM5u3Q78KuD": "THC Labz | The Growerz",
    "4BSg57JLDQFpGeGMQUeTRGbMGYCwqYKbdzFqPGhgP5nj": "Partner Collection (4BSg)",
};

/**
 * Helper to get the list of configured collections (Label -> IDs)
 */
export async function getAvailableCollections(): Promise<Map<string, string>> {
    const serverCollection = await getConfig('server_collection');
    const partnerCollectionsStr = await getConfig('partner_collections');
    const collectionMapStr = await getConfig('collection_map');
    const enablePartners = await getConfig('enable_partners') === 'true';

    const groups = new Set<string>();
    if (serverCollection) {
        serverCollection.split(',').forEach(s => { if(s.trim()) groups.add(s.trim()); });
    }
    if (enablePartners && partnerCollectionsStr) {
        partnerCollectionsStr.split(',').forEach(s => { if(s.trim()) groups.add(s.trim()); });
    }
    
    const map = new Map<string, string>();
    let savedMap: Record<string, string> = {};
    try {
        if (collectionMapStr) {
            savedMap = JSON.parse(collectionMapStr);
        }
    } catch (e) {
        console.error("Failed to parse collection_map config", e);
    }

    for (const g of groups) {
        // 1. Check Hardcoded List
        if (KNOWN_COLLECTIONS[g]) {
            map.set(g, KNOWN_COLLECTIONS[g]);
            continue;
        }

        // 2. Check Saved Map (from Admin Config)
        if (savedMap[g]) {
            map.set(g, savedMap[g]);
            continue;
        }

        // 3. Check Cache
        if (collectionNameCache.has(g)) {
            map.set(g, collectionNameCache.get(g)!);
            continue;
        }

        // 4. If it looks like an address, try to fetch its name (Fallback)
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

        // 3. Check each NFT against the collection (Optimized with Batch Fetching)
        console.log(`[Verifier] Batch fetching metadata for ${nftMints.length} NFTs...`);
        
        // Calculate PDAs for all mints
        const metadataPDAs = nftMints.map(mint => findMetadataPda(umi, { mint: publicKey(mint) }));
        
        // Chunk into 100s (Solana RPC limit for getMultipleAccounts)
        const CHUNK_SIZE = 100;
        
        for (let i = 0; i < metadataPDAs.length; i += CHUNK_SIZE) {
            const chunkPDAs = metadataPDAs.slice(i, i + CHUNK_SIZE).map(pda => pda[0]);
            const chunkMints = nftMints.slice(i, i + CHUNK_SIZE);
            
            try {
                const accounts = await umi.rpc.getAccounts(chunkPDAs);
                
                // Process each account in the chunk
                await Promise.all(accounts.map(async (account, idx) => {
                    if (!account.exists) return;
                    
                    try {
                        const metadata = deserializeMetadata(account);
                        const mint = chunkMints[idx];
                        
                        // Check Collection
                        let isMatch = false;
                        let matchedGroup: string | undefined;

                        if (allowAny) {
                            isMatch = true; 
                            matchedGroup = "Any";
                        } else {
                            // 1. Check MCC (Verified Collection)
                            if (metadata.collection?.__option === 'Some' && metadata.collection.value.verified) {
                                const collectionKey = metadata.collection.value.key.toString();
                                if (validCollections.has(collectionKey)) {
                                    isMatch = true;
                                    matchedGroup = validCollections.get(collectionKey);
                                }
                            }

                            // 2. Check Creators (if not matched yet)
                            if (!isMatch && metadata.creators.__option === 'Some') {
                                for (const creator of metadata.creators.value) {
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
                            try {
                                const response = await fetch(metadata.uri);
                                if (response.ok) {
                                    const json = await response.json();
                                    validNFTs.push({
                                        name: metadata.name,
                                        image: json.image,
                                        attributes: json.attributes || [],
                                        mint: mint,
                                        collectionName: metadata.symbol,
                                        collectionGroup: matchedGroup
                                    });
                                }
                            } catch (err) {
                                console.warn(`Failed to fetch JSON for matched NFT ${mint}:`, err);
                            }
                        }
                    } catch (e) {
                        console.warn(`Failed to deserialize/process metadata for mint ${chunkMints[idx]}`, e);
                    }
                }));
            } catch (e) {
                console.error(`Failed to fetch batch of accounts`, e);
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
