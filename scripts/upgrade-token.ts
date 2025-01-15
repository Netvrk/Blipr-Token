import { ethers, upgrades } from "hardhat";

async function main() {
    const proxyAddress = "0x6251fD098A719c6b69b3DFdC95bfA9f0FA2F4A05";
    const NewImplementation = await ethers.getContractFactory("Basic");

    console.log("Upgrading Token...");
    const upgraded = await upgrades.upgradeProxy(proxyAddress, NewImplementation);
    await upgraded.waitForDeployment();

    console.log(`Token upgraded to new implementation at ${await upgraded.getAddress()}`);
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});