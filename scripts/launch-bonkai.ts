import { ethers } from "hardhat";

async function main() {
  // Contract address on Base network
  const BONKAI_ADDRESS = "0xf84d967498F4e96c5C1a7B9CC9eFC538d60CF224";

  // Address that should have tokens
  const TOKEN_HOLDER = "0xc05a8e3cD35bE7C1ef19E1B324baa9Ad838110d9";

  // Get signer
  const [signer] = await ethers.getSigners();
  console.log("Launching with account:", signer.address);

  // Get contract instance
  const BonkAI = await ethers.getContractAt("BonkAI", BONKAI_ADDRESS);

  // Check current balance
  const balance = await BonkAI.balanceOf(signer.address);
  console.log("Token balance:", ethers.formatEther(balance));

  // Amount of tokens to add to liquidity (adjust as needed)
  // For example: 500,000,000 tokens (50% of supply)
  const tokenAmount = ethers.parseEther("500000000");

  // Amount of ETH to add to liquidity (adjust as needed)
  // For example: 1 ETH
  const ethAmount = ethers.parseEther("1");

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
    console.error(`Error: Insufficient token balance. Need ${ethers.formatEther(tokenAmount)} but have ${ethers.formatEther(balance)}`);
    return;
  }

  // Check ETH balance
  const ethBalance = await ethers.provider.getBalance(signer.address);
  const totalEthNeeded = ethAmount + ethers.parseEther("0.01"); // Extra for gas
  if (ethBalance < totalEthNeeded) {
    console.error(`Error: Insufficient ETH balance. Need ${ethers.formatEther(totalEthNeeded)} but have ${ethers.formatEther(ethBalance)}`);
    return;
  }

  console.log("\n=== Launch Parameters ===");
  console.log("Token amount:", ethers.formatEther(tokenAmount), "BONKAI");
  console.log("ETH amount:", ethers.formatEther(ethAmount), "ETH");
  console.log("========================\n");

  console.log("Launching BonkAI token...");

  try {
    // Call launch function
    const tx = await BonkAI.launch(tokenAmount, {
      value: ethAmount,
      gasLimit: 500000, // Set explicit gas limit
    });

    console.log("Transaction sent:", tx.hash);
    console.log("Waiting for confirmation...");

    const receipt = await tx.wait();
    console.log("Transaction confirmed in block:", receipt.blockNumber);

    // Get pair address from events
    const launchEvent = receipt.logs.find((log: any) => {
      try {
        const parsed = BonkAI.interface.parseLog(log);
        return parsed?.name === "Launch";
      } catch {
        return false;
      }
    });

    if (launchEvent) {
      console.log("\n✅ Token launched successfully!");

      // Get pair address
      const swapPair = await BonkAI.swapPair();
      console.log("Liquidity pair address:", swapPair);
      console.log("View on Basescan: https://basescan.org/address/" + swapPair);
    }

  } catch (error: any) {
    console.error("\n❌ Launch failed!");
    if (error.reason) {
      console.error("Reason:", error.reason);
    }
    if (error.data) {
      // Try to decode the error
      try {
        const decodedError = BonkAI.interface.parseError(error.data);
        console.error("Error:", decodedError);
      } catch {
        console.error("Raw error data:", error.data);
      }
    }
    console.error("Full error:", error);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});