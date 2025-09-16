import { ethers } from "hardhat";

async function main() {
  // Contract address on Base network
  const BONKAI_ADDRESS = "0xf84d967498F4e96c5C1a7B9CC9eFC538d60CF224";

  // Get signer (should be operations wallet with DEFAULT_ADMIN_ROLE)
  const [signer] = await ethers.getSigners();
  console.log("Current signer:", signer.address);

  // Get contract instance
  const BonkAI = await ethers.getContractAt("BonkAI", BONKAI_ADDRESS);

  // Check if signer is operations wallet
  const operationsWallet = "0x9bE24EB303DdD438bAD2869D18bb9926605D7A41";
  const deployerWallet = "0x5653510308a68809b36807990DEFd127e4141561";

  // Get role constants
  const MANAGER_ROLE = await BonkAI.MANAGER_ROLE();
  const DEFAULT_ADMIN_ROLE = await BonkAI.DEFAULT_ADMIN_ROLE();

  // Check current roles
  const signerHasAdmin = await BonkAI.hasRole(DEFAULT_ADMIN_ROLE, signer.address);
  const signerHasManager = await BonkAI.hasRole(MANAGER_ROLE, signer.address);

  console.log("\nCurrent signer roles:");
  console.log("- Has DEFAULT_ADMIN_ROLE:", signerHasAdmin);
  console.log("- Has MANAGER_ROLE:", signerHasManager);

  // Check token balance
  const balance = await BonkAI.balanceOf(signer.address);
  console.log("\nToken balance:", ethers.formatEther(balance), "BONKAI");

  if (signer.address.toLowerCase() === operationsWallet.toLowerCase()) {
    console.log("\n✅ You are using the operations wallet");

    if (!signerHasManager) {
      console.log("\nGranting MANAGER_ROLE to operations wallet...");
      try {
        const tx = await BonkAI.grantRole(MANAGER_ROLE, operationsWallet);
        console.log("Transaction sent:", tx.hash);
        await tx.wait();
        console.log("✅ MANAGER_ROLE granted successfully!");
      } catch (error: any) {
        console.error("❌ Failed to grant role:", error.reason || error.message);
      }
    } else {
      console.log("✅ Operations wallet already has MANAGER_ROLE");
    }

    console.log("\n🚀 Operations wallet is now ready to launch the token!");
    console.log("Run: npx hardhat run scripts/launch-bonkai.ts --network base");

  } else if (signer.address.toLowerCase() === deployerWallet.toLowerCase()) {
    console.log("\n⚠️  You are using the deployer wallet");
    console.log("The deployer has MANAGER_ROLE but no tokens.");
    console.log("\nTo launch, you need to:");
    console.log("1. Switch to the operations wallet (which has the tokens)");
    console.log("2. Run this script again to grant it MANAGER_ROLE");
    console.log("\nOr transfer tokens from operations wallet to deployer.");

  } else {
    console.log("\n⚠️  Unknown wallet");
    console.log("Please use either:");
    console.log("- Operations wallet:", operationsWallet, "(has tokens)");
    console.log("- Deployer wallet:", deployerWallet, "(has MANAGER_ROLE)");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});