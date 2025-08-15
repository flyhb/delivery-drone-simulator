import fs from 'fs';
import path from 'path';

/**
 * Configuration handling for the simulated device.  By default the
 * configuration file is named `device-config.json` and lives in the
 * directory where the process is started.  You can override the
 * location via the CONFIG_PATH environment variable.
 */

export interface DeviceConfig {
  /**
   * The device's private key in hex format.  If not present a new
   * key will be generated and stored automatically.
   */
  devicePrivateKey: string;
  /**
   * Optional home latitude and longitude in E7 (degrees ×1e7).  When
   * present these coordinates define the drone's home base.  They
   * are stored as strings to preserve precision of big integers in
   * JSON.  On first run these values may be populated automatically
   * using the host's geolocation (based on its IP address).
   */
  homeLatE7?: string;
  homeLonE7?: string;

  /**
   * Optional travel speed in miles per hour for the simulated
   * drone.  When present the device will move at this speed
   * between waypoints in the operation flow.  If omitted the
   * simulator falls back to an environment variable (SPEED_MPH)
   * or a default value.  A value of 10 corresponds to roughly
   * 10 miles per hour.
   */
  speedMph?: number;
}

const defaultPath = path.join(process.cwd(), 'device-config.json');
const CONFIG_PATH = process.env.CONFIG_PATH || defaultPath;

/**
 * Reads the device configuration from disk.  Returns null if the file
 * does not exist.
 */
export function readConfig(): DeviceConfig | null {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw) as DeviceConfig;
  } catch (err) {
    return null;
  }
}

/**
 * Writes the given configuration back to disk.  The file is
 * formatted with two spaces for readability.
 */
export function writeConfig(cfg: DeviceConfig): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}