import { ethers, upgrades } from "hardhat";

async function main() {
    // get delpoyer wallet client
    // const [deployer] = await ethers.getSigners()
    const operationsWallet = "0x57291FE9b6dC5bBeF1451c4789d4e578ce956219"
    const token = await ethers.getContractFactory("CenterFruit");
    const deployedToken = await upgrades.deployProxy(token, [operationsWallet], { kind: 'uups' });

    await deployedToken.waitForDeployment();
    console.log(`Deployed token to ${await deployedToken.getAddress()}`);
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});