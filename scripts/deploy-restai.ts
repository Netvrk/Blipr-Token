import { ethers, upgrades, run } from "hardhat";
import { RestAI } from "../typechain-types";

// CONFIGURATION CONSTANTS
const CONFIG = {
  // Set your owner address here (will receive DEFAULT_ADMIN_ROLE)
  OWNER_ADDRESS: "0x5653510308a68809b36807990DEFd127e4141561", // CHANGE THIS

  // Set your operations wallet here (will receive ETH from taxes)
  OPERATIONS_WALLET: "0x9bE24EB303DdD438bAD2869D18bb9926605D7A41", // CHANGE THIS

  // Verification delay (milliseconds to wait before verification)
  VERIFICATION_DELAY: 30000, // 30 seconds
};

async function main() {
  console.log("=".repeat(60));
  console.log("RestAI Deployment Script");
  console.log("=".repeat(60));

  // Validate addresses
  if (!ethers.isAddress(CONFIG.OWNER_ADDRESS)) {
    console.error("❌ Invalid OWNER_ADDRESS format!");
    process.exit(1);
  }

  if (!ethers.isAddress(CONFIG.OPERATIONS_WALLET)) {
    console.error("❌ Invalid OPERATIONS_WALLET format!");
    process.exit(1);
  }

  // Get signers
  const [deployer] = await ethers.getSigners();
  console.log("Deployer address:", deployer.address);

  // Check deployer balance
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer ETH balance:", ethers.formatEther(balance), "ETH");

  // Get network
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? `chainId-${network.chainId}` : network.name;

  console.log("\n📋 Deployment Configuration:");
  console.log("Network:", networkName);
  console.log("Chain ID:", network.chainId);
  console.log("Owner Address:", CONFIG.OWNER_ADDRESS);
  console.log("Operations Wallet:", CONFIG.OPERATIONS_WALLET);

  // Confirmation
  console.log("\n⚠️  Deployment Confirmation");
  console.log("=".repeat(40));
  console.log("You are about to deploy RestAI with:");
  console.log("- Owner:", CONFIG.OWNER_ADDRESS);
  console.log("- Operations:", CONFIG.OPERATIONS_WALLET);
  console.log("- Network:", networkName);
  console.log("\n⏰ You have 5 seconds to cancel (Ctrl+C)...");
  await new Promise(resolve => setTimeout(resolve, 5000));

  try {
    // Deploy RestAI as upgradeable proxy
    console.log("\n📦 Deploying RestAI...");
    const RestAI = await ethers.getContractFactory("RestAI");

    const restAI = await upgrades.deployProxy(
      RestAI,
      [CONFIG.OPERATIONS_WALLET],
      {
        initializer: "initialize",
        kind: "uups"
      }
    ) as unknown as RestAI;

    await restAI.waitForDeployment();

    const proxyAddress = await restAI.getAddress();
    const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
    const adminAddress = await upgrades.erc1967.getAdminAddress(proxyAddress);

    console.log("\n✅ RestAI deployed successfully!");
    console.log("=".repeat(60));
    console.log("📍 Proxy Address:", proxyAddress);
    console.log("📍 Implementation Address:", implementationAddress);
    console.log("📍 ProxyAdmin Address:", adminAddress);
    console.log("=".repeat(60));

    // Transfer ownership if needed
    if (CONFIG.OWNER_ADDRESS.toLowerCase() !== deployer.address.toLowerCase()) {
      console.log("\n🔐 Transferring ownership...");

      const DEFAULT_ADMIN_ROLE = await restAI.DEFAULT_ADMIN_ROLE();
      const MANAGER_ROLE = await restAI.MANAGER_ROLE();
      const UPGRADER_ROLE = await restAI.UPGRADER_ROLE();

      // Grant roles to the new owner
      console.log("Granting DEFAULT_ADMIN_ROLE to", CONFIG.OWNER_ADDRESS);
      await restAI.grantRole(DEFAULT_ADMIN_ROLE, CONFIG.OWNER_ADDRESS);

      console.log("Granting MANAGER_ROLE to", CONFIG.OWNER_ADDRESS);
      await restAI.grantRole(MANAGER_ROLE, CONFIG.OWNER_ADDRESS);

      console.log("Granting UPGRADER_ROLE to", CONFIG.OWNER_ADDRESS);
      await restAI.grantRole(UPGRADER_ROLE, CONFIG.OWNER_ADDRESS);

      // Optionally revoke roles from deployer (uncomment if desired)
      // console.log("Revoking roles from deployer...");
      // await restAI.revokeRole(DEFAULT_ADMIN_ROLE, deployer.address);
      // await restAI.revokeRole(MANAGER_ROLE, deployer.address);
      // await restAI.revokeRole(UPGRADER_ROLE, deployer.address);

      console.log("✅ Ownership transferred successfully!");
    }

    // Display contract info
    console.log("\n📊 Contract Information:");
    const name = await restAI.name();
    const symbol = await restAI.symbol();
    const totalSupply = await restAI.totalSupply();

    console.log(`  Name: ${name}`);
    console.log(`  Symbol: ${symbol}`);
    console.log(`  Total Supply: ${ethers.formatEther(totalSupply)} RESTAI`);
    console.log(`  Operations Wallet: ${await restAI.operationsWallet()}`);

    // Save deployment info
    const fs = await import("fs");
    const deploymentInfo = {
      timestamp: new Date().toISOString(),
      network: networkName,
      chainId: network.chainId.toString(),
      deployer: deployer.address,
      owner: CONFIG.OWNER_ADDRESS,
      operationsWallet: CONFIG.OPERATIONS_WALLET,
      addresses: {
        proxy: proxyAddress,
        implementation: implementationAddress,
        proxyAdmin: adminAddress
      },
      tokenInfo: {
        name,
        symbol,
        totalSupply: totalSupply.toString()
      }
    };

    const fileName = `deployment-restai-${networkName}-${Date.now()}.json`;
    await fs.promises.writeFile(
      fileName,
      JSON.stringify(deploymentInfo, null, 2)
    );
    console.log(`\n📄 Deployment info saved to: ${fileName}`);

    // Verify on Etherscan/Basescan
    console.log("\n🔍 Starting contract verification...");
    console.log(`Waiting ${CONFIG.VERIFICATION_DELAY / 1000} seconds before verification...`);
    await new Promise(resolve => setTimeout(resolve, CONFIG.VERIFICATION_DELAY));

    try {
      console.log("Verifying proxy contract...");
      await run("verify:verify", {
        address: proxyAddress,
        constructorArguments: [],
      });
      console.log("✅ Proxy verified successfully!");
    } catch (error: any) {
      if (error.message.includes("already verified")) {
        console.log("✅ Proxy already verified!");
      } else {
        console.log("⚠️  Proxy verification failed:", error.message);
        console.log("You can verify manually using:");
        console.log(`npx hardhat verify --network ${networkName} ${proxyAddress}`);
      }
    }

    try {
      console.log("Verifying implementation contract...");
      await run("verify:verify", {
        address: implementationAddress,
        constructorArguments: [],
      });
      console.log("✅ Implementation verified successfully!");
    } catch (error: any) {
      if (error.message.includes("already verified")) {
        console.log("✅ Implementation already verified!");
      } else {
        console.log("⚠️  Implementation verification failed:", error.message);
        console.log("You can verify manually using:");
        console.log(`npx hardhat verify --network ${networkName} ${implementationAddress}`);
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log("🎉 Deployment Complete!");
    console.log("=".repeat(60));
    console.log("\n📝 Important Addresses:");
    console.log("Proxy:", proxyAddress);
    console.log("Implementation:", implementationAddress);
    console.log("ProxyAdmin:", adminAddress);
    console.log("\n📌 Next Steps:");
    console.log("1. Save the addresses above securely");
    console.log("2. Transfer tokens to the owner address if needed");
    console.log("3. When ready to launch, use the launch script:");
    console.log(`   npx hardhat run scripts/launch-restai.ts --network ${networkName}`);
    console.log("\n⚠️  The proxy address to use for launch:", proxyAddress);

  } catch (error) {
    console.error("\n❌ Deployment failed:", error);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });