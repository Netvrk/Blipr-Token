import { ethers } from "hardhat";

async function main() {
  // Contract addresses
  const BONKAI_ADDRESS = "0xf84d967498F4e96c5C1a7B9CC9eFC538d60CF224";
  const PROXY_ADDRESS = "0xc05a8e3cD35bE7C1ef19E1B324baa9Ad838110d9";

  // Known addresses
  const addresses = {
    "Owner/Deployer": "0x5653510308a68809b36807990DEFd127e4141561",
    "Operations": "0x9bE24EB303DdD438bAD2869D18bb9926605D7A41",
    "BonkAI Contract": BONKAI_ADDRESS,
    "Proxy Contract": PROXY_ADDRESS,
  };

  // Get contract instance
  const BonkAI = await ethers.getContractAt("BonkAI", BONKAI_ADDRESS);

  console.log("=== BONKAI Token Balances ===\n");

  // Check total supply
  const totalSupply = await BonkAI.totalSupply();
  console.log("Total Supply:", ethers.formatEther(totalSupply), "BONKAI\n");

  // Check balances
  for (const [label, address] of Object.entries(addresses)) {
    const balance = await BonkAI.balanceOf(address);
    if (balance > 0n) {
      console.log(`${label} (${address}):`);
      console.log(`  Balance: ${ethers.formatEther(balance)} BONKAI`);
      const percentage = (Number(balance) * 100 / Number(totalSupply)).toFixed(2);
      console.log(`  Percentage: ${percentage}%\n`);
    }
  }

  // Check if launched
  const isLaunched = await BonkAI.isLaunched();
  console.log("Is Launched:", isLaunched);

  // Check roles
  const MANAGER_ROLE = await BonkAI.MANAGER_ROLE();
  const DEFAULT_ADMIN_ROLE = await BonkAI.DEFAULT_ADMIN_ROLE();

  console.log("\n=== Roles ===");
  for (const [label, address] of Object.entries(addresses)) {
    const hasManager = await BonkAI.hasRole(MANAGER_ROLE, address);
    const hasAdmin = await BonkAI.hasRole(DEFAULT_ADMIN_ROLE, address);
    if (hasManager || hasAdmin) {
      console.log(`${label}:`);
      if (hasManager) console.log("  - MANAGER_ROLE");
      if (hasAdmin) console.log("  - DEFAULT_ADMIN_ROLE");
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});