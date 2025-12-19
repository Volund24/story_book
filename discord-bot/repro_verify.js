
const { Connection, PublicKey } = require('@solana/web3.js');
const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults');
const { mplTokenMetadata, fetchDigitalAsset } = require('@metaplex-foundation/mpl-token-metadata');
const { publicKey } = require('@metaplex-foundation/umi');

// Initialize Solana Connection (Mainnet)
const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';
const umi = createUmi(RPC_ENDPOINT).use(mplTokenMetadata());

// Mock DB Config
const MOCK_CONFIG = {
    server_collection: '', // Will be populated
    partner_collections: '',
    enable_partners: 'false'
};

async function getConfig(key) {
    return MOCK_CONFIG[key];
}

async function resolveCollectionFromSlug(slug) {
    try {
        console.log(`Resolving slug: ${slug}...`);
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
        console.log(`First mint found: ${mintAddress}`);

        // Fetch on-chain data
        const asset = await fetchDigitalAsset(umi, publicKey(mintAddress));
        const ids = [];

        // 1. MCC (Verified Collection)
        if (asset.metadata.collection?.__option === 'Some' && asset.metadata.collection.value.verified) {
            ids.push(asset.metadata.collection.value.key.toString());
            console.log(`Found MCC: ${ids[0]}`);
        }

        // 2. First Creator (Verified) - For Legacy Collections
        if (asset.metadata.creators.__option === 'Some' && asset.metadata.creators.value.length > 0) {
            const firstCreator = asset.metadata.creators.value[0];
            if (firstCreator.verified) {
                ids.push(firstCreator.address.toString());
                console.log(`Found Creator: ${ids[ids.length-1]}`);
            }
        }
        
        return ids;

    } catch (error) {
        console.error(`Error resolving slug ${slug}:`, error);
        return [];
    }
}

async function verifyWalletAndGetNFTs(walletAddress) {
    try {
        // Load Config
        const serverCollection = await getConfig('server_collection');
        const partnerCollectionsStr = await getConfig('partner_collections');
        const enablePartners = await getConfig('enable_partners') === 'true';

        const validCollections = new Set();
        if (serverCollection) {
            serverCollection.split(',').map(s => s.trim()).filter(s => s.length > 0).forEach(c => validCollections.add(c));
        }
        if (enablePartners && partnerCollectionsStr) {
            partnerCollectionsStr.split(',').map(s => s.trim()).filter(s => s.length > 0).forEach(c => validCollections.add(c));
        }

        const allowAny = validCollections.size === 0;
        
        console.log(`[Verifier] Checking wallet: ${walletAddress}`);
        console.log(`[Verifier] Valid Collections: ${Array.from(validCollections).join(', ')} (AllowAny: ${allowAny})`);

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

        const validNFTs = [];

        // 3. Check each NFT against the collection
        // Note: In a production env with many NFTs, we should use a DAS API (Helius/QuickNode) 
        // instead of fetching one by one to avoid rate limits.
        // LIMIT TO 10 FOR DEBUGGING SPEED
        let checked = 0;
        for (const mint of nftMints) {
            if (checked >= 10) break; 
            checked++;
            
            try {
                const asset = await fetchDigitalAsset(umi, publicKey(mint));
                
                // Check Collection
                let isMatch = false;
                if (allowAny) {
                    isMatch = true; 
                } else {
                    // 1. Check MCC (Verified Collection)
                    if (asset.metadata.collection?.__option === 'Some' && asset.metadata.collection.value.verified) {
                        const collectionKey = asset.metadata.collection.value.key.toString();
                        if (validCollections.has(collectionKey)) {
                            isMatch = true;
                            console.log(`[Verifier] Match found (MCC) for mint ${mint}`);
                        }
                    }

                    // 2. Check Creators (if not matched yet)
                    if (!isMatch && asset.metadata.creators.__option === 'Some') {
                        for (const creator of asset.metadata.creators.value) {
                            if (creator.verified && validCollections.has(creator.address.toString())) {
                                isMatch = true;
                                console.log(`[Verifier] Match found (Creator) for mint ${mint}`);
                                break;
                            }
                        }
                    }
                }

                if (isMatch) {
                    console.log(`MATCH CONFIRMED: ${mint}`);
                    validNFTs.push({ mint });
                }
            } catch (e) {
                console.warn(`Failed to fetch metadata for mint ${mint}`, e);
                continue;
            }
        }
        
        console.log(`[Verifier] Total valid NFTs found: ${validNFTs.length}`);
        return validNFTs;

    } catch (error) {
        console.error("Solana Verification Error:", error);
        return [];
    }
}

async function run() {
    // 1. Resolve Gainz
    const ids = await resolveCollectionFromSlug('gainz');
    console.log('Resolved IDs for gainz:', ids);
    
    if (ids.length > 0) {
        MOCK_CONFIG.server_collection = ids.join(',');
    } else {
        console.log("Could not resolve gainz, using empty config (AllowAny test?) or failing.");
    }

    // 2. Check Wallet
    const wallet = 'GQtVDQnNCcpYCbpneEw675ufsGbJQkJzLtSHPWXLQAUP';
    await verifyWalletAndGetNFTs(wallet);
}

run();
