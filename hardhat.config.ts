import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import * as dotenv from "dotenv";
import { HardhatUserConfig } from "hardhat/config";

dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      forking: {
        url: process.env.BASE_RPC_URL || "https://base.gateway.tenderly.co",
      },
      accounts: {
        mnemonic: "test test test test test test test test test test test junk",
      },
    },
    base: {
      url: process.env.BASE_RPC_URL || "https://base.gateway.tenderly.co",
      accounts:
        process.env.PRIVATE_KEY_1 !== undefined
          ? [process.env.PRIVATE_KEY_1]
          : [],
    },
  },
  etherscan: {
    apiKey: {
      base: process.env.BASESCAN_API_KEY || "",
    },
    customChains: [
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.basescan.org/api",
          browserURL: "https://basescan.org",
        },
      },
    ],
  },
  sourcify: {
    enabled: false,
  },
  defender: {
    apiKey: process.env.DEFENDER_API_KEY || "",
    apiSecret: process.env.DEFENDER_API_SECRET || "",
  },
};

export default config;
