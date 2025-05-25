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
    base: {
      url: "https://developer-access-mainnet.base.org",
      accounts: process.env.PRIVATE_KEY_1 !== undefined ? [process.env.PRIVATE_KEY_1] : [],
    },
  },
  etherscan: {
    apiKey: {
      base: process.env.BASE_API_KEY || "",
    },
  },
  defender: {
    apiKey: process.env.DEFENDER_API_KEY || "",
    apiSecret: process.env.DEFENDER_API_SECRET || "",
  }
};

export default config;
