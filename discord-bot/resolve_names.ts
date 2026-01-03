import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { fetchDigitalAsset } from '@metaplex-foundation/mpl-token-metadata';
import { publicKey } from '@metaplex-foundation/umi';

// Use a public RPC or the one from env
const rpcUrl = 'https://api.mainnet-beta.solana.com'; 
const umi = createUmi(rpcUrl);

const addresses = [
    "6a5FuaxdKmhjm5GnTXPcJnqCqFftvho2E5Wo7N7diXtx",
    "6BJuVsENAMUEvR9ftviSVb5JokS12pF3FF2EnExdc2UD",
    "D8bd7Mmev6nopizftEhn6UqFZ7xNKuy6XmM5u3Q78KuD",
    "4BSg57JLDQFpGeGMQUeTRGbMGYCwqYKbdzFqPGhgP5nj"
];

async function run() {
    for (const addr of addresses) {
        try {
            console.log(`Fetching ${addr}...`);
            const asset = await fetchDigitalAsset(umi, publicKey(addr));
            console.log(`${addr} -> ${asset.metadata.name}`);
        } catch (e: any) {
            console.error(`Failed ${addr}:`, e.message);
        }
    }
}

run();
