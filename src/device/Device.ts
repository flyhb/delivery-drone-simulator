import { Wallet, ethers, Contract } from 'ethers';
import https from 'https';
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

      // Attempt to determine and persist a home location based on the host IP
      try {
        const geoPromise = new Promise<{ lat: string; lon: string }>((resolve, reject) => {
          const req = https.get('https://ipinfo.io/json', (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              try {
                const json = JSON.parse(data);
                if (json && json.loc && typeof json.loc === 'string') {
                  const parts = json.loc.split(',');
                  if (parts.length === 2) {
                    resolve({ lat: parts[0], lon: parts[1] });
                    return;
                  }
                }
                reject(new Error('invalid geolocation response'));
              } catch (err) {
                reject(err);
              }
            });
          });
          req.on('error', (err) => reject(err));
        });
        geoPromise
          .then(({ lat, lon }) => {
            const latNum = parseFloat(lat);
            const lonNum = parseFloat(lon);
            if (!isNaN(latNum) && !isNaN(lonNum)) {
              const cfg2 = readConfig();
              if (cfg2) {
                cfg2.homeLatE7 = String(Math.round(latNum * 1e7));
                cfg2.homeLonE7 = String(Math.round(lonNum * 1e7));
                writeConfig(cfg2);
              }
              console.log(`Determined and stored home location via IP geolocation: lat ${latNum.toFixed(6)}, lon ${lonNum.toFixed(6)}`);
            }
          })
          .catch((err) => {
            console.warn(`Geolocation fetch failed: ${err?.message ?? err}`);
          });
      } catch {
        // ignore geolocation errors silently
      }
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
  public async startOperationFlow(intervalMs: number = 60000): Promise<void> {
    const hbAddr = process.env.HUMMINGBIRD;
    if (!hbAddr || !/^0x[0-9a-fA-F]{40}$/.test(hbAddr)) {
      throw new Error('HUMMINGBIRD must be set in .env (0x-address)');
    }
    const hb = new Contract(hbAddr, HUMMINGBIRD_ABI, this.wallet);

    // cache last values to decide when to send sentinels
    let lastLat: bigint | undefined;
    let lastLon: bigint | undefined;
    let lastReady: boolean | undefined;

    // determine home coordinates.  We prefer values in the device
    // configuration, falling back to environment variables.  If
    // neither are present (first run) we attempt to fetch the host
    // geolocation based on its IP address using ipinfo.io.  Fetched
    // coordinates are stored back into the configuration for future
    // runs.  Ready is initially true.
    let cfg = readConfig();
    let initLatStr: string | undefined = cfg?.homeLatE7;
    let initLonStr: string | undefined = cfg?.homeLonE7;
    if (!initLatStr || !initLonStr) {
      // fallback to environment variables if provided
      initLatStr = process.env.HOME_LAT_E7 ?? process.env.INIT_LAT_E7;
      initLonStr = process.env.HOME_LON_E7 ?? process.env.INIT_LON_E7;
    }
    // If still undefined, attempt to fetch geolocation from ipinfo.io
    if (!initLatStr || !initLonStr) {
      try {
        const geoData = await new Promise<{ lat: string; lon: string }>((resolve, reject) => {
          const req = https.get('https://ipinfo.io/json', (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              try {
                const json = JSON.parse(data);
                if (json && json.loc && typeof json.loc === 'string') {
                  const parts = json.loc.split(',');
                  if (parts.length === 2) {
                    resolve({ lat: parts[0], lon: parts[1] });
                    return;
                  }
                }
                reject(new Error('invalid geolocation response'));
              } catch (err) {
                reject(err);
              }
            });
          });
          req.on('error', (err) => reject(err));
        });
        const latNum = parseFloat(geoData.lat);
        const lonNum = parseFloat(geoData.lon);
        if (!isNaN(latNum) && !isNaN(lonNum)) {
          initLatStr = String(Math.round(latNum * 1e7));
          initLonStr = String(Math.round(lonNum * 1e7));
          // update config on success
          if (cfg) {
            cfg.homeLatE7 = initLatStr;
            cfg.homeLonE7 = initLonStr;
            writeConfig(cfg);
          }
          logInfo(
            `Determined home location via IP geolocation: lat ${latNum.toFixed(6)}, lon ${lonNum.toFixed(6)}`
          );
        }
      } catch (geoErr) {
        logWarn(`Failed to determine home location via IP geolocation: ${(geoErr as any).message ?? geoErr}`);
      }
    }
    // If still not defined, fall back to Boston (default)
    let lat: bigint;
    let lon: bigint;
    if (initLatStr && initLonStr) {
      lat = BigInt(initLatStr);
      lon = BigInt(initLonStr);
    } else {
      lat = BigInt(Math.round(42.3601 * 1e7));
      lon = BigInt(Math.round(-71.0589 * 1e7));
    }
    // ready state
    let ready: boolean = true;
    // Log the selected home location and initial status.  When the
    // device boots the drone is idle at its home coordinates.  This
    // message appears once on startup so operators can verify the
    // configured home location.
    logInfo(
      `Home location set to lat: ${(
        Number(lat) / 1e7
      ).toFixed(7)}, lon: ${(
        Number(lon) / 1e7
      ).toFixed(7)} (degrees); status: idle`
    );

    // Save the home coordinates for returning after a delivery
    const homeLat: bigint = lat;
    const homeLon: bigint = lon;
    // Track the drone's current status: 'idle' (at home), 'toPickup', 'toDropoff', 'returning'
    let droneStatus: string = 'idle';

    // Track the most recent latitude/longitude for computing delivery
    // distances.  These variables mirror the drone's current
    // location and are updated whenever the drone moves (e.g. when
    // starting, progressing through or completing a delivery).
    let currentLat: bigint = lat;
    let currentLon: bigint = lon;

    // A set of request IDs that this drone has already proposed on.
    // Prevents duplicate proposals.
    const proposedRequests = new Set<string>();

    // Map of requestId (string) to pickup/drop coordinates.  Used to
    // update the drone's position when a proposal is accepted.
    const requestInfo: Record<string, { pickupLat: bigint; pickupLon: bigint; dropLat: bigint; dropLon: bigint }> = {};

    // Flag used to disable delivery polling if the contract does not
    // support the delivery request interface.  Once set to true the
    // poller will no longer attempt to query the contract for
    // delivery requests.  Without this guard the simulator would
    // repeatedly call a non‑existent function and produce
    // CALL_EXCEPTION errors.
    let deliveryUnsupported = false;

    // Constants used for distance calculation.  R is the mean earth
    // radius in kilometres.  We update the trip distance using the
    // haversine formula.
    const EARTH_RADIUS_KM = 6371;

    /**
     * Compute the great‑circle distance between two points on Earth
     * using the haversine formula.  Coordinates are provided in
     * degrees ×1e7.  Returns the distance in kilometres as a
     * JavaScript number.  Note: conversions from bigint to number
     * could lose precision for extremely large values, however the
     * scaled GPS values (~1e7) are well within the safe range.
     */
    const distanceBetween = (latE7: bigint, lonE7: bigint, lat2E7: bigint, lon2E7: bigint): number => {
      const toRad = (deg: number) => (deg * Math.PI) / 180;
      const lat1 = Number(latE7) / 1e7;
      const lon1 = Number(lonE7) / 1e7;
      const lat2 = Number(lat2E7) / 1e7;
      const lon2 = Number(lon2E7) / 1e7;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return EARTH_RADIUS_KM * c;
    };

    /**
     * Compute the total trip distance from the drone's current
     * location to the pickup point, then to the drop‑off point and
     * finally back to the starting location.  Coordinates are
     * provided as bigints ×1e7.  Returns a number representing the
     * total distance in kilometres.
     */
    const computeTripDistance = (startLat: bigint, startLon: bigint, pickupLat: bigint, pickupLon: bigint, dropLat: bigint, dropLon: bigint): number => {
      const d1 = distanceBetween(startLat, startLon, pickupLat, pickupLon);
      const d2 = distanceBetween(pickupLat, pickupLon, dropLat, dropLon);
      const d3 = distanceBetween(dropLat, dropLon, startLat, startLon);
      return d1 + d2 + d3;
    };

    /**
     * Poll the status of all proposed deliveries.  This function
     * iterates through every request ID that this drone has proposed
     * and queries the contract for its current status.  If a request
     * has been accepted (status == 2) and assigned to this drone the
     * drone initiates the delivery sequence by calling
     * handleAcceptedDelivery.  Proposals that are cancelled or
     * otherwise no longer in the Proposed or Accepted states are
     * removed from the tracking set.  After each iteration the
     * function reschedules itself to run again after a fixed delay.
     */
    const pollProposalStatus = async () => {
      try {
        const myLower = this.wallet.address.toLowerCase();
        const ids = Array.from(proposedRequests);
        for (const idStr of ids) {
          try {
            const reqId = BigInt(idStr);
            // Retrieve request details
            let req: any;
            try {
              if (typeof (hb as any).getRequest === 'function') {
                req = await (hb as any).getRequest(reqId);
              } else {
                continue;
              }
            } catch (e) {
              logWarn(`Failed to fetch request ${idStr}: ${(e as any)?.message ?? e}`);
              continue;
            }
            if (!req) continue;
            // Extract status and drone address
            const status: any = req.status !== undefined ? req.status : req[9];
            // 2 corresponds to Status.Accepted in the enum
            if (Number(status) === 2) {
              const droneAddr: any = req.drone !== undefined ? req.drone : req[8];
              const droneLower = String(droneAddr).toLowerCase();
              if (droneLower === myLower) {
                // Remove from proposed set before starting to avoid
                // duplicate handling
                proposedRequests.delete(idStr);
                // Kick off delivery handling
                await handleAcceptedDelivery(reqId);
              }
            } else if (Number(status) !== 1) {
              // If no longer Proposed (status 1), remove from tracking
              proposedRequests.delete(idStr);
            }
          } catch (inner) {
            logWarn(`Proposal status check failed for ${idStr}: ${(inner as any)?.message ?? inner}`);
          }
        }
      } catch (err) {
        logWarn(`Proposal status polling error: ${(err as any)?.message ?? err}`);
      } finally {
        // schedule next status poll in 30 seconds
        setTimeout(pollProposalStatus, 30000);
      }
    };

    /**
     * Handle an accepted delivery by progressing through the
     * startDelivery → packagePicked → packageDropped → completeDelivery
     * sequence.  The drone's location and readiness are updated
     * throughout the process: moving to the pickup location, then the
     * drop‑off location and finally back to home.  Status
     * information is updated accordingly and logged via logInfo.
     * Delays between calls are kept short for simulation purposes.
     */
    const handleAcceptedDelivery = async (requestId: bigint) => {
      const idStr = requestId.toString();
      // Retrieve stored pickup/drop coordinates if available
      let info = requestInfo[idStr];
      if (!info) {
        // fallback: fetch from contract if not in map
        try {
          const req = await (hb as any).getRequest(requestId);
          if (req) {
            const pLat = req.pickupLatE7 ?? req.pickupLat ?? req[2];
            const pLon = req.pickupLonE7 ?? req.pickupLon ?? req[3];
            const dLat = req.dropLatE7 ?? req.dropLat ?? req[4];
            const dLon = req.dropLonE7 ?? req.dropLon ?? req[5];
            if (pLat !== undefined && pLon !== undefined && dLat !== undefined && dLon !== undefined) {
              info = {
                pickupLat: BigInt(pLat),
                pickupLon: BigInt(pLon),
                dropLat: BigInt(dLat),
                dropLon: BigInt(dLon),
              };
              requestInfo[idStr] = info;
            }
          }
        } catch {}
      }
      if (!info) {
        logWarn(`Missing location info for request ${idStr}`);
      }
      try {
        // Step 1: start delivery – move to pickup
        ready = false;
        droneStatus = 'toPickup';
        if (info) {
          lat = info.pickupLat;
          lon = info.pickupLon;
          currentLat = lat;
          currentLon = lon;
          // Log status and new location when heading to pickup
          logInfo(
            `Drone ${this.address()} heading to pickup; lat: ${(
              Number(lat) /
              1e7
            ).toFixed(7)}, lon: ${(
              Number(lon) /
              1e7
            ).toFixed(7)}, status: ${droneStatus}`
          );
        }
        if (typeof (hb as any).startDelivery === 'function') {
          const tx = await (hb as any).startDelivery(requestId);
          await tx.wait?.();
          logInfo(`Started delivery ${idStr}`);
        }
      } catch (err) {
        logWarn(`startDelivery failed for ${idStr}: ${(err as any)?.message ?? err}`);
      }
      // Step 2: package picked
      setTimeout(async () => {
        try {
          droneStatus = 'toDropoff';
          // Log status at pickup
          logInfo(
            `Drone ${this.address()} picked up package; lat: ${(
              Number(lat) /
              1e7
            ).toFixed(7)}, lon: ${(
              Number(lon) /
              1e7
            ).toFixed(7)}, status: ${droneStatus}`
          );
          if (typeof (hb as any).packagePicked === 'function') {
            const tx = await (hb as any).packagePicked(requestId);
            await tx.wait?.();
            logInfo(`Package picked for ${idStr}`);
          }
        } catch (err) {
          logWarn(`packagePicked failed for ${idStr}: ${(err as any)?.message ?? err}`);
        }
        // Step 3: package dropped
        setTimeout(async () => {
          try {
            if (info) {
              lat = info.dropLat;
              lon = info.dropLon;
              currentLat = lat;
              currentLon = lon;
            }
            droneStatus = 'returning';
            // Log status at dropoff
            logInfo(
              `Drone ${this.address()} dropped off package; lat: ${(
                Number(lat) /
                1e7
              ).toFixed(7)}, lon: ${(
                Number(lon) /
                1e7
              ).toFixed(7)}, status: ${droneStatus}`
            );
            if (typeof (hb as any).packageDropped === 'function') {
              const tx = await (hb as any).packageDropped(requestId);
              await tx.wait?.();
              logInfo(`Package dropped for ${idStr}`);
            }
          } catch (err) {
            logWarn(`packageDropped failed for ${idStr}: ${(err as any)?.message ?? err}`);
          }
          // Step 4: complete delivery and return home
          setTimeout(async () => {
            try {
              // move back home
              lat = homeLat;
              lon = homeLon;
              currentLat = lat;
              currentLon = lon;
              ready = true;
              droneStatus = 'idle';
              // Log status upon returning home
              logInfo(
                `Drone ${this.address()} returned home; lat: ${(
                  Number(lat) /
                  1e7
                ).toFixed(7)}, lon: ${(
                  Number(lon) /
                  1e7
                ).toFixed(7)}, status: ${droneStatus}`
              );
              if (typeof (hb as any).completeDelivery === 'function') {
                const tx = await (hb as any).completeDelivery(requestId);
                await tx.wait?.();
                logInfo(`Completed delivery ${idStr}`);
              }
            } catch (err) {
              logWarn(`completeDelivery failed for ${idStr}: ${(err as any)?.message ?? err}`);
            }
          }, 5000);
        }, 5000);
      }, 5000);
    };

    /**
     * Poll the Hummingbird contract for open delivery requests.  If the
     * contract does not support the expected query function this
     * polling loop silently aborts.  When open requests are found the
     * drone evaluates whether it can complete the trip (≤6 km round
     * trip).  If the request is targeted, the drone ignores it
     * unless the target matches its own address.  Expired
     * requests are ignored.  For eligible requests the drone
     * calculates a price of 0.1 HB per kilometre (with 18 decimals)
     * and proposes itself as the delivery agent.  All contract
     * interactions are wrapped in try/catch to prevent the polling
     * loop from crashing on failed transactions or missing
     * functions.  After completing an iteration the function
     * schedules itself to run again after a fixed interval.
     */
    const pollDeliveryRequests = async () => {
      try {
        // If delivery polling has been disabled due to a previous
        // unsupported call then bail early.  This flag is retained
        // from the original implementation for resiliency; however
        // current deployments include the full delivery interface so
        // it should never be set.
        if (deliveryUnsupported) {
          return;
        }
        const nowSec = Math.floor(Date.now() / 1000);
        const myAddr = this.wallet.address.toLowerCase();
        // Gather identifiers of open delivery requests.  Query both
        // globally open requests and requests targeted to this device.
        let openIds: any[] = [];
        try {
          if (typeof (hb as any).getOpenRequests === 'function') {
            const ids = await (hb as any).getOpenRequests();
            if (Array.isArray(ids)) {
              openIds = openIds.concat(ids);
            }
          }
        } catch (e) {
          logWarn(`Failed to fetch open requests: ${(e as any)?.message ?? e}`);
          // If the call reverts or fails, disable delivery polling to avoid spamming
          if (!deliveryUnsupported) {
            deliveryUnsupported = true;
            logWarn('Delivery request functions appear unsupported; disabling delivery polling.');
          }
        }
        try {
          if (typeof (hb as any).getOpenRequestsFor === 'function') {
            const ids = await (hb as any).getOpenRequestsFor(this.wallet.address);
            if (Array.isArray(ids)) {
              openIds = openIds.concat(ids);
            }
          }
        } catch (e) {
          logWarn(`Failed to fetch targeted requests: ${(e as any)?.message ?? e}`);
          if (!deliveryUnsupported) {
            deliveryUnsupported = true;
            logWarn('Delivery request functions appear unsupported; disabling delivery polling.');
          }
        }
        // De‑duplicate IDs.  Convert each identifier to a string to
        // normalise bigint and number values.
        const uniqueIds = new Set<string>();
        for (const id of openIds) {
          const key = typeof id === 'bigint' ? id.toString() : String(id);
          uniqueIds.add(key);
        }

        // Log the status of each open request found on‑chain.  This
        // allows operators to observe the current state (Open,
        // Proposed, etc.) of each request without subscribing to
        // events.  We map the numeric Status enum values defined in
        // Hummingbird.sol to human‑readable names.  Unknown values
        // fall back to the numeric representation.
        const statusNames = [
          'Open',
          'Proposed',
          'Accepted',
          'Started',
          'PickedUp',
          'Dropped',
          'Completed',
          'Cancelled',
        ];
        for (const idStr of uniqueIds) {
          try {
            const reqId = BigInt(idStr);
            let req: any;
            if (typeof (hb as any).getRequest === 'function') {
              try {
                req = await (hb as any).getRequest(reqId);
              } catch {
                continue;
              }
            }
            if (!req) continue;
            const statusVal: any = req.status !== undefined ? req.status : req[9];
            const statusNum = Number(statusVal);
            const statusName = statusNames[statusNum] ?? String(statusNum);
            logInfo(`Onchain request ${idStr}: status ${statusName}`);
          } catch {}
        }
        // Iterate through each unique request ID
        for (const idStr of uniqueIds) {
          try {
            // Skip requests we have already proposed
            if (proposedRequests.has(idStr)) {
              continue;
            }
            const reqId = BigInt(idStr);
            // Retrieve full request details
            let req: any;
            try {
              if (typeof (hb as any).getRequest === 'function') {
                req = await (hb as any).getRequest(reqId);
              } else {
                // Without getRequest we cannot proceed
                continue;
              }
            } catch (e) {
              logWarn(`Failed to fetch request ${idStr}: ${(e as any)?.message ?? e}`);
              continue;
            }
            if (!req) {
              continue;
            }
            // Extract fields from the struct.  Use named properties if
            // present, otherwise fall back to numeric indices.
            const pickupLatE7 = req.pickupLatE7 ?? req.pickupLat ?? req[2];
            const pickupLonE7 = req.pickupLonE7 ?? req.pickupLon ?? req[3];
            const dropLatE7 = req.dropLatE7 ?? req.dropLat ?? req[4];
            const dropLonE7 = req.dropLonE7 ?? req.dropLon ?? req[5];
            // The request tuple indices follow the order defined in
            // Hummingbird.DeliveryRequest.  Index 12 = targetedDevice,
            // 13 = expiresAt, 14 = maxPrice, 15 = acceptedAt.
            const targeted = req.targetedDevice ?? req.target ?? req[12];
            const expiresAtVal = req.expiresAt ?? req.expiry ?? req[13];
            const maxPrice = req.maxPrice ?? req[14];
            if (pickupLatE7 === undefined || pickupLonE7 === undefined || dropLatE7 === undefined || dropLonE7 === undefined) {
              continue;
            }
            // Determine if the request is targeted and still exclusive
            let isTargeted = false;
            let targetAddr = '0x0000000000000000000000000000000000000000';
            if (targeted) {
              targetAddr = String(targeted).toLowerCase();
              if (targetAddr !== '0x0000000000000000000000000000000000000000') {
                isTargeted = true;
              }
            }
            let expiryNum = 0;
            if (expiresAtVal !== undefined) {
              if (typeof expiresAtVal === 'bigint') {
                expiryNum = Number(expiresAtVal);
              } else {
                expiryNum = parseInt(String(expiresAtVal), 10);
              }
            }
            if (isTargeted && expiryNum > nowSec && targetAddr !== myAddr) {
              // Targeted to a different device and still within expiry
              continue;
            }
            // Compute trip distance
            let pickupLatBn: bigint;
            let pickupLonBn: bigint;
            let dropLatBn: bigint;
            let dropLonBn: bigint;
            try {
              pickupLatBn = BigInt(pickupLatE7);
              pickupLonBn = BigInt(pickupLonE7);
              dropLatBn = BigInt(dropLatE7);
              dropLonBn = BigInt(dropLonE7);
            } catch {
              continue;
            }
            const tripDist = computeTripDistance(currentLat, currentLon, pickupLatBn, pickupLonBn, dropLatBn, dropLonBn);
            if (tripDist > 6) {
              continue;
            }
            // Price: 0.1 HB per km, scaled to 18 decimal wei
            const priceFloat = tripDist * 0.1;
            const priceWei = BigInt(Math.round(priceFloat * 1e18));
            // Compare against maxPrice if provided
            let maxPriceBn: bigint;
            try {
              maxPriceBn = BigInt(maxPrice);
            } catch {
              maxPriceBn = 0n;
            }
            if (maxPriceBn > 0n && priceWei > maxPriceBn) {
              continue;
            }
            // Propose the delivery
            try {
              if (typeof (hb as any).proposeDelivery === 'function') {
                const tx = await (hb as any).proposeDelivery(reqId, priceWei);
                await (tx === null || tx === void 0 ? void 0 : tx.wait)();
                logInfo(`Proposed delivery ${idStr} @ ${priceWei.toString()} wei`);
                proposedRequests.add(idStr);
              }
            } catch (err) {
              logWarn(`Failed to propose delivery ${idStr}: ${((err as any)?.message ?? err)}`);
            }
          } catch (innerErr) {
            logWarn(`Error processing request ${idStr}: ${((innerErr as any)?.message ?? innerErr)}`);
          }
        }
      } catch (pollErr) {
        logWarn(`Delivery polling error: ${(pollErr as any)?.message ?? pollErr}`);
      } finally {
        // schedule next poll in 30 seconds
        setTimeout(pollDeliveryRequests, 30000);
      }
    };

    // Start polling for delivery requests and proposal statuses.  We
    // schedule the initial calls using zero‑delay timeouts so that
    // initialization of the operation flow does not block the main
    // thread.  Delivery requests polling finds open requests and
    // proposes deliveries, while proposal status polling watches
    // previously proposed requests to see when they are accepted.
    setTimeout(() => {
      void pollDeliveryRequests();
    }, 0);
    setTimeout(() => {
      void pollProposalStatus();
    }, 0);

    const INT256_MIN = -(1n << 255n);
    const READY_UNCHANGED = -1n;

    /**
     * Heartbeat loop.  This implementation removes the random
     * latitude/longitude jitter and random readiness toggling from
     * earlier versions.  Instead, the drone reports its current
     * position (lat/lon) and readiness exactly as stored in state.
     * When the position or readiness does not change, the
     * corresponding argument is set to INT256_MIN (for lat/lon) or
     * READY_UNCHANGED (for ready) to indicate no update as per the
     * contract API.  This loop runs continuously at the provided
     * interval and logs the current status.
     */
    const tick = async () => {
      try {
        // Determine arguments for reportLiveness based on whether values
        // have changed since the last heartbeat.  We use currentLat and
        // currentLon rather than applying any jitter.  Ready is only
        // updated when deliveries start or finish.
        const nextLat = lat;
        const nextLon = lon;
        const nextReady = ready;
        const first = (lastLat === undefined) || (lastLon === undefined) || (lastReady === undefined);
        const latArg = first ? nextLat : (nextLat === lastLat ? INT256_MIN : nextLat);
        const lonArg = first ? nextLon : (nextLon === lastLon ? INT256_MIN : nextLon);
        const readyArg = first ? (nextReady ? 1n : 0n) : (nextReady === lastReady ? READY_UNCHANGED : (nextReady ? 1n : 0n));
        const ts = BigInt(Math.floor(Date.now() / 1000));

        const tx = await hb.reportLiveness(latArg, lonArg, readyArg, ts);
        await tx.wait?.();

        // Log the heartbeat with human‑readable coordinates and current status.  We
        // include the droneStatus so operators can observe whether the
        // drone is idle, travelling to a pickup, delivering, or returning.
        console.log(
          `${new Date(Number(ts) * 1000).toISOString()} ` +
          `[Heartbeat] lat: ${(Number(nextLat) / 1e7).toFixed(7)}, ` +
          `lon: ${(Number(nextLon) / 1e7).toFixed(7)}, ` +
          `ready: ${nextReady ? 'yes' : 'no'}, status: ${droneStatus}, ts: ${ts}`
        );

        // Persist last reported values
        lastLat = nextLat;
        lastLon = nextLon;
        lastReady = nextReady;
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
