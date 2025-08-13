import { Wallet, ethers, Contract } from 'ethers';
import readline from 'readline';
import { getProvider, getRegistry } from '../utils/blockchain';
import { Device } from '../device/Device';
import {
  discoverOwnedChoicesFromStore,
  readPriceWei
} from './deviceNFTDiscovery';
import { selectWithArrows, shortAddr } from './ui';

export class Client {
  private initialized = false;
  private provider: ethers.JsonRpcProvider;
  private registry!: Contract;
  private device!: Device;

  constructor() {
    this.provider = getProvider();
  }

  private async init(): Promise<void> {
    if (this.initialized) return;

    this.registry = await getRegistry(this.provider);
    this.device = new Device(this.provider, this.registry);

    this.initialized = true;
  }

  private async ask(prompt: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(prompt, (a) => { rl.close(); resolve(a.trim()); }));
  }

  public async run(): Promise<void> {
    await this.init();

    console.log('Device booting...');
    console.log(`Device address: ${this.device.address()}`);

    if (await this.device.isRegistered()) {
      console.log('Device is already registered. Starting operation...');
      this.device.startOperationFlow();
      return;
    }

    // Owner wallet
    let ownerKey = process.env.OWNER_PRIVATE_KEY;
    if (!ownerKey || ownerKey.trim() === '') ownerKey = await this.ask('Enter owner private key (0x...): ');
    const ownerWallet = new Wallet(ownerKey!, this.provider);

    // ioIDStore is the source of truth for projects + device NFTs + on-chain price
    const IOID_STORE = process.env.IOID_STORE;
    if (!IOID_STORE) throw new Error('Set IOID_STORE in your .env to discover projects and price.');

    // Discover owner’s Device NFTs across all Store projects
    const choices = await discoverOwnedChoicesFromStore(this.provider, IOID_STORE, ownerWallet.address);
    if (choices.length === 0) {
      console.log('No Device NFTs found for your address in any ioIDStore project.');
      return;
    }

    // Build pretty menu items and let user pick via arrows (fallback to numeric inside selectWithArrows)
    const items = choices.map((c) => ({
      label: `${c.projectName ?? 'Unnamed Project'} (ID:${c.projectId.toString()}) - ${c.nftName ?? 'DeviceNFT'}${c.nftSymbol ? ` (${c.nftSymbol})` : ''} ${shortAddr(c.contract)} - #${c.tokenId.toString()}`,
      value: c
    }));

    const pick = await selectWithArrows('Select the Device NFT to register', items);

    console.log(`\nYou picked:\n  Project: ${pick.projectName ?? 'Unnamed'} (ID: ${pick.projectId})\n  Device NFT: ${pick.nftName ?? 'DeviceNFT'} (${pick.nftSymbol})\n  Contract: ${shortAddr(pick.contract)}\n  Token ID: #${pick.tokenId}\n`);

    console.log('Requesting signature to the drone...');
    // Device signs permit for this owner
    const { v, r, s, hash, uri } = await this.device.signPermit(ownerWallet.address);

    // Resolve price (prefer on-chain store; fallback to IOID_PRICE env)
    console.log(`Checking registration price on-chain...`);
    let value = await readPriceWei(this.provider, IOID_STORE);
    if (value === 0n) {
      console.log('No price found on-chain. Using IOID_PRICE from environment.');
      value = ethers.parseEther(process.env.IOID_PRICE || '0');
    }
    if (value === 0n) {
      console.log('No price set. Registration will be free.');
    } else {
      console.log(`Registration price: ${ethers.formatEther(value)} ETH`);
    }
    // Ensure approval for registry to move selected token
    const registryAddress = this.registry.target as string;
    const nft = new Contract(pick.contract, [
      'function isApprovedForAll(address,address) view returns (bool)',
      'function getApproved(uint256) view returns (address)',
      'function approve(address,uint256)'
    ], ownerWallet);

    const approvedForAll: boolean = await nft.isApprovedForAll(ownerWallet.address, registryAddress);
    if (!approvedForAll) {
      let tokenApproved = false;
      try {
        const cur: string = await nft.getApproved(pick.tokenId);
        tokenApproved = cur?.toLowerCase() === registryAddress.toLowerCase();
      } catch {
        // Some ERC721s may revert on getApproved — ignore and proceed to approve
      }
      if (!tokenApproved) {
        console.log(`Approving registry contract ${shortAddr(registryAddress)} to manage your Device NFT...`);
        const txA = await nft.approve(registryAddress, pick.tokenId);
        await txA.wait();
      }
    }

    // Encode and send explicit overload:
    // register(address,uint256,address,address,bytes32,string,uint8,bytes32,bytes32)
    const iface = new ethers.Interface([
      'function register(address,uint256,address,address,bytes32,string,uint8,bytes32,bytes32)'
    ]);
    const data = iface.encodeFunctionData('register', [
      pick.contract,
      pick.tokenId,
      ownerWallet.address,
      this.device.wallet.address,
      hash,
      uri,
      v, r, s
    ]);

    console.log(`Submitting registration transaction to the blockchain...`);

    const tx = await ownerWallet.sendTransaction({ to: registryAddress, data, value });
    await tx.wait();
    console.log('Registration confirmed. Starting drone operation...');

    this.device.startOperationFlow();
  }
}