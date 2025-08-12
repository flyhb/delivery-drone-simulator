import { ethers, Contract, JsonRpcProvider } from 'ethers';

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
  const address = process.env.IOID_REGISTRY;
  if (!address) {
    throw new Error('IOID_REGISTRY must be defined in the environment');
  }
  // Minimal ABI for the ioIDRegistry used by the simulator
  const abi = [
    'function exists(address device) view returns (bool)',
    'function nonces(address device) view returns (uint256)',
    'function register(address deviceContract,uint256 tokenId,address user,address device,bytes32 hash,string uri,uint8 v,bytes32 r,bytes32 s) payable',
    'function register(address deviceContract,uint256 tokenId,address device,bytes32 hash,string uri,uint8 v,bytes32 r,bytes32 s) payable',
  ];
  return new ethers.Contract(address, abi, provider);
}