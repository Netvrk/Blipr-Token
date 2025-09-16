import { ethers, upgrades } from "hardhat";
import { RestAI } from "../typechain-types";

async function main() {
  console.log("=".repeat(60));
  console.log("RestAI Upgrade Script");
  console.log("=".repeat(60));

  // Get signers
  const [deployer] = await ethers.getSigners();
  console.log("Deployer address:", deployer.address);

  // Get proxy address from environment or hardcode it
  const PROXY_ADDRESS = process.env.RESTAI_PROXY_ADDRESS || "";

  if (!PROXY_ADDRESS) {
    console.error("❌ Please set RESTAI_PROXY_ADDRESS environment variable");
    console.log("Example: RESTAI_PROXY_ADDRESS=0x... npx hardhat run scripts/upgrade-restai.ts --network base");
    process.exit(1);
  }

  try {
    console.log("\n📋 Current Proxy Address:", PROXY_ADDRESS);

    // Get current implementation
    const currentImpl = await upgrades.erc1967.getImplementationAddress(PROXY_ADDRESS);
    console.log("📍 Current Implementation:", currentImpl);

    // Get current contract to verify it's working
    console.log("\n🔍 Verifying current contract...");
    const currentContract = await ethers.getContractAt("RestAI", PROXY_ADDRESS) as RestAI;

    // Read some current state to verify
    const name = await currentContract.name();
    const symbol = await currentContract.symbol();
    const totalSupply = await currentContract.totalSupply();
    const isLaunched = await currentContract.isLaunched();

    console.log("✅ Current Contract Info:");
    console.log(`  - Name: ${name}`);
    console.log(`  - Symbol: ${symbol}`);
    console.log(`  - Total Supply: ${ethers.formatEther(totalSupply)}`);
    console.log(`  - Is Launched: ${isLaunched}`);

    // Check roles
    const DEFAULT_ADMIN_ROLE = await currentContract.DEFAULT_ADMIN_ROLE();
    const UPGRADER_ROLE = await currentContract.UPGRADER_ROLE();

    const hasAdminRole = await currentContract.hasRole(DEFAULT_ADMIN_ROLE, deployer.address);
    const hasUpgraderRole = await currentContract.hasRole(UPGRADER_ROLE, deployer.address);

    console.log("\n🔐 Role Check:");
    console.log(`  - Has DEFAULT_ADMIN_ROLE: ${hasAdminRole}`);
    console.log(`  - Has UPGRADER_ROLE: ${hasUpgraderRole}`);

    if (!hasUpgraderRole) {
      console.error("\n❌ Deployer does not have UPGRADER_ROLE!");
      console.log("Please grant UPGRADER_ROLE to", deployer.address);
      process.exit(1);
    }

    // Compile and prepare new implementation
    console.log("\n📦 Preparing new implementation...");
    const RestAIV2 = await ethers.getContractFactory("RestAI");

    // Validate upgrade
    console.log("🔍 Validating upgrade compatibility...");
    try {
      await upgrades.validateUpgrade(PROXY_ADDRESS, RestAIV2, {
        kind: "uups"
      });
      console.log("✅ Upgrade validation passed");
    } catch (error: any) {
      console.error("❌ Upgrade validation failed:", error.message);
      process.exit(1);
    }

    // Display upgrade summary
    console.log("\n" + "=".repeat(60));
    console.log("⚠️  UPGRADE CONFIRMATION");
    console.log("=".repeat(60));
    console.log("Proxy Address:", PROXY_ADDRESS);
    console.log("Current Implementation:", currentImpl);
    console.log("Network:", (await ethers.provider.getNetwork()).name);
    console.log("\nThis upgrade will:");
    console.log("1. Deploy a new implementation contract");
    console.log("2. Update the proxy to point to the new implementation");
    console.log("3. Preserve all existing state and balances");
    console.log("4. Maintain all existing roles and permissions");

    // Wait for user confirmation
    console.log("\n⏰ You have 10 seconds to cancel (Ctrl+C)...");
    await new Promise(resolve => setTimeout(resolve, 10000));

    // Perform the upgrade
    console.log("\n🚀 Upgrading RestAI...");
    const upgradedContract = await upgrades.upgradeProxy(
      PROXY_ADDRESS,
      RestAIV2,
      {
        kind: "uups",
        call: {
          fn: "version",
          args: []
        }
      }
    ) as unknown as RestAI;

    await upgradedContract.waitForDeployment();
    const newImpl = await upgrades.erc1967.getImplementationAddress(PROXY_ADDRESS);

    console.log("✅ Upgrade completed!");
    console.log("📍 New Implementation:", newImpl);

    // Verify the upgrade
    console.log("\n🔍 Verifying upgraded contract...");
    const upgradedName = await upgradedContract.name();
    const upgradedSymbol = await upgradedContract.symbol();
    const upgradedTotalSupply = await upgradedContract.totalSupply();
    const upgradedIsLaunched = await upgradedContract.isLaunched();

    console.log("✅ Upgraded Contract Info:");
    console.log(`  - Name: ${upgradedName}`);
    console.log(`  - Symbol: ${upgradedSymbol}`);
    console.log(`  - Total Supply: ${ethers.formatEther(upgradedTotalSupply)}`);
    console.log(`  - Is Launched: ${upgradedIsLaunched}`);

    // Verify state preservation
    if (name === upgradedName && symbol === upgradedSymbol && totalSupply === upgradedTotalSupply) {
      console.log("\n✅ State preservation verified - all data intact!");
    } else {
      console.log("\n⚠️  Warning: Some state values appear different!");
    }

    console.log("\n" + "=".repeat(60));
    console.log("🎉 RestAI Successfully Upgraded!");
    console.log("=".repeat(60));
    console.log("Next steps:");
    console.log("1. Test all contract functions");
    console.log("2. Verify on block explorer");
    console.log("3. Update any dependent systems");
    console.log("4. Monitor for any issues");

    // Save upgrade info to file
    const fs = await import("fs");
    const upgradeInfo = {
      timestamp: new Date().toISOString(),
      network: (await ethers.provider.getNetwork()).name,
      proxy: PROXY_ADDRESS,
      oldImplementation: currentImpl,
      newImplementation: newImpl,
      deployer: deployer.address
    };

    const fileName = `upgrade-restai-${Date.now()}.json`;
    await fs.promises.writeFile(
      fileName,
      JSON.stringify(upgradeInfo, null, 2)
    );
    console.log(`\n📄 Upgrade info saved to: ${fileName}`);

  } catch (error) {
    console.error("\n❌ Upgrade failed:", error);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });