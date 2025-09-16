import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { BonkAI } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { parseEther } from "ethers";

describe("Debug Trading", function () {
  let bonkAI: BonkAI;
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let treasuryWallet: SignerWithAddress;

  const ROUTER_ADDRESS = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24";
  const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";
  const TOTAL_SUPPLY = parseEther("1000000000");
  const LAUNCH_TOKENS = parseEther("500000000");
  const LAUNCH_ETH = parseEther("2");

  beforeEach(async function () {
    [owner, user1, treasuryWallet] = await ethers.getSigners();

    // Deploy and launch
    const BonkAI = await ethers.getContractFactory("BonkAI");
    bonkAI = await upgrades.deployProxy(
      BonkAI,
      [treasuryWallet.address],
      { initializer: "initialize" }
    ) as unknown as BonkAI;
    await bonkAI.waitForDeployment();

    // Launch the token
    await bonkAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
  });

  it("Should check contract state after launch", async function () {
    console.log("Is launched:", await bonkAI.isLaunched());
    console.log("Is paused:", await bonkAI.paused());
    console.log("Swap pair:", await bonkAI.swapPair());

    const pair = await bonkAI.swapPair();
    console.log("Is pair AMM:", await bonkAI.automatedMarketMakerPairs(pair));

    // Check if user can transfer
    await bonkAI.transfer(user1.address, parseEther("100"));
    console.log("User1 balance:", ethers.formatEther(await bonkAI.balanceOf(user1.address)));

    // Check if pair can transfer to user (simulating buy)
    await bonkAI.transfer(pair, parseEther("1000"));

    // Connect as pair and transfer to user (this is what Uniswap does)
    await ethers.provider.send("hardhat_impersonateAccount", [pair]);
    const pairSigner = await ethers.getSigner(pair);
    await owner.sendTransaction({ to: pair, value: parseEther("1") }); // Fund for gas

    const bonkAIAsPair = bonkAI.connect(pairSigner);
    await bonkAIAsPair.transfer(user1.address, parseEther("100"));

    console.log("Transfer from pair succeeded!");
  });
});