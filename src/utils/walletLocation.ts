// Generates a deterministic location for a wallet address
// within a 10 km radius around downtown Boston.

import { createHash } from "crypto";

// Downtown Boston center
const centerLat = 42.3601;
const centerLon = -71.0589;

// ~10 km radius around downtown
const radiusKm = 10;

// Deterministic seeded random generator → [0, 1)
function seededRandom(seed: string): number {
  const hash = createHash("sha256").update(seed).digest("hex");
  const intSeed = parseInt(hash.slice(0, 8), 16);
  return intSeed / 0xffffffff;
}

/**
 * Generate a deterministic lat/lon for a wallet address,
 * clustered within ~10km of downtown Boston.
 */
export function getWalletLocation(walletAddress: string) {
  // Two independent seeds: one for angle, one for distance
  const r1 = seededRandom(walletAddress);
  const r2 = seededRandom(walletAddress + "lon");

  // Convert radius in km to degrees (~111 km per degree latitude)
  const radiusDeg = radiusKm / 111;

  // Random angle (0–2π)
  const angle = r1 * 2 * Math.PI;

  // Random distance (square root for uniform disk distribution)
  const distance = Math.sqrt(r2) * radiusDeg;

  // Offset in lat/lon
  const latOffset = distance * Math.cos(angle);
  const lonOffset =
    distance * Math.sin(angle) / Math.cos(centerLat * Math.PI / 180);

  const lat = BigInt(Math.round((centerLat + latOffset) * 1e7));
  const lon = BigInt(Math.round((centerLon + lonOffset) * 1e7));

  return { lat, lon };
}
