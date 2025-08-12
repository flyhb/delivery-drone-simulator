import { Wallet, ethers, Contract } from 'ethers';
import readline from 'readline';
import { getProvider, getRegistry } from '../utils/blockchain';
import { Device } from '../device/Device';
import {
  discoverOwnedChoicesFromStore,
  readPriceWei
} from './storeDiscovery';

export class Client {
  private provider: ethers.JsonRpcProvider;
  private registry: Contract;
  private device: Device;

  constructor() {
    this.provider = getProvider();
    this.registry = getRegistry(this.provider);
    this.device = new Device(this.provider, this.registry);
  }

  private async ask(prompt: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(prompt, (a) => { rl.close(); resolve(a.trim()); }));
  }

  public async run(): Promise<void> {
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

    console.log('\nYour Device NFTs:');
    choices.forEach((c, idx) => {
      const name = c.projectName ? ` — ${c.projectName}` : '';
      console.log(`[${idx + 1}] ${c.contract}  #${c.tokenId.toString()}  (project ${c.projectId.toString()}${name})`);
    });

    let idx = -1;
    while (idx < 0 || idx >= choices.length) {
      const ans = await this.ask('Select NFT to register (number): ');
      const n = Number(ans);
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) idx = n - 1;
    }
    const pick = choices[idx];

    // Device signs permit for this owner
    const { v, r, s, hash, uri } = await this.device.signPermit(ownerWallet.address);

    // Resolve price (prefer on-chain store; fallback to IOID_PRICE env)
    let value = await readPriceWei(this.provider, IOID_STORE);
    if (value === 0n) value = ethers.parseEther(process.env.IOID_PRICE || '0');

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
      } catch { /* some ERC721s may lack getApproved */ }
      if (!tokenApproved) {
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

    const tx = await ownerWallet.sendTransaction({ to: registryAddress, data, value });
    console.log(`Submitted registration: ${tx.hash}`);
    await tx.wait();
    console.log('Registration confirmed. Starting operation...');

    this.device.startOperationFlow();
  }
}