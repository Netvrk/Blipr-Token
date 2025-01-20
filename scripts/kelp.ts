import { ethers, upgrades } from "hardhat";

async function main() {
    // get delpoyer wallet client
    // const [deployer] = await ethers.getSigners()
    const token = await ethers.getContractFactory("Kelp");
    const deployedToken = await upgrades.deployProxy(token, [], { kind: 'uups' });

    await deployedToken.waitForDeployment();
    console.log(`Deployed token to ${await deployedToken.getAddress()}`);
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});