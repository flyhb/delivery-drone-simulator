import { Wallet, ethers, Contract } from 'ethers';
import readline from 'readline';
import { getProvider, getRegistry } from '../utils/blockchain';
import { logInfo } from '../utils/logger';
import { Device } from '../device/Device';
import {
  discoverOwnedChoicesFromStore,
  readPriceWei
} from './deviceNFTDiscovery';
import { promptSelect } from '../utils/ui';

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

    logInfo('Device boot sequence initiated.');
    // Log the device configuration
    const cfg = this.device.getConfig();
    logInfo(`Device configuration: ${JSON.stringify(cfg, null, 2)}`);

    if (await this.device.isRegistered()) {
      logInfo('Registration status: registered');
      const hbMs = Number(process.env.HEARTBEAT_MS || 60000);
      const hbAddr = process.env.HUMMINGBIRD || '(unset)';
      logInfo(`Operational mode enabled.`);
      logInfo(`Heartbeat interval set to ${hbMs}ms.`);
      logInfo(`sending liveness proofs to ${hbAddr}`);
      this.device.startOperationFlow(hbMs);
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
    // Use interactive arrow menu if available.  Fallback to numeric prompt if
    // the terminal does not support raw mode.  Each option displays the
    // contract, tokenId and project name.
    const optionStrings = choices.map((c) => {
      const name = c.projectName ? ` — ${c.projectName}` : '';
      return `${c.contract}  #${c.tokenId.toString()}  (project ${c.projectId.toString()}${name})`;
    });
    let selected = -1;
    try {
      selected = await promptSelect('Select NFT to register:', optionStrings);
    } catch (err) {
      // If interactive selection fails, fall back to numeric prompt
      let idxNum = -1;
      while (idxNum < 0 || idxNum >= choices.length) {
        const ans = await this.ask('Select NFT to register (number): ');
        const n = Number(ans);
        if (Number.isInteger(n) && n >= 1 && n <= choices.length) idxNum = n - 1;
      }
      selected = idxNum;
    }
    const pick = choices[selected];

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

    const hbMs = Number(process.env.HEARTBEAT_MS || 60000);
      const hbAddr = process.env.HUMMINGBIRD || '(unset)';
      logInfo(`Operational mode enabled.`);
      logInfo(`Heartbeat interval set to ${hbMs}ms; sending liveness proofs to ${hbAddr}`);
      this.device.startOperationFlow(hbMs);
  }
}