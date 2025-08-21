import { logInfo } from '../utils/logger';

/**
 * A simple navigator class that interpolates movement between two
 * geographic coordinates.  Locations are stored and updated in the
 * E7 fixed‐point format (degrees ×1e7).  The navigator advances
 * along a straight line between the current and target positions in
 * small increments and sleeps between updates to simulate travel
 * time.  The speed (in miles per hour) and the callback used to
 * publish location updates are provided at construction time.
 */
export class Navigator {
  private currentLatE7: number;
  private currentLonE7: number;
  private readonly speedMph: number;
  private readonly onUpdate: (lat: bigint, lon: bigint) => void;

  /**
   * Creates a new navigator instance.  The initial latitude and
   * longitude define the starting point for subsequent movement.
   * @param initialLat The starting latitude in E7 (bigint).
   * @param initialLon The starting longitude in E7 (bigint).
   * @param speedMph The travel speed in miles per hour.  Must be > 0.
   * @param onUpdate A callback invoked after each incremental
   * movement with the new latitude and longitude (as bigints).
   */
  constructor(
    initialLat: bigint,
    initialLon: bigint,
    speedMph: number,
    onUpdate: (lat: bigint, lon: bigint) => void
  ) {
    this.currentLatE7 = Number(initialLat);
    this.currentLonE7 = Number(initialLon);
    this.speedMph = speedMph > 0 ? speedMph : 1;
    this.onUpdate = onUpdate;
  }

  /**
   * Convert a pair of E7 coordinates into a great‑circle distance in
   * kilometres using the haversine formula.  Accepts number inputs
   * because all internal state is stored as numbers to simplify
   * arithmetic with fractional steps.
   */
  private distanceKm(latE7a: number, lonE7a: number, latE7b: number, lonE7b: number): number {
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const lat1 = latE7a / 1e7;
    const lon1 = lonE7a / 1e7;
    const lat2 = latE7b / 1e7;
    const lon2 = lonE7b / 1e7;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return 6371 * c;
  }

  /**
   * Move gradually from the current position to the specified
   * destination.  The path is divided into small segments of roughly
   * `stepMiles` miles (default 0.1 mile).  After each segment the
   * update callback is invoked and the function sleeps for a
   * duration derived from the configured speed.  The promise
   * resolves once the destination has been reached.
   *
   * @param targetLat The target latitude in E7 (bigint)
   * @param targetLon The target longitude in E7 (bigint)
   * @param stepMiles Approximate distance per update in miles
   */
  public async moveTo(targetLat: bigint, targetLon: bigint, stepMiles = 0.01): Promise<void> {
    const targetLatNum = Number(targetLat);
    const targetLonNum = Number(targetLon);
    // Compute total distance in miles
    const totalKm = this.distanceKm(this.currentLatE7, this.currentLonE7, targetLatNum, targetLonNum);
    const totalMiles = totalKm * 0.621371;
    // If already at destination or distance zero, just update and return
    if (totalMiles === 0) {
      this.currentLatE7 = targetLatNum;
      this.currentLonE7 = targetLonNum;
      this.onUpdate(BigInt(Math.round(this.currentLatE7)), BigInt(Math.round(this.currentLonE7)));
      return;
    }
    // Determine number of steps required to approximate the path.  We
    // always take at least one step to guarantee the update callback
    // fires with the final destination.
    const steps = Math.max(1, Math.ceil(totalMiles / stepMiles));
    const deltaLat = targetLatNum - this.currentLatE7;
    const deltaLon = targetLonNum - this.currentLonE7;
    const stepLat = deltaLat / steps;
    const stepLon = deltaLon / steps;
    // The actual step distance is used to compute time per step.
    const actualStepMiles = totalMiles / steps;
    const stepDurationMs = (actualStepMiles / this.speedMph) * 3600 * 1000;
    for (let i = 1; i <= steps; i++) {
      this.currentLatE7 += stepLat;
      this.currentLonE7 += stepLon;
      const latRound = Math.round(this.currentLatE7);
      const lonRound = Math.round(this.currentLonE7);
      this.onUpdate(BigInt(latRound), BigInt(lonRound));
      // Sleep for the computed duration.  A minimum delay of 0
      // ensures that awaiting a zero stepDurationMs yields a
      // microtask and not a tight loop.
      const delay = stepDurationMs > 0 ? stepDurationMs : 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}