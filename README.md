# Delivery Drone Station Simulator

This project simulates a delivery drone station device that integrates with the ioID identity system.  It is intended as a learning reference and a starting point for projects that need to onboard physical devices into the ioID registry.

The simulator is split into two distinct parts:

* **Device** – emulates the firmware running on the physical device.  It manages a persistent device key, checks registration status and signs permit messages.  Once registered it enters an example “operation” loop.
* **Client** – represents a companion application used by the device owner or operator.  It collects the owner’s private key, coordinates the registration process and pays the ioID registration fee on behalf of the device.

## Prerequisites

* Node.js version 18 or 20 (Hardhat and Ethers do not support Node 23 at the time of writing)
* Yarn or npm installed globally
* An RPC endpoint for the target chain (e.g. a local Hardhat node or the Berachain Bepolia testnet)
* Deployed ioID infrastructure (registry, store, device NFT contract etc.)

## Setup

1. Install dependencies:

   ```bash
   cd delivery-drone-simulator
   npm install
   ```

2. Copy the provided `.env.example` to `.env` and fill in the required values.  At minimum you need `RPC_URL`, `CHAIN_ID`, `IOID_REGISTRY`, `IOID_PRICE`, `DEVICE_CONTRACT_ADDRESS` and `DEVICE_TOKEN_ID`.  Optionally you can predefine `OWNER_PRIVATE_KEY` to avoid the runtime prompt.

3. Build the TypeScript sources (or run directly with ts-node):

   ```bash
   # To compile to JavaScript
   npm run build

   # Or run with ts-node (used by the npm start script)
   npm start
   ```

## Running the simulator

The default start script launches the **client**.  On startup it:

1. Loads or creates a persistent device key and displays the device address.
2. Connects to the configured `ioIDRegistry` contract and checks if the device is already registered.
3. If the device is not registered it prompts for the owner’s private key (unless `OWNER_PRIVATE_KEY` is set in the `.env`).
4. The device signs an EIP‑712 permit authorizing the owner to register it.  The client then calls `ioIDRegistry.register(...)` with the proper parameters and registration fee.  After the transaction confirms, the device is registered.
5. Once registered, the device enters a dummy operation loop where it prints a periodic message to the console.  In a real firmware this is where you would interact with sensors, control actuators, etc.

You can also run the device alone using the `src/device/index.ts` script.  It will report whether the device is registered and start the operation loop if so.  Otherwise it instructs you to use the client to register.

## File structure

```
delivery-drone-simulator/
├── src/
│   ├── client/
│   │   ├── Client.ts      # Companion app logic (user prompts, registration)
│   │   └── index.ts       # Client entrypoint
│   ├── device/
│   │   ├── Device.ts      # Device firmware simulation (key mgmt, signing)
│   │   └── index.ts       # Device entrypoint
│   ├── utils/
│   │   └── blockchain.ts   # Shared helpers for provider and contract
│   └── config.ts          # Read/write device configuration
├── .env.example           # Environment variable template
├── package.json           # Project metadata and scripts
├── tsconfig.json          # TypeScript compiler options
└── README.md              # This file
```

## Important notes

* This simulator is a simplified illustration.  In production you must handle errors, edge cases and security concerns (e.g. never hard‑code private keys, handle network failures, ensure proper error handling when calling contracts, etc.).
* The device stores its private key and configuration in `device-config.json` (by default).  This file is created next to the running script and should be kept secret.
* The EIP‑712 signing uses the same domain parameters as the `ioIDRegistry` contract (name `ioIDRegistry`, version `1`, chain ID from the provider and the registry address as the verifying contract).
* The dummy operation simply logs a heartbeat message to the console.  Replace this with your actual device logic.
