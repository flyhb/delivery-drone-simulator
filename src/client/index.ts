import dotenv from 'dotenv';
dotenv.config();

import { Client } from './Client';

async function main(): Promise<void> {
  const client = new Client();
  await client.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});