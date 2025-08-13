import { Contract, ethers } from 'ethers';

export type ProjectRow = {
  projectId: bigint;
  name: string | null;
  deviceNFT: string | null;
};

export type OwnedChoice = {
  projectId: bigint;
  projectName: string | null;
  contract: string;
  tokenId: bigint;

  // NEW: enriched metadata for menu labels
  nftName?: string;
  nftSymbol?: string;
};

const STORE_ABI = [
  'function project() view returns (address)',
  'function price() view returns (uint256)',
  'function projectDeviceContract(uint256) view returns (address)',
  //'function deviceContractProject(address) view returns (uint256)'
];

const PROJECT_ABI = [
  'function count() view returns (uint256)',
  'function name(uint256) view returns (string)'
];

// ERC721 Enumerable-only surface we need for efficient owner enumeration
const ERC721_ENUM_OWNER_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
];

// NEW: minimal ERC-721 metadata ABI for name/symbol
const ERC721_META_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)'
];

function isAddr(x: string | null | undefined): x is string {
  return !!x && /^0x[0-9a-fA-F]{40}$/.test(x);
}

async function tryCall<T = any>(c: Contract, fn: string, args: any[] = []): Promise<T | null> {
  try {
    // @ts-ignore
    return await c[fn](...args);
  } catch {
    return null;
  }
}

/** Read the Project contract from Store, then enumerate all projects and their device NFT. */
export async function listProjectsFromStore(
  provider: ethers.Provider,
  storeAddr: string
): Promise<ProjectRow[]> {
  const store = new Contract(storeAddr, STORE_ABI, provider);
  const projectAddr: string = await store.project(); // exact from ioIDStore.sol
  const project = new Contract(projectAddr, PROJECT_ABI, provider);

  const total: bigint = await project.count(); // exact from Project.sol
  const rows: ProjectRow[] = [];

  for (let id = 1n; id <= total; id++) {
    const [name, deviceNFT] = await Promise.all([
      tryCall<string>(project, 'name', [id]),
      tryCall<string>(store, 'projectDeviceContract', [id]) // exact from ioIDStore.sol
    ]);

    rows.push({
      projectId: id,
      name: name ?? null,
      deviceNFT: isAddr(deviceNFT ?? '') ? (deviceNFT as string) : null
    });
  }
  return rows;
}

/** Enumerate owner’s tokenIds using ERC721Enumerable (balanceOf + tokenOfOwnerByIndex). */
export async function listOwnedTokensEnumerable(
  provider: ethers.Provider,
  nftAddr: string,
  owner: string
): Promise<bigint[]> {
  const nft = new Contract(nftAddr, ERC721_ENUM_OWNER_ABI, provider);
  const bal = await nft.balanceOf(owner) as bigint;
  const out: bigint[] = [];
  for (let i = 0n; i < bal; i++) {
    const tidStr = await tryCall<string>(nft, 'tokenOfOwnerByIndex', [owner, i]);
    if (tidStr !== null) {
      out.push(BigInt(tidStr));
    }
  }
  return out;
}

// --- NEW: helper to fetch name/symbol with graceful failure ---
async function fetchNameSymbol(
  provider: ethers.Provider,
  nftAddr: string
): Promise<{ nftName?: string; nftSymbol?: string }> {
  const meta = new Contract(nftAddr, ERC721_META_ABI, provider);
  let nftName: string | undefined;
  let nftSymbol: string | undefined;
  try { nftName = await meta.name(); } catch {}
  try { nftSymbol = await meta.symbol(); } catch {}
  return { nftName, nftSymbol };
}

/** Full discovery: ioIDStore → Project list → deviceNFT per project → owner’s tokens (+ NFT name/symbol). */
export async function discoverOwnedChoicesFromStore(
  provider: ethers.Provider,
  storeAddr: string,
  owner: string
): Promise<OwnedChoice[]> {
  const rows = await listProjectsFromStore(provider, storeAddr);
  const choices: OwnedChoice[] = [];

  // cache metadata fetch per NFT contract to avoid duplicate RPCs
  const metaCache = new Map<string, Promise<{ nftName?: string; nftSymbol?: string }>>();

  for (const r of rows) {
    if (!isAddr(r.deviceNFT)) continue;

    if (!metaCache.has(r.deviceNFT!)) {
      metaCache.set(r.deviceNFT!, fetchNameSymbol(provider, r.deviceNFT!));
    }
    const metaP = metaCache.get(r.deviceNFT!)!;

    const tokenIds = await listOwnedTokensEnumerable(provider, r.deviceNFT!, owner);
    const { nftName, nftSymbol } = await metaP;

    for (const tid of tokenIds) {
      choices.push({
        contract: r.deviceNFT!,
        tokenId: tid,
        projectId: r.projectId,
        projectName: r.name,
        nftName,
        nftSymbol
      });
    }
  }
  return choices;
}

/** Read on-chain price from ioIDStore (exact: price() in ioIDStore.sol). */
export async function readPriceWei(provider: ethers.Provider, storeAddr: string): Promise<bigint> {
  const store = new Contract(storeAddr, STORE_ABI, provider);
  try {
    const p: bigint = await store.price();
    return p ?? 0n;
  } catch {
    return 0n;
  }
}