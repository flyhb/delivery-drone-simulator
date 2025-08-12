import dotenv from 'dotenv';
dotenv.config();

import { getProvider, getRegistry } from '../utils/blockchain';
import { Device } from './Device';

async function main(): Promise<void> {
  const provider = getProvider();
  const registry = getRegistry(provider);
  const device = new Device(provider, registry);
  console.log(`Device address: ${device.address()}`);
  if (await device.isRegistered()) {
    console.log('Device is already registered.  Starting operation...');
    device.startOperationFlow();
  } else {
    console.log('Device is not registered.  Please run the client to register this device.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});