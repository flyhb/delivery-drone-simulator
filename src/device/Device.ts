import { Wallet, ethers, Contract } from 'ethers';
import { readConfig, writeConfig } from '../config';
import { logInfo, logWarn } from '../utils/logger';
import { HUMMINGBIRD_ABI } from '../utils/abis';

/**
 * Represents the firmware running on a physical device.  It manages a
 * persistent private key, checks registration status in ioID and signs
 * permit messages for registration.  Once registered the device can
 * begin its normal operation loop.
 */
export class Device {
  public wallet: Wallet;
  private provider: ethers.JsonRpcProvider;
  private registry: Contract;

  constructor(provider: ethers.JsonRpcProvider, registry: Contract) {
    this.provider = provider;
    this.registry = registry;
    const cfg = readConfig();
    if (!cfg || !cfg.devicePrivateKey) {
      // Generate a random wallet and persist it
      const randomWallet = Wallet.createRandom();
      // Create a new Wallet instance from the generated private key.  In
      // ethers v6, Wallet.createRandom() returns an HDNodeWallet
      // subtype which is not assignable to Wallet; creating a new
      // Wallet ensures the types align.
      const generated = new Wallet(randomWallet.privateKey, provider);
      this.wallet = generated;
      writeConfig({ devicePrivateKey: randomWallet.privateKey });
      console.log(`Generated new device key and stored in configuration`);
    } else {
      this.wallet = new Wallet(cfg.devicePrivateKey, provider);
    }
  }

  /**
   * Returns the device's public address.
   */
  public address(): string {
    return this.wallet.address;
  }

  /**
   * Checks whether the device is already registered in the ioID
   * registry.  Returns true if the device exists, false otherwise.
   */
  public async isRegistered(): Promise<boolean> {
    const result: boolean = await this.registry.exists(this.wallet.address);
    return result;
  }

  /**
   * Signs an EIP‑712 permit message authorizing the given owner to
   * register this device.  The nonce is obtained from the
   * ioIDRegistry.  A random DID hash and URI are generated for
   * demonstration purposes.  Returns the signature components (v, r,
   * s) along with the DID hash and URI.
   *
   * @param ownerAddress The owner address that will register the device
   */
  public async signPermit(ownerAddress: string): Promise<{
    v: number;
    r: string;
    s: string;
    hash: string;
    uri: string;
  }> {
    // Load the current nonce for this device
    const nonce: bigint = await this.registry.nonces(this.wallet.address);
    // Build EIP‑712 domain; use registry address as verifying contract
    const domain = {
      name: 'ioIDRegistry',
      version: '1',
      chainId: (await this.provider.getNetwork()).chainId,
      verifyingContract: this.registry.target as string,
    };
    const types = {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'nonce', type: 'uint256' },
      ],
    };
    const message = {
      owner: ownerAddress,
      nonce: nonce,
    };
    // Sign the typed data with the device key
    const signature = await this.wallet.signTypedData(domain, types, message);
    const sig = ethers.Signature.from(signature);
    // Generate a pseudo‐random DID hash (32 bytes) and a URI.  In a
    // real deployment you would compute the hash from actual device
    // metadata and host the metadata JSON at the URI.
    const randomBytes = ethers.randomBytes(32);
    const didHash = ethers.keccak256(randomBytes);
    const didURI = `did:io:${ethers.hexlify(randomBytes).substring(2)}`;
    return {
      v: sig.v,
      r: sig.r,
      s: sig.s,
      hash: didHash,
      uri: didURI,
    };
  }

  /**
   * Starts a dummy operation loop.  This function logs a heartbeat
   * every few seconds to simulate continuous device activity.  In a
   * real firmware this is where sensors would be read and actuators
   * controlled.
   */
  public startOperationFlow(intervalMs: number = 60000): void {
    const hbAddr = process.env.HUMMINGBIRD;
    if (!hbAddr || !/^0x[0-9a-fA-F]{40}$/.test(hbAddr)) {
      throw new Error('HUMMINGBIRD must be set in .env (0x-address)');
    }
    const hb = new Contract(hbAddr, HUMMINGBIRD_ABI, this.wallet);

    // cache last values to decide when to send sentinels
    let lastLat: bigint | undefined;
    let lastLon: bigint | undefined;
    let lastReady: boolean | undefined;

    // choose initial demo coordinates (Boston) unless provided via env
    const envLat = process.env.INIT_LAT_E7;
    const envLon = process.env.INIT_LON_E7;
    const envReady = process.env.INIT_READY;
    let lat: bigint = envLat ? BigInt(envLat) : BigInt(Math.round(42.3601 * 1e7));
    let lon: bigint = envLon ? BigInt(envLon) : BigInt(Math.round(-71.0589 * 1e7));
    let ready: boolean = envReady === '0' ? false : true;

    const INT256_MIN = -(1n << 255n);
    const READY_UNCHANGED = -1n;

    const jitter = () => {
      // ±10 micro-degrees occasionally; mostly 0
      if (Math.random() < 0.7) return 0n;
      const delta = Math.floor(Math.random() * 21) - 10; // -10..+10
      return BigInt(delta);
    };
    const maybeFlip = (cur: boolean) => (Math.random() < 0.1 ? !cur : cur);

    const tick = async () => {
      try {
        // evolve demo values a tiny bit
        const nextLat = lat + jitter();
        const nextLon = lon + jitter();
        const nextReady = maybeFlip(ready);
        const first = (lastLat === undefined) || (lastLon === undefined) || (lastReady === undefined);

        const latArg = first ? nextLat : (nextLat === lastLat ? INT256_MIN : nextLat);
        const lonArg = first ? nextLon : (nextLon === lastLon ? INT256_MIN : nextLon);
        const readyArg = first ? (nextReady ? 1n : 0n) : (nextReady === lastReady ? READY_UNCHANGED : (nextReady ? 1n : 0n));
        const ts = BigInt(Math.floor(Date.now() / 1000));

        const tx = await hb.reportLiveness(latArg, lonArg, readyArg, ts);
        await tx.wait();

        // Log and scale latitude and longitude to 1e7 precision
        console.log(
          `${new Date(Number(ts) * 1000).toISOString()} ` +
          `[Heartbeat] lat: ${(Number(nextLat) / 1e7).toFixed(7)}, ` +
          `lon: ${(Number(nextLon) / 1e7).toFixed(7)}, ` +
          `ready: ${nextReady ? 'yes' : 'no'}, ts: ${ts}`
        );

        // persist
        lat = nextLat; lon = nextLon; ready = nextReady;
        lastLat = nextLat; lastLon = nextLon; lastReady = nextReady;
      } catch (e) {
        logWarn(`Heartbeat failed: ${(e as any)?.message ?? e}`);
      } finally {
        setTimeout(tick, intervalMs);
      }
    };

    // kick off
    logInfo(`Device ${this.address()} is now operational.`);
    void tick();
  }
}
