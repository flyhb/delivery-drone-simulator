import { ethers, Contract, JsonRpcProvider } from 'ethers';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Checks if the given address is a valid Ethereum address.
 * @param addr - the address to check
 * @returns 
 */
const isAddress = (addr?: string) => {
  if (!addr) return false;
  const anyEth: any = ethers as any;
  try {
    if (typeof anyEth.isAddress === 'function') return anyEth.isAddress(addr);                 // v6
    if (anyEth.utils && typeof anyEth.utils.isAddress === 'function') return anyEth.utils.isAddress(addr); // v5
    const getAddress = anyEth.getAddress || anyEth.utils?.getAddress;                          // fallback
    if (typeof getAddress === 'function') { getAddress(addr); return true; }
  } catch { return false; }
  return /^0x[a-fA-F0-9]{40}$/.test(addr); // last-resort shape check
};

/**
 * Returns a JSON-RPC provider using the environment variables RPC_URL
 * and CHAIN_ID.  The CHAIN_ID is optional for ethers.JsonRpcProvider
 * but included here for completeness.  Throws if RPC_URL is missing.
 */
export function getProvider(): JsonRpcProvider {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    throw new Error('RPC_URL must be defined in the environment');
  }
  const chainId = process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID, 10) : undefined;
  return new ethers.JsonRpcProvider(rpcUrl, chainId);
}

/**
 * Returns an ethers Contract instance for the ioIDRegistry.  This
 * minimal ABI contains only the functions needed by the simulator.  If
 * IOID_REGISTRY is not provided, this function throws.
 */
export function getRegistry(provider: JsonRpcProvider): Contract {

  // Minimal ABI for the ioIDRegistry used by the simulator
  const REGISTRY_ABI = [
    'function exists(address device) view returns (bool)',
    'function nonces(address device) view returns (uint256)',
    'function register(address deviceContract,uint256 tokenId,address user,address device,bytes32 hash,string uri,uint8 v,bytes32 r,bytes32 s) payable',
    'function register(address deviceContract,uint256 tokenId,address device,bytes32 hash,string uri,uint8 v,bytes32 r,bytes32 s) payable',
  ];

  const envRegistry = process.env.IOID_REGISTRY;
  if (envRegistry) {
    if (!isAddress(envRegistry) || envRegistry === ZERO_ADDRESS) {
      throw new Error(`IOID_REGISTRY is set but invalid: ${envRegistry}`);
    }
    return new ethers.Contract(envRegistry, REGISTRY_ABI, provider);
  }

  // Fallback: discover via ioIDStore
  const storeAddr = process.env.IOID_STORE;
  if (!storeAddr) {
    throw new Error('IOID_STORE must be defined in the environment (or provide IOID_REGISTRY).');
  }
  if (!isAddress(storeAddr) || storeAddr === ZERO_ADDRESS) {
    throw new Error(`IOID_STORE is invalid: ${storeAddr}`);
  }

  const STORE_ABI = ['function ioIDRegistry() view returns (address)'];
  const store = new ethers.Contract(storeAddr, STORE_ABI, provider);

  let registryAddr: string;
  try {
    registryAddr = await store.ioIDRegistry();
  } catch (err) {
    throw new Error(`Failed to read ioIDRegistry() from ioIDStore at ${storeAddr}: ${(err as Error).message}`);
  }

  if (!isAddress(registryAddr) || registryAddr === ZERO_ADDRESS) {
    throw new Error(`ioIDStore.ioIDRegistry() returned an invalid address: ${registryAddr}`);
  }

  return new ethers.Contract(registryAddr, REGISTRY_ABI, provider);

}