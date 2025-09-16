import { ethers, upgrades } from "hardhat";

async function main() {
  // get delpoyer wallet client
  // const [deployer] = await ethers.getSigners()
  const treasuryAddress = "0x9bE24EB303DdD438bAD2869D18bb9926605D7A41";
  const token = await ethers.getContractFactory("BonkAI");

  // Increase gas limit for deployment
  const deployedToken = await upgrades.deployProxy(token, [treasuryAddress], {
    kind: "uups",
    initializer: "initialize",
  });

  await deployedToken.waitForDeployment();
  console.log(`Deployed token to ${await deployedToken.getAddress()}`);
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
