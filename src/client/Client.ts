import { Wallet, ethers, Contract } from 'ethers';
import readline from 'readline';
import { getProvider, getRegistry } from '../utils/blockchain';
import { Device } from '../device/Device';

/**
 * Companion application that an owner uses to register their device
 * with ioID. It coordinates with the Device to sign the permit and
 * then submits the registration transaction from the owner's wallet.
 */
export class Client {
  private provider: ethers.JsonRpcProvider;
  private registry: Contract;
  private device: Device;

  constructor() {
    this.provider = getProvider();
    this.registry = getRegistry(this.provider);
    this.device = new Device(this.provider, this.registry);
  }

  /**
   * Prompt the user for input on the command line. Returns a
   * promise that resolves to the entered string.
   */
  private async ask(prompt: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  /**
   * Run the registration flow. Checks if the device is already
   * registered and, if not, gathers the owner key, has the device sign
   * the permit and submits the register transaction to ioIDRegistry.
   * After successful registration the device starts its operation loop.
   */
  public async run(): Promise<void> {
    console.log(`Device address: ${this.device.address()}`);

    if (await this.device.isRegistered()) {
      console.log('Device is already registered. Starting operation...');
      this.device.startOperationFlow();
      return;
    }

    console.log('Device is not registered. Beginning registration flow.');

    // Retrieve or prompt for the owner private key
    let ownerKey = process.env.OWNER_PRIVATE_KEY;
    if (!ownerKey || ownerKey.trim() === '') {
      ownerKey = await this.ask('Enter owner private key (0x...): ');
    }
    const ownerWallet = new Wallet(ownerKey!, this.provider);
    console.log(`Owner address: ${ownerWallet.address}`);

    // Ask the device to sign a permit for this owner
    console.log('Signing permit message with device key...');
    const { v, r, s, hash, uri } = await this.device.signPermit(ownerWallet.address);

    // Device contract and token ID come from environment
    const deviceContract = process.env.DEVICE_CONTRACT_ADDRESS;
    if (!deviceContract) {
      throw new Error('DEVICE_CONTRACT_ADDRESS must be set in the environment');
    }
    const tokenIdStr = process.env.DEVICE_TOKEN_ID || '1';
    const tokenId = BigInt(tokenIdStr);

    // Addresses & contract instances for preflight checks
    const registryAddress = this.registry.target as string; // ethers v6: contract address
    const ERC721_ABI = [
      'function ownerOf(uint256) view returns (address)',
      'function getApproved(uint256 tokenId) view returns (address)',
      'function isApprovedForAll(address owner, address operator) view returns (bool)',
      'function approve(address to, uint256 tokenId)',
      'function setApprovalForAll(address operator, bool approved)'
    ];
    const nft = new Contract(deviceContract, ERC721_ABI, ownerWallet);

    // Optional: ioIDStore for price + project mapping (if provided)
    const IOID_STORE = process.env.IOID_STORE;
    if (!IOID_STORE) {
      console.warn('IOID_STORE is not set.');
      return;
    }
    const STORE_ABI = [
      'function price() view returns (uint256)',
      'function deviceContractProject(address) view returns (uint256)'
    ];
    const store = new Contract(IOID_STORE, STORE_ABI, this.provider);

    // ---------- PREFLIGHT: read all important on-chain state ----------
    const [{ chainId }] = await Promise.all([this.provider.getNetwork()]);

    const [
      onChainOwner,
      approvedForToken,
      approvedForAll,
      onChainPrice,
      projectId,
      deviceNonce
    ] = await Promise.all([
      nft.ownerOf(tokenId).catch(() => '0x0'),
      nft.getApproved(tokenId).catch(() => '0x0'),
      nft.isApprovedForAll(ownerWallet.address, registryAddress).catch(() => false),
      store ? store.price().catch(() => 0n) : Promise.resolve(0n),
      store ? store.deviceContractProject(deviceContract).catch(() => 0n) : Promise.resolve(0n),
      this.registry.nonces(this.device.wallet.address).catch(() => 0n),
    ]);

    console.log('--- Preflight ---');
    console.log(JSON.stringify({
      network: { chainId: chainId.toString() },
      registryAddress,
      deviceContract,
      tokenId: tokenId.toString(),
      deviceAddress: this.device.wallet.address,
      ownerAddress: ownerWallet.address,
      onChainOwner,
      approvedForToken,
      approvedForAll,
      onChainPrice: onChainPrice.toString(),
      projectId: projectId.toString(),
      deviceNonce: deviceNonce.toString(),
    }, null, 2));

    if (onChainOwner.toLowerCase() !== ownerWallet.address.toLowerCase()) {
      console.warn(`WARN: token ${tokenId} is owned by ${onChainOwner}, not ${ownerWallet.address}`);
    }
    if (store && projectId === 0n) {
      console.warn('WARN: device contract is not linked to a project (deviceContractProject == 0). Registration will revert.');
    }

    // ---------- EIP-712 signature recovery diagnostics ----------
    // Try a few domain name/version candidates to see which matches the device signature
    const nameCandidates = [
      process.env.EIP712_NAME || 'ioID',
      'ioIDRegistry',
      'ioID Registry',
    ];
    const versionCandidates = [
      process.env.EIP712_VERSION || '1',
      '1.0'
    ];

    const types = {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'nonce', type: 'uint256' }
      ]
    };
    const message = { owner: ownerWallet.address, nonce: deviceNonce };

    const recoveryTable: Array<{ name: string, version: string, recovered: string }> = [];
    for (const nm of nameCandidates) {
      for (const ver of versionCandidates) {
        try {
          const domain = { name: nm, version: ver, chainId, verifyingContract: registryAddress };
          const digest = ethers.TypedDataEncoder.hash(domain, types, message);
          const rec = ethers.recoverAddress(digest, { v, r, s });
          recoveryTable.push({ name: nm, version: ver, recovered: rec });
        } catch (e) {
          recoveryTable.push({ name: nm, version: ver, recovered: 'ERROR' });
        }
      }
    }
    console.log('--- EIP-712 recovery table ---');
    console.table(recoveryTable);

    const matches = recoveryTable.filter(x => x.recovered.toLowerCase() === this.device.wallet.address.toLowerCase());
    if (matches.length === 0) {
      console.warn('WARN: No domain candidate recovered to the device address. Registration will very likely revert due to domain mismatch.');
    } else {
      console.log('Matched domain(s):', matches);
    }

    // Ensure approval (prefer minimal per-token approval)
    if (!approvedForAll) {
      const isTokenApproved = (approvedForToken?.toLowerCase() === registryAddress.toLowerCase());
      if (!isTokenApproved) {
        console.log(`Approving registry ${registryAddress} to transfer token ${tokenId.toString()}...`);
        const approvalTx = await nft.approve(registryAddress, tokenId);
        console.log(`Approval tx: ${approvalTx.hash}`);
        await approvalTx.wait();
      }
    }

    // Determine the price to pay: prefer on-chain price, fallback to IOID_PRICE env
    const priceStrEnv = process.env.IOID_PRICE || '0';
    const value = (store && onChainPrice > 0n) ? onChainPrice : ethers.parseEther(priceStrEnv);

    // ---------- Encode both overloads ----------
    const ifaceWrapper = new ethers.Interface([
      'function register(address deviceContract,uint256 tokenId,address device,bytes32 hash,string uri,uint8 v,bytes32 r,bytes32 s)'
    ]);
    const dataWrapper = ifaceWrapper.encodeFunctionData('register', [
      deviceContract,
      tokenId,
      this.device.wallet.address,
      hash,
      uri,
      v, r, s
    ]);

    const ifaceExplicit = new ethers.Interface([
      'function register(address deviceContract,uint256 tokenId,address user,address device,bytes32 hash,string uri,uint8 v,bytes32 r,bytes32 s)'
    ]);
    const dataExplicit = ifaceExplicit.encodeFunctionData('register', [
      deviceContract,
      tokenId,
      ownerWallet.address,
      this.device.wallet.address,
      hash,
      uri,
      v, r, s
    ]);

    // ---------- Static call + estimate gas (wrapper) ----------
    console.log('--- Dry-run (wrapper overload) ---');
    let wrapperOk = false;
    try {
      const res = await this.provider.call({ to: registryAddress, from: ownerWallet.address, data: dataWrapper, value });
      console.log('static call (wrapper) ok:', res);
      wrapperOk = true;
    } catch (e: any) {
      console.log('static call (wrapper) revert:', e?.info || e?.error || e?.message || e);
    }
    try {
      const gas = await this.provider.estimateGas({ to: registryAddress, from: ownerWallet.address, data: dataWrapper, value });
      console.log('estimateGas (wrapper):', gas.toString());
    } catch (e: any) {
      console.log('estimateGas (wrapper) revert:', e?.info || e?.error || e?.message || e);
    }

    // ---------- Static call + estimate gas (explicit) ----------
    console.log('--- Dry-run (explicit overload) ---');
    let explicitOk = false;
    try {
      const res = await this.provider.call({ to: registryAddress, from: ownerWallet.address, data: dataExplicit, value });
      console.log('static call (explicit) ok:', res);
      explicitOk = true;
    } catch (e: any) {
      console.log('static call (explicit) revert:', e?.info || e?.error || e?.message || e);
    }
    try {
      const gas = await this.provider.estimateGas({ to: registryAddress, from: ownerWallet.address, data: dataExplicit, value });
      console.log('estimateGas (explicit):', gas.toString());
    } catch (e: any) {
      console.log('estimateGas (explicit) revert:', e?.info || e?.error || e?.message || e);
    }

    // ---------- Choose which overload to actually send ----------
    let dataToSend: string | null = null;
    if (wrapperOk) dataToSend = dataWrapper;
    else if (explicitOk) dataToSend = dataExplicit;

    if (!dataToSend) {
      console.error('Both overloads reverted in static call. See diagnostics above (domain, approvals, project link, price). Aborting.');
      return;
    }

    console.log('Submitting registration transaction...');
    const tx = await ownerWallet.sendTransaction({
      to: registryAddress,
      data: dataToSend,
      value
    });

    console.log(`Submitted registration transaction: ${tx.hash}`);
    await tx.wait();
    console.log('Registration confirmed on chain.');

    this.device.startOperationFlow();
  }
}
