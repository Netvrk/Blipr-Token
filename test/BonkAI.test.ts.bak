import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { BonkAI } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { parseEther } from "ethers";

describe("BonkAI Real-World Tests", function () {
  let bonkAI: BonkAI;
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let treasuryWallet: SignerWithAddress;

  // Base mainnet addresses
  const ROUTER_ADDRESS = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24"; // Base Uniswap V2 Router
  const WETH_ADDRESS = "0x4200000000000000000000000000000000000006"; // Base WETH

  const TOTAL_SUPPLY = parseEther("1000000000"); // 1 billion tokens
  const LAUNCH_TOKENS = parseEther("500000000"); // 500M tokens for liquidity (50%)
  const LAUNCH_ETH = parseEther("2"); // 2 ETH for initial liquidity

  beforeEach(async function () {
    [owner, user1, user2, treasuryWallet] = await ethers.getSigners();

    // Deploy BonkAI
    const BonkAI = await ethers.getContractFactory("BonkAI");
    bonkAI = await upgrades.deployProxy(
      BonkAI,
      [treasuryWallet.address],
      { initializer: "initialize" }
    ) as unknown as BonkAI;
    await bonkAI.waitForDeployment();
  });

  describe("1. Deployment", function () {
    it("Should deploy with correct initial state", async function () {
      expect(await bonkAI.name()).to.equal("BONK AI");
      expect(await bonkAI.symbol()).to.equal("BONKAI");
      expect(await bonkAI.totalSupply()).to.equal(TOTAL_SUPPLY);

      // Owner should have all tokens
      expect(await bonkAI.balanceOf(owner.address)).to.equal(TOTAL_SUPPLY);

      // Should not be launched yet
      expect(await bonkAI.isLaunched()).to.be.false;
    });
  });

  describe("2. Launch (Add Liquidity)", function () {
    it("Should launch successfully and create Uniswap pair", async function () {
      // Check pre-launch state
      const ownerBalanceBefore = await bonkAI.balanceOf(owner.address);
      expect(ownerBalanceBefore).to.equal(TOTAL_SUPPLY);

      // Launch the token
      const tx = await bonkAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
      await tx.wait();

      // Verify launch succeeded
      expect(await bonkAI.isLaunched()).to.be.true;

      // Check that pair was created
      const swapPair = await (bonkAI as any).swapPair();
      expect(swapPair).to.not.equal(ethers.ZeroAddress);

      // Verify owner's balance decreased by launch amount
      const ownerBalanceAfter = await bonkAI.balanceOf(owner.address);
      expect(ownerBalanceAfter).to.equal(TOTAL_SUPPLY - LAUNCH_TOKENS);

      // Check that LP tokens were sent to treasury
      const pairContract = await ethers.getContractAt("IERC20", swapPair);
      const treasuryLPBalance = await pairContract.balanceOf(treasuryWallet.address);
      expect(treasuryLPBalance).to.be.gt(0);

      // Emit Launch event
      expect(tx).to.emit(bonkAI, "Launch");
    });

    it("Should not allow launching twice", async function () {
      // First launch
      await bonkAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });

      // Second launch should fail
      await expect(
        bonkAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH })
      ).to.be.revertedWith("Already launched");
    });
  });

  describe("3. Trading (Buy/Sell with Tax)", function () {
    beforeEach(async function () {
      // Launch the token first
      await bonkAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
    });

    it("Should allow buying tokens from Uniswap", async function () {
      const router = await ethers.getContractAt(
        ["function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable"],
        ROUTER_ADDRESS
      );

      const buyAmount = parseEther("0.1");
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      // User1 buys tokens
      const balanceBefore = await bonkAI.balanceOf(user1.address);

      await (router as any).connect(user1).swapExactETHForTokensSupportingFeeOnTransferTokens(
        0, // Accept any amount of tokens
        [WETH_ADDRESS, await bonkAI.getAddress()],
        user1.address,
        deadline,
        { value: buyAmount }
      );

      const balanceAfter = await bonkAI.balanceOf(user1.address);
      expect(balanceAfter).to.be.gt(balanceBefore);

      // Verify buy tax was applied (3% default)
      const contractBalance = await bonkAI.balanceOf(await bonkAI.getAddress());
      expect(contractBalance).to.be.gt(0); // Contract should have collected tax
    });

    it("Should allow selling tokens to Uniswap", async function () {
      const router = await ethers.getContractAt(
        [
          "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable",
          "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)"
        ],
        ROUTER_ADDRESS
      );

      // First, user1 buys some tokens
      const buyAmount = parseEther("0.5");
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      await (router as any).connect(user1).swapExactETHForTokensSupportingFeeOnTransferTokens(
        0,
        [WETH_ADDRESS, await bonkAI.getAddress()],
        user1.address,
        deadline,
        { value: buyAmount }
      );

      const tokensReceived = await bonkAI.balanceOf(user1.address);
      expect(tokensReceived).to.be.gt(0);

      // Approve router to spend tokens
      await bonkAI.connect(user1).approve(ROUTER_ADDRESS, tokensReceived);

      // Sell half of the tokens
      const sellAmount = tokensReceived / 2n;
      const ethBalanceBefore = await ethers.provider.getBalance(user1.address);

      await (router as any).connect(user1).swapExactTokensForETHSupportingFeeOnTransferTokens(
        sellAmount,
        0, // Accept any amount of ETH
        [await bonkAI.getAddress(), WETH_ADDRESS],
        user1.address,
        deadline
      );

      const ethBalanceAfter = await ethers.provider.getBalance(user1.address);
      expect(ethBalanceAfter).to.be.gt(ethBalanceBefore);

      // Verify sell tax was applied (5% default)
      const contractBalance = await bonkAI.balanceOf(await bonkAI.getAddress());
      expect(contractBalance).to.be.gt(0); // Contract should have more tax collected
    });
  });

  describe("4. Swap Back (Tax to ETH)", function () {
    beforeEach(async function () {
      // Launch the token
      await bonkAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
    });

    it("Should automatically swap tax tokens to ETH when threshold is met", async function () {
      const router = await ethers.getContractAt(
        ["function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable"],
        ROUTER_ADDRESS
      );

      // Get swap threshold
      const swapThreshold = await bonkAI.swapTokensAtAmount();

      // Perform multiple buys to accumulate tax
      const buyAmount = parseEther("1");
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      // Do multiple buys to trigger swap back
      for (let i = 0; i < 5; i++) {
        await (router as any).connect(user1).swapExactETHForTokensSupportingFeeOnTransferTokens(
          0,
          [WETH_ADDRESS, await bonkAI.getAddress()],
          user1.address,
          deadline,
          { value: buyAmount }
        );

        const contractBalance = await bonkAI.balanceOf(await bonkAI.getAddress());

        // Check if swap back should trigger
        if (contractBalance >= swapThreshold) {
          // Next sell should trigger swap back
          const treasuryETHBefore = await ethers.provider.getBalance(treasuryWallet.address);

          // Small transfer to trigger swap back
          await bonkAI.connect(user1).transfer(user2.address, parseEther("100"));

          const treasuryETHAfter = await ethers.provider.getBalance(treasuryWallet.address);

          // Treasury should have received ETH from swap back
          expect(treasuryETHAfter).to.be.gt(treasuryETHBefore);
          break;
        }
      }
    });
  });

  describe("5. Emergency Functions", function () {
    beforeEach(async function () {
      await bonkAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
    });

    it("Should allow owner to withdraw stuck tokens", async function () {
      // Send some tokens to contract (simulate stuck tokens)
      const stuckAmount = parseEther("1000");
      await bonkAI.transfer(await bonkAI.getAddress(), stuckAmount);

      const contractBalanceBefore = await bonkAI.balanceOf(await bonkAI.getAddress());
      expect(contractBalanceBefore).to.be.gte(stuckAmount);

      // Withdraw stuck tokens
      const ownerBalanceBefore = await bonkAI.balanceOf(owner.address);
      await bonkAI.withdrawTokens(await bonkAI.getAddress());

      const ownerBalanceAfter = await bonkAI.balanceOf(owner.address);
      expect(ownerBalanceAfter).to.be.gt(ownerBalanceBefore);

      // Contract should have no tokens left (or just tax)
      const contractBalanceAfter = await bonkAI.balanceOf(await bonkAI.getAddress());
      expect(contractBalanceAfter).to.equal(0);
    });

    it("Should allow owner to withdraw stuck ETH", async function () {
      // Send ETH directly to contract
      const stuckETH = parseEther("0.5");
      await owner.sendTransaction({
        to: await bonkAI.getAddress(),
        value: stuckETH
      });

      const contractETHBefore = await ethers.provider.getBalance(await bonkAI.getAddress());
      expect(contractETHBefore).to.be.gte(stuckETH);

      // Withdraw stuck ETH
      const ownerETHBefore = await ethers.provider.getBalance(owner.address);
      const tx = await bonkAI.withdrawTokens(ethers.ZeroAddress);
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

      const ownerETHAfter = await ethers.provider.getBalance(owner.address);
      expect(ownerETHAfter).to.be.gt(ownerETHBefore - gasUsed);

      // Contract should have no ETH left
      const contractETHAfter = await ethers.provider.getBalance(await bonkAI.getAddress());
      expect(contractETHAfter).to.equal(0);
    });

    it("Should allow pausing in emergency", async function () {
      // Pause the contract
      await bonkAI.pause();
      expect(await bonkAI.paused()).to.be.true;

      // Transfers should fail
      await expect(
        bonkAI.transfer(user1.address, parseEther("100"))
      ).to.be.revertedWith("Pausable: paused");

      // Unpause
      await bonkAI.unpause();
      expect(await bonkAI.paused()).to.be.false;

      // Transfers should work again
      await bonkAI.transfer(user1.address, parseEther("100"));
      expect(await bonkAI.balanceOf(user1.address)).to.equal(parseEther("100"));
    });
  });

  describe("6. Limits and Anti-Bot", function () {
    beforeEach(async function () {
      await bonkAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
    });

    it("Should enforce transaction limits", async function () {
      // Limits are enabled by default (1% max buy/sell/wallet)
      const maxBuy = TOTAL_SUPPLY / 100n; // 1% = 10M tokens

      // Try to transfer more than max wallet
      await expect(
        bonkAI.transfer(user1.address, maxBuy + parseEther("1"))
      ).to.be.reverted;

      // Should work with amount under limit
      await bonkAI.transfer(user1.address, maxBuy / 2n);
      expect(await bonkAI.balanceOf(user1.address)).to.equal(maxBuy / 2n);
    });

    it("Should allow disabling limits after launch", async function () {
      const largeAmount = TOTAL_SUPPLY / 10n; // 10% of supply

      // Should fail with limits
      await expect(
        bonkAI.transfer(user1.address, largeAmount)
      ).to.be.reverted;

      // Disable limits
      await bonkAI.setLimitsEnabled(false);

      // Should work now
      await bonkAI.transfer(user1.address, largeAmount);
      expect(await bonkAI.balanceOf(user1.address)).to.equal(largeAmount);
    });
  });
});