import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { RestAI } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { parseEther } from "ethers";

describe("RestAI Real-World Tests", function () {
  let restAI: RestAI;
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let operationsWallet: SignerWithAddress;

  // Base mainnet addresses
  const ROUTER_ADDRESS = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24"; // Base Uniswap V2 Router
  const WETH_ADDRESS = "0x4200000000000000000000000000000000000006"; // Base WETH

  const TOTAL_SUPPLY = parseEther("1000000000"); // 1 billion tokens
  const LAUNCH_TOKENS = parseEther("500000000"); // 500M tokens for liquidity (50%)
  const LAUNCH_ETH = parseEther("2"); // 2 ETH for initial liquidity

  beforeEach(async function () {
    [owner, user1, user2, operationsWallet] = await ethers.getSigners();

    // Deploy RestAI
    const RestAI = await ethers.getContractFactory("RestAI");
    restAI = await upgrades.deployProxy(
      RestAI,
      [owner.address, operationsWallet.address],
      { initializer: "initialize" }
    ) as unknown as RestAI;
    await restAI.waitForDeployment();
  });

  describe("1. Deployment", function () {
    it("Should deploy with correct initial state", async function () {
      expect(await restAI.name()).to.equal("Rest AI");
      expect(await restAI.symbol()).to.equal("RestAI");
      expect(await restAI.totalSupply()).to.equal(TOTAL_SUPPLY);

      // Owner should have all tokens
      expect(await restAI.balanceOf(owner.address)).to.equal(TOTAL_SUPPLY);

      // Should not be launched yet
      expect(await restAI.isLaunched()).to.be.false;
    });
  });

  describe("2. Launch (Add Liquidity)", function () {
    it("Should launch successfully and create Uniswap pair", async function () {
      // Check pre-launch state
      const ownerBalanceBefore = await restAI.balanceOf(owner.address);
      expect(ownerBalanceBefore).to.equal(TOTAL_SUPPLY);

      // Launch the token
      const tx = await restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
      await tx.wait();

      // Verify launch succeeded
      expect(await restAI.isLaunched()).to.be.true;

      // Verify owner's balance decreased by launch amount
      const ownerBalanceAfter = await restAI.balanceOf(owner.address);
      expect(ownerBalanceAfter).to.equal(TOTAL_SUPPLY - LAUNCH_TOKENS);

      // Emit Launch event
      expect(tx).to.emit(restAI, "Launch");
    });

    it("Should not allow launching twice", async function () {
      // First launch
      await restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });

      // Second launch should fail
      await expect(
        restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH })
      ).to.be.revertedWithCustomError(restAI, "AlreadyLaunched");
    });
  });

  describe("3. Trading (Buy/Sell with Tax)", function () {
    beforeEach(async function () {
      // Launch the token first
      await restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
    });

    it("Should allow transfers after launch", async function () {
      const transferAmount = parseEther("1000");

      // Transfer from owner to user1
      await restAI.transfer(user1.address, transferAmount);
      expect(await restAI.balanceOf(user1.address)).to.equal(transferAmount);

      // Transfer from user1 to user2
      await restAI.connect(user1).transfer(user2.address, transferAmount / 2n);
      expect(await restAI.balanceOf(user2.address)).to.equal(transferAmount / 2n);
    });

    it("Should apply transfer tax when enabled", async function () {
      // Set transfer fee to 1%
      await restAI.setFees(300, 500, 100); // 3% buy, 5% sell, 1% transfer

      const transferAmount = parseEther("10000");
      const expectedTax = transferAmount * 100n / 10000n; // 1%
      const expectedReceived = transferAmount - expectedTax;

      // Give user1 some tokens
      await restAI.transfer(user1.address, transferAmount);

      // Transfer from user1 to user2 with tax
      await restAI.connect(user1).transfer(user2.address, transferAmount);

      // Check tax was collected
      expect(await restAI.balanceOf(user2.address)).to.equal(expectedReceived);
      const contractBalance = await restAI.balanceOf(await restAI.getAddress());
      expect(contractBalance).to.be.gte(expectedTax);
    });
  });

  describe("4. Tax Management", function () {
    beforeEach(async function () {
      await restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
    });

    it("Should update buy/sell/transfer fees", async function () {
      // Set new fees
      await restAI.setFees(100, 200, 50); // 1% buy, 2% sell, 0.5% transfer

      const fees = await restAI.fees();
      expect(fees.buyFee).to.equal(100);
      expect(fees.sellFee).to.equal(200);
      expect(fees.transferFee).to.equal(50);
    });

    it("Should toggle tax on/off", async function () {
      // Disable taxes
      await restAI.setTaxesEnabled(false);
      expect(await restAI.isTaxEnabled()).to.be.false;

      // Enable taxes
      await restAI.setTaxesEnabled(true);
      expect(await restAI.isTaxEnabled()).to.be.true;
    });

    it("Should exclude addresses from tax", async function () {
      // Exclude user1 from taxes
      await restAI.excludeFromTax([user1.address], true);
      expect(await restAI.isExcludedFromTax(user1.address)).to.be.true;

      // Include user1 back in taxes
      await restAI.excludeFromTax([user1.address], false);
      expect(await restAI.isExcludedFromTax(user1.address)).to.be.false;
    });
  });

  describe("5. Limit Management", function () {
    beforeEach(async function () {
      await restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
    });

    it("Should update max buy/sell/wallet limits", async function () {
      const newMaxBuy = TOTAL_SUPPLY * 200n / 10000n; // 2%
      const newMaxSell = TOTAL_SUPPLY * 300n / 10000n; // 3%
      const newMaxWallet = TOTAL_SUPPLY * 500n / 10000n; // 5%

      await restAI.setLimits(newMaxBuy, newMaxSell, newMaxWallet);

      const limits = await restAI.limits();
      expect(limits.maxBuy).to.equal(newMaxBuy);
      expect(limits.maxSell).to.equal(newMaxSell);
      expect(limits.maxWallet).to.equal(newMaxWallet);
    });

    it("Should toggle limits on/off", async function () {
      // Disable limits
      await restAI.setLimitsEnabled(false);
      expect(await restAI.isLimitsEnabled()).to.be.false;

      // Enable limits
      await restAI.setLimitsEnabled(true);
      expect(await restAI.isLimitsEnabled()).to.be.true;
    });

    it("Should exclude addresses from limits", async function () {
      // Exclude user1 from limits
      await restAI.excludeFromLimits([user1.address], true);
      expect(await restAI.isExcludedFromLimits(user1.address)).to.be.true;

      // Include user1 back in limits
      await restAI.excludeFromLimits([user1.address], false);
      expect(await restAI.isExcludedFromLimits(user1.address)).to.be.false;
    });
  });

  describe("6. Blacklist", function () {
    beforeEach(async function () {
      await restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
    });

    it("Should block and unblock accounts", async function () {
      // Give user1 tokens first
      await restAI.transfer(user1.address, parseEther("1000"));

      // Block user1
      await restAI.setBlockAccount(user1.address, true);
      expect(await restAI.isBlocked(user1.address)).to.be.true;

      // User1 cannot transfer when blocked
      await expect(
        restAI.connect(user1).transfer(user2.address, parseEther("100"))
      ).to.be.revertedWithCustomError(restAI, "AccountBlockedFromTransfer");

      // Unblock user1
      await restAI.setBlockAccount(user1.address, false);
      expect(await restAI.isBlocked(user1.address)).to.be.false;

      // Now user1 can transfer
      await restAI.connect(user1).transfer(user2.address, parseEther("100"));
      expect(await restAI.balanceOf(user2.address)).to.equal(parseEther("100"));
    });
  });

  describe("7. Swap Settings", function () {
    beforeEach(async function () {
      await restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
    });

    it("Should update swap threshold", async function () {
      const newThreshold = TOTAL_SUPPLY * 10n / 10000n; // 0.1%

      await restAI.setTokensForSwap(newThreshold);
      expect(await restAI.swapTokensAtAmount()).to.equal(newThreshold);
    });

    it("Should allow manual swap", async function () {
      // Send tokens to contract to simulate tax collection
      await restAI.transfer(await restAI.getAddress(), parseEther("1000"));

      // Manual swap should not revert
      await expect(restAI.manualSwap()).to.not.be.reverted;
    });
  });

  describe("8. Pause Functionality", function () {
    beforeEach(async function () {
      await restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
    });

    it("Should pause and unpause transfers", async function () {
      // Pause
      await restAI.pause();

      // Transfers should fail when paused
      await expect(
        restAI.transfer(user1.address, parseEther("100"))
      ).to.be.revertedWithCustomError(restAI, "EnforcedPause");

      // Unpause
      await restAI.unpause();

      // Transfers should work again
      await restAI.transfer(user1.address, parseEther("100"));
      expect(await restAI.balanceOf(user1.address)).to.equal(parseEther("100"));
    });
  });

  describe("9. Emergency Withdraw", function () {
    beforeEach(async function () {
      await restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
    });

    it("Should withdraw stuck tokens", async function () {
      const contractAddress = await restAI.getAddress();

      // Send tokens to contract
      await restAI.transfer(contractAddress, parseEther("1000"));

      const ownerBalanceBefore = await restAI.balanceOf(owner.address);

      // Withdraw stuck tokens
      await restAI.withdrawTokens(contractAddress);

      const ownerBalanceAfter = await restAI.balanceOf(owner.address);
      expect(ownerBalanceAfter).to.equal(ownerBalanceBefore + parseEther("1000"));
    });
  });

  describe("10. Access Control", function () {
    it("Should have correct roles set up", async function () {
      const DEFAULT_ADMIN_ROLE = await restAI.DEFAULT_ADMIN_ROLE();
      const MANAGER_ROLE = await restAI.MANAGER_ROLE();

      // Owner should have both admin and manager roles
      expect(await restAI.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
      expect(await restAI.hasRole(MANAGER_ROLE, owner.address)).to.be.true;
    });

    it("Should grant and revoke manager role", async function () {
      const MANAGER_ROLE = await restAI.MANAGER_ROLE();

      // Grant manager role to user1
      await restAI.grantRole(MANAGER_ROLE, user1.address);
      expect(await restAI.hasRole(MANAGER_ROLE, user1.address)).to.be.true;

      // User1 can now call manager functions
      await restAI.connect(user1).setLimitsEnabled(false);

      // Revoke manager role
      await restAI.revokeRole(MANAGER_ROLE, user1.address);
      expect(await restAI.hasRole(MANAGER_ROLE, user1.address)).to.be.false;

      // User1 can no longer call manager functions
      await expect(
        restAI.connect(user1).setLimitsEnabled(true)
      ).to.be.reverted;
    });
  });
});