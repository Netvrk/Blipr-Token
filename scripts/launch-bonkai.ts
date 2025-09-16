import { ethers } from "hardhat";

async function main() {
  // Contract address on Base network
  const BONKAI_ADDRESS = "0x619C6643CdB2642D27163baF74dc61143CA09f57";

  // Get signer
  const [signer] = await ethers.getSigners();
  console.log("Launching with account:", signer.address);

  // Get contract instance
  const BonkAI = await ethers.getContractAt("BonkAI", BONKAI_ADDRESS);

  // Check current balance
  const balance = await BonkAI.balanceOf(signer.address);
  console.log("Token balance:", ethers.formatEther(balance));

  // Amount of tokens to add to liquidity (adjust as needed)
  // For example: 500,000,000 tokens (10% of supply)
  const tokenAmount = ethers.parseEther("100000000");

  // Amount of ETH to add to liquidity (adjust as needed)
  // For example: 0.1 ETH for testing
  const ethAmount = ethers.parseEther("0.02");

  // Check if already launched
  const isLaunched = await BonkAI.isLaunched();
  if (isLaunched) {
    console.log("Token is already launched!");
    return;
  }

  // Check if signer has MANAGER_ROLE
  const MANAGER_ROLE = await BonkAI.MANAGER_ROLE();
  const hasRole = await BonkAI.hasRole(MANAGER_ROLE, signer.address);

  if (!hasRole) {
    console.error("Error: Signer does not have MANAGER_ROLE");
    console.log("Please ensure the account has MANAGER_ROLE before launching");
    return;
  }

  // Check token balance
  if (balance < tokenAmount) {
    console.error(
      `Error: Insufficient token balance. Need ${ethers.formatEther(
        tokenAmount
      )} but have ${ethers.formatEther(balance)}`
    );
    return;
  }

  // Check ETH balance
  const ethBalance = await ethers.provider.getBalance(signer.address);
  const totalEthNeeded = ethAmount + ethers.parseEther("0.01"); // Extra for gas
  if (ethBalance < totalEthNeeded) {
    console.error(
      `Error: Insufficient ETH balance. Need ${ethers.formatEther(
        totalEthNeeded
      )} but have ${ethers.formatEther(ethBalance)}`
    );
    return;
  }

  console.log("\n=== Launch Parameters ===");
  console.log("Token amount:", ethers.formatEther(tokenAmount), "BONKAI");
  console.log("ETH amount:", ethers.formatEther(ethAmount), "ETH");
  console.log("========================\n");

  // Simulate the transaction only
  console.log("Simulating launch transaction...");
  try {
    await BonkAI.launch.staticCall(tokenAmount, {
      value: ethAmount,
      from: signer.address,
    });
    console.log(
      "\n✅ Simulation successful! The launch transaction will succeed."
    );
  } catch (error: any) {
    console.error("\n❌ Simulation failed!");
    console.error("Reason:", error.reason || error.message);

    if (error.data) {
      try {
        const decodedError = BonkAI.interface.parseError(error.data);
        console.error("Decoded error:", decodedError);
      } catch {
        console.error("Raw error data:", error.data);
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
