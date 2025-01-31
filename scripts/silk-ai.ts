import { ethers, upgrades } from "hardhat";

async function main() {
    // get delpoyer wallet client
    // const [deployer] = await ethers.getSigners()
    const ownerAddress = "0xCA3dCEA220e5b7f802A1D48350001d982f451114";
    const token = await ethers.getContractFactory("SilkAI");
    const deployedToken = await upgrades.deployProxy(token, [ownerAddress], { kind: 'uups' });

    await deployedToken.waitForDeployment();
    console.log(`Deployed token to ${await deployedToken.getAddress()}`);
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});