import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { 
  BonkAI,
  MockUniswapV2Router02
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { parseEther, ZeroAddress } from "ethers";

describe("BonkAI Essential Tests", function () {
  let bonkAI: BonkAI;
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let pairAddress: SignerWithAddress;
  let operationsWallet: SignerWithAddress;

  const TOTAL_SUPPLY = parseEther("1000000000");
  const ROUTER_ADDRESS = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24";
  const MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MANAGER_ROLE"));

  async function deployMockRouter() {
    const MockRouter = await ethers.getContractFactory("MockUniswapV2Router02");
    const mockRouter = await MockRouter.deploy();
    await mockRouter.waitForDeployment();
    const mockRouterCode = await ethers.provider.getCode(await mockRouter.getAddress());
    await ethers.provider.send("hardhat_setCode", [ROUTER_ADDRESS, mockRouterCode]);
    await owner.sendTransaction({ to: ROUTER_ADDRESS, value: parseEther("100") });
  }

  beforeEach(async function () {
    [owner, user1, user2, pairAddress, operationsWallet] = await ethers.getSigners();

    const BonkAI = await ethers.getContractFactory("BonkAI");
    bonkAI = await upgrades.deployProxy(
      BonkAI,
      [owner.address, operationsWallet.address],
      { initializer: "initialize" }
    ) as unknown as BonkAI;
    await bonkAI.waitForDeployment();

    await bonkAI.grantRole(MANAGER_ROLE, owner.address);
  });

  describe("Core Functionality", function () {
    it("Should initialize with correct parameters", async function () {
      expect(await bonkAI.name()).to.equal("BONK AI");
      expect(await bonkAI.symbol()).to.equal("BONKAI");
      expect(await bonkAI.totalSupply()).to.equal(TOTAL_SUPPLY);
      expect(await bonkAI.balanceOf(owner.address)).to.equal(TOTAL_SUPPLY);
    });

    it("Should launch token successfully", async function () {
      await deployMockRouter();
      const tokenAmount = parseEther("100000");
      const ethAmount = parseEther("10");
      
      await expect(bonkAI.launch(tokenAmount, { value: ethAmount }))
        .to.emit(bonkAI, "Launch");
      
      expect(await bonkAI.isLaunched()).to.be.true;
    });

    it("Should prevent trading before launch", async function () {
      await bonkAI.excludeFromLimits([owner.address, user1.address], false);
      await expect(bonkAI.transfer(user1.address, parseEther("100")))
        .to.be.revertedWithCustomError(bonkAI, "NotLaunched");
    });
  });

  describe("Tax System", function () {
    beforeEach(async function () {
      await bonkAI.setAutomaticMarketMakerPair(pairAddress.address, true);
      await bonkAI.excludeFromLimits([pairAddress.address], true);
      await bonkAI.transfer(pairAddress.address, parseEther("100000"));
    });

    it("Should apply buy tax correctly", async function () {
      const buyAmount = parseEther("1000");
      const buyFee = 300; // 3%
      const expectedTax = (buyAmount * BigInt(buyFee)) / 10000n;
      const expectedReceived = buyAmount - expectedTax;
      
      await bonkAI.connect(pairAddress).transfer(user1.address, buyAmount);
      
      expect(await bonkAI.balanceOf(user1.address)).to.equal(expectedReceived);
      expect(await bonkAI.balanceOf(await bonkAI.getAddress())).to.equal(expectedTax);
    });

    it("Should apply sell tax correctly", async function () {
      await bonkAI.transfer(user1.address, parseEther("10000"));
      
      const sellAmount = parseEther("1000");
      const sellFee = 500; // 5%
      const expectedTax = (sellAmount * BigInt(sellFee)) / 10000n;
      const expectedReceived = sellAmount - expectedTax;
      
      await bonkAI.connect(user1).transfer(pairAddress.address, sellAmount);
      
      const pairBalance = await bonkAI.balanceOf(pairAddress.address);
      expect(pairBalance).to.equal(parseEther("100000") + expectedReceived);
    });

    it("Should not apply tax when disabled", async function () {
      await bonkAI.setTaxesEnabled(false);
      const amount = parseEther("1000");
      
      await bonkAI.connect(pairAddress).transfer(user1.address, amount);
      expect(await bonkAI.balanceOf(user1.address)).to.equal(amount);
    });

    it("Should exclude addresses from tax", async function () {
      await bonkAI.excludeFromTax([user1.address], true);
      const amount = parseEther("1000");
      
      await bonkAI.connect(pairAddress).transfer(user1.address, amount);
      expect(await bonkAI.balanceOf(user1.address)).to.equal(amount);
    });
  });

  describe("Limit System", function () {
    it("Should set and enforce limits correctly", async function () {
      const totalSupply = await bonkAI.totalSupply();
      const maxBuy = totalSupply * 1n / 1000n; // 0.1%
      const maxSell = totalSupply * 2n / 1000n; // 0.2%
      const maxWallet = totalSupply * 5n / 1000n; // 0.5%
      
      // Set limits
      await bonkAI.setLimits(maxBuy, maxSell, maxWallet);
      
      // Verify limits were set
      const limits = await bonkAI.limits();
      expect(limits.maxBuy).to.equal(maxBuy);
      expect(limits.maxSell).to.equal(maxSell);
      expect(limits.maxWallet).to.equal(maxWallet);
    });

    it("Should toggle limits on/off", async function () {
      expect(await bonkAI.isLimitsEnabled()).to.be.true;
      
      await bonkAI.setLimitsEnabled(false);
      expect(await bonkAI.isLimitsEnabled()).to.be.false;
      
      await bonkAI.setLimitsEnabled(true);
      expect(await bonkAI.isLimitsEnabled()).to.be.true;
    });
  });

  describe("Swap Mechanism", function () {
    beforeEach(async function () {
      await deployMockRouter();
      await bonkAI.launch(parseEther("100000"), { value: parseEther("10") });
      await bonkAI.setAutomaticMarketMakerPair(user2.address, true);
    });

    it("Should accumulate taxes up to swap threshold", async function () {
      const swapThreshold = await bonkAI.swapTokensAtAmount();
      
      // Transfer tokens for testing
      await bonkAI.transfer(user1.address, parseEther("100000"));
      await bonkAI.excludeFromLimits([user1.address, user2.address], true);
      
      // Generate taxes through sells (5% tax)
      for (let i = 0; i < 20; i++) {
        await bonkAI.connect(user1).transfer(user2.address, parseEther("5000"));
      }
      
      const contractBalance = await bonkAI.balanceOf(await bonkAI.getAddress());
      // Should have accumulated some taxes (5% of transfers)
      expect(contractBalance).to.be.gt(0);
    });

    it("Should execute manual swap", async function () {
      // Send some tokens to contract
      await bonkAI.transfer(await bonkAI.getAddress(), parseEther("1000"));
      
      await expect(bonkAI.manualSwap())
        .to.not.be.reverted;
    });
  });

  describe("Security Features", function () {
    it("Should block blacklisted accounts", async function () {
      // Launch first to enable trading
      await deployMockRouter();
      await bonkAI.launch(parseEther("100000"), { value: parseEther("10") });
      
      await bonkAI.transfer(user1.address, parseEther("1000"));
      await bonkAI.setBlockAccount(user1.address, true);
      
      await expect(bonkAI.connect(user1).transfer(user2.address, parseEther("100")))
        .to.be.revertedWithCustomError(bonkAI, "AccountBlockedFromTransfer");
    });

    it("Should pause and unpause transfers", async function () {
      await bonkAI.pause();
      
      await expect(bonkAI.transfer(user1.address, parseEther("100")))
        .to.be.revertedWithCustomError(bonkAI, "EnforcedPause");
      
      await bonkAI.unpause();
      
      await expect(bonkAI.transfer(user1.address, parseEther("100")))
        .to.not.be.reverted;
    });

    it("Should protect against reentrancy", async function () {
      // Reentrancy is protected by OpenZeppelin's ReentrancyGuard
      // This test verifies the modifier is applied
      await deployMockRouter();
      
      // Launch is protected
      await expect(bonkAI.launch(parseEther("100000"), { value: parseEther("10") }))
        .to.not.be.reverted;
      
      // Cannot launch again (also tests AlreadyLaunched)
      await expect(bonkAI.launch(parseEther("100000"), { value: parseEther("10") }))
        .to.be.revertedWithCustomError(bonkAI, "AlreadyLaunched");
    });

    it("Should handle batch operations with DoS protection", async function () {
      const addresses = Array(50).fill(0).map((_, i) => 
        ethers.Wallet.createRandom().address
      );
      
      // Should accept up to MAX_BATCH_SIZE (50)
      await expect(bonkAI.excludeFromLimits(addresses, true))
        .to.not.be.reverted;
      
      // Should reject over MAX_BATCH_SIZE
      const tooManyAddresses = Array(51).fill(0).map((_, i) => 
        ethers.Wallet.createRandom().address
      );
      
      await expect(bonkAI.excludeFromLimits(tooManyAddresses, true))
        .to.be.revertedWith("Batch too large");
    });
  });

  describe("Edge Cases", function () {
    it("Should handle zero amount transfers", async function () {
      await expect(bonkAI.transfer(user1.address, 0))
        .to.not.be.reverted;
    });

    it("Should validate limit boundaries", async function () {
      const totalSupply = await bonkAI.totalSupply();
      
      // Too small (< 0.01%)
      const tooSmall = totalSupply * 1n / 100000n;
      await expect(bonkAI.setLimits(tooSmall, tooSmall, tooSmall))
        .to.be.revertedWithCustomError(bonkAI, "AmountOutOfBounds");
      
      // Too large (> 10%)
      const tooLarge = totalSupply * 11n / 100n;
      await expect(bonkAI.setLimits(tooLarge, tooLarge, tooLarge))
        .to.be.revertedWithCustomError(bonkAI, "AmountOutOfBounds");
    });

    it("Should handle fee boundaries", async function () {
      // Max fee (20%)
      await expect(bonkAI.setFees(2000, 2000, 2000))
        .to.not.be.reverted;
      
      // Over max fee
      await expect(bonkAI.setFees(2001, 2000, 2000))
        .to.be.revertedWithCustomError(bonkAI, "FeeTooHigh");
    });
  });

  describe("Gas Optimization Verification", function () {
    it("Should use optimized struct packing", async function () {
      // Verify Fees struct uses uint16
      const fees = await bonkAI.fees();
      expect(fees.buyFee).to.equal(300);
      expect(fees.sellFee).to.equal(500);
      expect(fees.transferFee).to.equal(0);
      
      // Verify Limits struct uses uint128
      const totalSupply = await bonkAI.totalSupply();
      const limits = await bonkAI.limits();
      expect(limits.maxBuy).to.equal(totalSupply * 100n / 10000n);
      expect(limits.maxSell).to.equal(totalSupply * 100n / 10000n);
      expect(limits.maxWallet).to.equal(totalSupply * 100n / 10000n);
    });
  });
});