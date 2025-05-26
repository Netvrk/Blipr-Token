import { ethers, upgrades } from "hardhat";

async function main() {
    // get delpoyer wallet client
    // const [deployer] = await ethers.getSigners()
    const ownerAddress = "0x9bE24EB303DdD438bAD2869D18bb9926605D7A41";
    const operationAddress = "0x5653510308a68809b36807990DEFd127e4141561";
    const token = await ethers.getContractFactory("BonkAI");
    
    // Increase gas limit for deployment
    const deployedToken = await upgrades.deployProxy(
        token, 
        [ownerAddress, operationAddress], 
        { 
            kind: 'uups',
            initializer: 'initialize',
        }
    );

    await deployedToken.waitForDeployment();
    console.log(`Deployed token to ${await deployedToken.getAddress()}`);
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
