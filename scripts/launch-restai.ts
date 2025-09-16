import { ethers } from "hardhat";
import { parseEther, formatEther } from "ethers";
import { RestAI } from "../typechain-types";

// CONFIGURATION CONSTANTS
const CONFIG = {
  // Set the proxy address of your deployed RestAI contract
  PROXY_ADDRESS: "0x0000000000000000000000000000000000000000", // CHANGE THIS

  // Launch parameters
  TOKEN_AMOUNT: parseEther("100000000"), // 100M tokens (10% of supply)
  ETH_AMOUNT: parseEther("1"), // 1 ETH for initial liquidity

  // Confirmation delay in seconds
  CONFIRMATION_DELAY: 10,
};

async function main() {
  console.log("=".repeat(60));
  console.log("RestAI Launch Script");
  console.log("=".repeat(60));

  // Validate address format
  if (!ethers.isAddress(CONFIG.PROXY_ADDRESS)) {
    console.error("❌ Invalid PROXY_ADDRESS format!");
    console.error("Please ensure it's a valid Ethereum address");
    process.exit(1);
  }

  // Get signers
  const [launcher] = await ethers.getSigners();
  console.log("Launcher address:", launcher.address);

  // Get network
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? `chainId-${network.chainId}` : network.name;

  console.log("Network:", networkName);
  console.log("Chain ID:", network.chainId);

  try {
    // Connect to the deployed contract
    console.log("\n📋 Connecting to RestAI contract...");
    const restAI = await ethers.getContractAt("RestAI", CONFIG.PROXY_ADDRESS) as RestAI;
    console.log("✅ Connected to RestAI at:", await restAI.getAddress());

    // Verify contract info
    const name = await restAI.name();
    const symbol = await restAI.symbol();
    console.log(`Token: ${name} (${symbol})`);

    // Check if already launched
    const isLaunched = await restAI.isLaunched();
    if (isLaunched) {
      console.error("\n❌ RestAI is already launched!");
      console.log("The token has already been launched and trading is enabled.");
      process.exit(1);
    }

    // Check launcher's roles
    const MANAGER_ROLE = await restAI.MANAGER_ROLE();
    const hasManagerRole = await restAI.hasRole(MANAGER_ROLE, launcher.address);

    if (!hasManagerRole) {
      console.error("\n❌ Launcher does not have MANAGER_ROLE!");
      console.log("Address", launcher.address, "needs MANAGER_ROLE to launch");
      console.log("Please have an admin grant this role first");
      process.exit(1);
    }

    // Check launcher's token balance
    const balance = await restAI.balanceOf(launcher.address);
    console.log("\n💰 Balance Check:");
    console.log(`Launcher token balance: ${formatEther(balance)} ${symbol}`);
    console.log(`Required for launch: ${formatEther(CONFIG.TOKEN_AMOUNT)} ${symbol}`);

    if (balance < CONFIG.TOKEN_AMOUNT) {
      console.error("\n❌ Insufficient token balance for launch");
      console.log("Please ensure the launcher has enough tokens");
      process.exit(1);
    }

    // Check ETH balance
    const ethBalance = await ethers.provider.getBalance(launcher.address);
    console.log(`\nLauncher ETH balance: ${formatEther(ethBalance)} ETH`);
    console.log(`Required ETH: ${formatEther(CONFIG.ETH_AMOUNT)} ETH (plus gas)`);

    const estimatedGas = parseEther("0.01"); // Estimated gas needed
    if (ethBalance < CONFIG.ETH_AMOUNT + estimatedGas) {
      console.error("\n❌ Insufficient ETH balance for launch and gas");
      process.exit(1);
    }

    // Display current configuration
    console.log("\n📊 Current Contract Configuration:");
    const limits = await restAI.limits();
    console.log("Limits:");
    console.log(`  - Max Buy: ${formatEther(limits.maxBuy)} ${symbol} (${(Number(limits.maxBuy) * 10000n / await restAI.totalSupply()).toString() / 100}%)`);
    console.log(`  - Max Sell: ${formatEther(limits.maxSell)} ${symbol} (${(Number(limits.maxSell) * 10000n / await restAI.totalSupply()).toString() / 100}%)`);
    console.log(`  - Max Wallet: ${formatEther(limits.maxWallet)} ${symbol} (${(Number(limits.maxWallet) * 10000n / await restAI.totalSupply()).toString() / 100}%)`);

    const fees = await restAI.fees();
    console.log("\nFees:");
    console.log(`  - Buy Fee: ${Number(fees.buyFee) / 100}%`);
    console.log(`  - Sell Fee: ${Number(fees.sellFee) / 100}%`);
    console.log(`  - Transfer Fee: ${Number(fees.transferFee) / 100}%`);

    const swapThreshold = await restAI.swapTokensAtAmount();
    const totalSupply = await restAI.totalSupply();
    console.log(`\nSwap Threshold: ${formatEther(swapThreshold)} ${symbol} (${(Number(swapThreshold) * 10000n / totalSupply).toString() / 100}%)`);

    const operationsWallet = await restAI.operationsWallet();
    console.log(`Operations Wallet: ${operationsWallet}`);

    const isLimitsEnabled = await restAI.isLimitsEnabled();
    const isTaxEnabled = await restAI.isTaxEnabled();
    console.log(`\nLimits Enabled: ${isLimitsEnabled}`);
    console.log(`Tax Enabled: ${isTaxEnabled}`);

    // Confirmation
    console.log("\n" + "=".repeat(60));
    console.log("⚠️  LAUNCH CONFIRMATION");
    console.log("=".repeat(60));
    console.log(`Contract: ${CONFIG.PROXY_ADDRESS}`);
    console.log(`Token Amount: ${formatEther(CONFIG.TOKEN_AMOUNT)} ${symbol}`);
    console.log(`ETH Amount: ${formatEther(CONFIG.ETH_AMOUNT)} ETH`);
    console.log(`Network: ${networkName}`);
    console.log("\nThis will:");
    console.log("1. Create a Uniswap V2 liquidity pool");
    console.log("2. Add initial liquidity");
    console.log("3. Enable trading permanently");
    console.log("4. LP tokens will be sent to the operations wallet");
    console.log("\n⚠️  WARNING: This action is IRREVERSIBLE!");

    // Wait for user confirmation
    console.log(`\n⏰ You have ${CONFIG.CONFIRMATION_DELAY} seconds to cancel (Ctrl+C)...`);
    for (let i = CONFIG.CONFIRMATION_DELAY; i > 0; i--) {
      process.stdout.write(`\r${i} seconds remaining...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    console.log("\n");

    // Approve tokens for the launch
    console.log("🔐 Approving tokens...");
    const approveTx = await restAI.approve(
      await restAI.getAddress(),
      CONFIG.TOKEN_AMOUNT
    );
    await approveTx.wait();
    console.log("✅ Tokens approved");

    // Launch the token
    console.log("\n🚀 Launching RestAI...");
    console.log("Sending transaction...");

    const launchTx = await restAI.launch(
      CONFIG.TOKEN_AMOUNT,
      {
        value: CONFIG.ETH_AMOUNT,
        gasLimit: 500000 // Set explicit gas limit
      }
    );

    console.log("📝 Launch transaction submitted:", launchTx.hash);
    console.log("⏳ Waiting for confirmation...");

    const receipt = await launchTx.wait();
    console.log("✅ Launch confirmed in block:", receipt?.blockNumber);

    // Get the pair address
    const pairAddress = await restAI.swapPair();
    console.log("\n📍 Uniswap Pair Address:", pairAddress);

    // Verify launch status
    const launchedStatus = await restAI.isLaunched();
    console.log("🎯 Launch Status:", launchedStatus ? "SUCCESS" : "FAILED");

    if (launchedStatus) {
      // Get pair info
      const pair = await ethers.getContractAt(
        ["function totalSupply() view returns (uint256)"],
        pairAddress
      );
      const lpTotalSupply = await pair.totalSupply();
      console.log(`LP Token Total Supply: ${formatEther(lpTotalSupply)}`);

      console.log("\n" + "=".repeat(60));
      console.log("🎉 RestAI Successfully Launched!");
      console.log("=".repeat(60));

      // Save launch info
      const fs = await import("fs");
      const launchInfo = {
        timestamp: new Date().toISOString(),
        network: networkName,
        chainId: network.chainId.toString(),
        launcher: launcher.address,
        proxy: CONFIG.PROXY_ADDRESS,
        pairAddress: pairAddress,
        tokenAmount: CONFIG.TOKEN_AMOUNT.toString(),
        ethAmount: CONFIG.ETH_AMOUNT.toString(),
        txHash: launchTx.hash,
        blockNumber: receipt?.blockNumber.toString()
      };

      const fileName = `launch-restai-${networkName}-${Date.now()}.json`;
      await fs.promises.writeFile(
        fileName,
        JSON.stringify(launchInfo, null, 2)
      );
      console.log(`\n📄 Launch info saved to: ${fileName}`);

      console.log("\n📝 Next Steps:");
      console.log("1. Verify liquidity on Uniswap/DEX");
      console.log("2. Test buy/sell transactions");
      console.log("3. Monitor contract performance");
      console.log("4. Consider adjusting limits and fees as needed");
      console.log("5. When stable, consider disabling limits");

      console.log("\n🔗 Useful Links:");
      console.log(`Pair: ${pairAddress}`);
      console.log(`Token: ${CONFIG.PROXY_ADDRESS}`);
    } else {
      console.error("\n❌ Launch verification failed!");
      console.log("Please check the transaction and contract state");
    }

  } catch (error: any) {
    console.error("\n❌ Launch failed:", error);
    if (error.reason) {
      console.error("Reason:", error.reason);
    }
    if (error.data) {
      console.error("Error data:", error.data);
    }
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });