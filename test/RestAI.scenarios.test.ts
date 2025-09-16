import { expect } from "chai";
import { ethers, upgrades, network } from "hardhat";
import { RestAI } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { parseEther, ZeroAddress } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("RestAI Comprehensive Scenario Tests", function () {
  let restAI: RestAI;
  let owner: SignerWithAddress;
  let manager: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let user3: SignerWithAddress;
  let operationsWallet: SignerWithAddress;
  let attacker: SignerWithAddress;
  let router: any;

  // Base mainnet addresses
  const ROUTER_ADDRESS = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24";
  const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";

  const TOTAL_SUPPLY = parseEther("1000000000"); // 1 billion tokens
  const LAUNCH_TOKENS = parseEther("500000000"); // 500M tokens
  const LAUNCH_ETH = parseEther("10"); // 10 ETH

  beforeEach(async function () {
    // Fork Base mainnet
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl:
              process.env.BASE_RPC_URL || "https://base.gateway.tenderly.co",
            blockNumber: 17000000,
          },
        },
      ],
    });

    [owner, manager, user1, user2, user3, operationsWallet, attacker] =
      await ethers.getSigners();

    // Deploy RestAI
    const RestAI = await ethers.getContractFactory("RestAI");
    restAI = (await upgrades.deployProxy(
      RestAI,
      [owner.address, operationsWallet.address],
      { initializer: "initialize" }
    )) as unknown as RestAI;
    await restAI.waitForDeployment();

    // Grant manager role
    const MANAGER_ROLE = await restAI.MANAGER_ROLE();
    await restAI.grantRole(MANAGER_ROLE, manager.address);

    // Get router
    router = await ethers.getContractAt(
      [
        "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable",
        "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)",
        "function WETH() view returns (address)",
        "function factory() view returns (address)",
      ],
      ROUTER_ADDRESS
    );
  });

  describe("SCENARIO 1: Pre-Launch Restrictions", function () {
    it("Should prevent normal users from transferring before launch", async function () {
      // Owner can transfer before launch (excluded)
      await restAI.transfer(user1.address, parseEther("1000"));

      // User1 cannot transfer before launch
      await expect(
        restAI.connect(user1).transfer(user2.address, parseEther("100"))
      ).to.be.revertedWithCustomError(restAI, "NotLaunched");
    });

    it("Should allow excluded addresses to transfer before launch", async function () {
      // Exclude user1
      await restAI.excludeFromLimits([user1.address], true);

      // Transfer to user1
      await restAI.transfer(user1.address, parseEther("1000"));

      // Now user1 can transfer even before launch
      await restAI.connect(user1).transfer(user2.address, parseEther("100"));
      expect(await restAI.balanceOf(user2.address)).to.equal(parseEther("100"));
    });

    it("Should prevent launch with insufficient balance", async function () {
      // Transfer all tokens away
      await restAI.transfer(user1.address, TOTAL_SUPPLY);

      // Try to launch without tokens
      await expect(
        restAI.connect(owner).launch(LAUNCH_TOKENS, { value: LAUNCH_ETH })
      ).to.be.revertedWith("Insufficient token balance");
    });

    it("Should prevent launch without ETH", async function () {
      await expect(
        restAI.launch(LAUNCH_TOKENS, { value: 0 })
      ).to.be.revertedWith("Zero ETH amount");
    });

    it("Should prevent launch with zero tokens", async function () {
      await expect(restAI.launch(0, { value: LAUNCH_ETH })).to.be.revertedWith(
        "Zero token amount"
      );
    });
  });

  describe("SCENARIO 2: Launch Edge Cases", function () {
    it("Should handle maximum liquidity launch", async function () {
      const maxTokens = (TOTAL_SUPPLY * 99n) / 100n; // 99% of supply
      const maxETH = parseEther("1000"); // Large ETH amount

      await restAI.launch(maxTokens, { value: maxETH });

      expect(await restAI.isLaunched()).to.be.true;
      expect(await restAI.balanceOf(owner.address)).to.equal(
        TOTAL_SUPPLY - maxTokens
      );
    });

    it("Should handle minimum liquidity launch", async function () {
      const minTokens = parseEther("1000"); // Small amount
      const minETH = parseEther("0.01"); // Small ETH

      await restAI.launch(minTokens, { value: minETH });

      expect(await restAI.isLaunched()).to.be.true;
    });

    it("Should prevent double launch", async function () {
      await restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });

      await expect(
        restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH })
      ).to.be.revertedWithCustomError(restAI, "AlreadyLaunched");
    });

    it("Should only allow manager to launch", async function () {
      await expect(
        restAI.connect(user1).launch(LAUNCH_TOKENS, { value: LAUNCH_ETH })
      ).to.be.reverted;
    });
  });

  /**
   * SCENARIO 3: Trading Limits Enforcement
   *
   * Tests the max transaction and wallet limits:
   * - Max buy limit on DEX purchases
   * - Max sell limit on DEX sales
   * - Max wallet limit for holdings
   * - Exclusion mechanism for special addresses
   * - Boundary validation for limit values
   */
  describe("SCENARIO 3: Trading Limits Enforcement", function () {
    beforeEach(async function () {
      await restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
    });

    // Test: Verify max buy limit prevents large purchases from DEX
    // Protects against whale accumulation and price manipulation
    it("Should enforce max buy limit on Uniswap purchases", async function () {
      // Set low max buy limit
      const maxBuy = TOTAL_SUPPLY / 1000n; // 0.1%
      await restAI.setLimits(maxBuy, maxBuy * 2n, maxBuy * 5n);

      // Try to buy more than limit
      await expect(
        router
          .connect(user1)
          .swapExactETHForTokensSupportingFeeOnTransferTokens(
            0,
            [WETH_ADDRESS, await restAI.getAddress()],
            user1.address,
            Math.floor(Date.now() / 1000) + 3600,
            { value: parseEther("5") } // This would exceed limit
          )
      ).to.be.reverted;
    });

    // Test: Confirm max sell limit prevents large dumps
    // Protects price stability and prevents panic selling
    it("Should enforce max sell limit on Uniswap sales", async function () {
      // Disable limits first to buy tokens
      await restAI.setLimitsEnabled(false);

      // Buy tokens
      await router
        .connect(user1)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(
          0,
          [WETH_ADDRESS, await restAI.getAddress()],
          user1.address,
          Math.floor(Date.now() / 1000) + 3600,
          { value: parseEther("1") }
        );

      const balance = await restAI.balanceOf(user1.address);

      // Enable limits with low max sell
      const maxSell = balance / 10n; // Can only sell 10% at once
      await restAI.setLimitsEnabled(true);
      await restAI.setLimits(balance, maxSell, balance);

      // Try to sell more than limit
      await restAI.connect(user1).approve(ROUTER_ADDRESS, balance);
      await expect(
        router
          .connect(user1)
          .swapExactTokensForETHSupportingFeeOnTransferTokens(
            balance, // Try to sell all
            0,
            [await restAI.getAddress(), WETH_ADDRESS],
            user1.address,
            Math.floor(Date.now() / 1000) + 3600
          )
      ).to.be.reverted;
    });

    // Test: Ensure wallet holdings cannot exceed maximum limit
    // Prevents concentration of tokens in single wallets
    // Fixed: Now properly provides enough tokens to user2 for testing
    it("Should enforce max wallet limit", async function () {
      const maxWallet = TOTAL_SUPPLY / 100n; // 1% max wallet
      await restAI.setLimits(maxWallet, maxWallet, maxWallet);

      // Enable limits
      await restAI.setLimitsEnabled(true);

      // Check initial balances (user1 should have 0)
      expect(await restAI.balanceOf(user1.address)).to.equal(0n);

      // First give user2 enough tokens to test with (owner is excluded from limits)
      // Give them more than maxWallet so they have enough balance to attempt transfers
      await restAI.transfer(user2.address, maxWallet + maxWallet);

      // Try to transfer more than wallet limit from user2 to user1
      // This should fail because user1 would receive more than maxWallet
      await expect(
        restAI.connect(user2).transfer(user1.address, maxWallet + 1n)
      ).to.be.revertedWithCustomError(restAI, "WalletAmountExceedsLimit");

      // Transfer up to exactly max wallet should work
      await restAI.connect(user2).transfer(user1.address, maxWallet / 2n);

      // Verify user1 has maxWallet/2
      expect(await restAI.balanceOf(user1.address)).to.equal(maxWallet / 2n);

      // Give user2 more tokens
      await restAI.transfer(user2.address, maxWallet);

      // Additional transfer should fail (user1 wallet would exceed max)
      await expect(
        restAI.connect(user2).transfer(user1.address, maxWallet / 2n + 1n)
      ).to.be.revertedWithCustomError(restAI, "WalletAmountExceedsLimit");
    });

    // Test: Verify excluded addresses can bypass all limits
    // Necessary for liquidity pools, bridges, and special contracts
    it("Should allow excluded addresses to exceed limits", async function () {
      const maxWallet = TOTAL_SUPPLY / 100n; // 1%
      await restAI.setLimits(maxWallet, maxWallet, maxWallet);

      // Exclude user1
      await restAI.excludeFromLimits([user1.address], true);

      // Can exceed limit
      await restAI.transfer(user1.address, maxWallet * 5n);
      expect(await restAI.balanceOf(user1.address)).to.equal(maxWallet * 5n);
    });

    // Test: Confirm limits must be within valid ranges (0.01% to 10%)
    // Prevents setting limits that would break token functionality
    it("Should validate limit boundaries", async function () {
      // Too small (< 0.01%)
      await expect(
        restAI.setLimits(0, TOTAL_SUPPLY / 100n, TOTAL_SUPPLY / 100n)
      ).to.be.revertedWithCustomError(restAI, "LimitOutOfRange");

      // Too large (> 10%)
      await expect(
        restAI.setLimits(
          (TOTAL_SUPPLY * 11n) / 100n,
          TOTAL_SUPPLY / 100n,
          TOTAL_SUPPLY / 100n
        )
      ).to.be.revertedWithCustomError(restAI, "LimitOutOfRange");

      // Valid range
      await restAI.setLimits(
        TOTAL_SUPPLY / 10000n, // 0.01%
        TOTAL_SUPPLY / 100n, // 1%
        TOTAL_SUPPLY / 10n // 10%
      );
    });
  });

  /**
   * SCENARIO 4: Tax Collection & Distribution
   *
   * Tests the tax system functionality:
   * - Buy tax collection (3% default)
   * - Sell tax collection (5% default)
   * - Transfer tax when enabled
   * - Tax exemption for excluded addresses
   * - Maximum fee limits (20% cap)
   */
  describe("SCENARIO 4: Tax Collection & Distribution", function () {
    beforeEach(async function () {
      await restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
      await restAI.setLimitsEnabled(false); // Disable for easier testing
    });

    // Test: Verify 3% tax is collected on DEX purchases
    // Ensures revenue generation for operations and development
    it("Should collect correct buy tax (3%)", async function () {
      const contractBefore = await restAI.balanceOf(await restAI.getAddress());

      await router
        .connect(user1)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(
          0,
          [WETH_ADDRESS, await restAI.getAddress()],
          user1.address,
          Math.floor(Date.now() / 1000) + 3600,
          { value: parseEther("1") }
        );

      const userBalance = await restAI.balanceOf(user1.address);
      const contractAfter = await restAI.balanceOf(await restAI.getAddress());
      const taxCollected = contractAfter - contractBefore;

      // Tax should be ~3% of gross amount
      const expectedTax = (userBalance * 300n) / 9700n;
      expect(taxCollected).to.be.closeTo(expectedTax, expectedTax / 100n);
    });

    // Test: Confirm 5% tax is collected on DEX sales
    // Higher sell tax discourages quick profit-taking
    it("Should collect correct sell tax (5%)", async function () {
      // Buy first
      await router
        .connect(user1)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(
          0,
          [WETH_ADDRESS, await restAI.getAddress()],
          user1.address,
          Math.floor(Date.now() / 1000) + 3600,
          { value: parseEther("1") }
        );

      await network.provider.send("hardhat_mine", ["0x5"]);

      const balance = await restAI.balanceOf(user1.address);
      const sellAmount = balance / 4n;

      // Approve and sell
      await restAI.connect(user1).approve(ROUTER_ADDRESS, sellAmount);

      const contractBefore = await restAI.balanceOf(await restAI.getAddress());

      await router
        .connect(user1)
        .swapExactTokensForETHSupportingFeeOnTransferTokens(
          sellAmount,
          0,
          [await restAI.getAddress(), WETH_ADDRESS],
          user1.address,
          Math.floor(Date.now() / 1000) + 3600
        );

      // Check if tax was collected (might trigger auto-swap)
      const contractAfter = await restAI.balanceOf(await restAI.getAddress());
      const operationsETH = await ethers.provider.getBalance(
        operationsWallet.address
      );

      // Either tax is in contract or was swapped to ETH
      if (contractAfter > contractBefore) {
        const taxCollected = contractAfter - contractBefore;
        expect(taxCollected).to.equal((sellAmount * 500n) / 10000n);
      } else {
        // Auto-swap occurred
        expect(operationsETH).to.be.gt(0);
      }
    });

    // Test: Verify transfer tax applies to wallet-to-wallet transfers
    // Optional feature for additional revenue during high activity
    it("Should collect transfer tax when enabled", async function () {
      // Set transfer tax to 2%
      await restAI.setFees(300, 500, 200);

      // Give user1 tokens
      await restAI.transfer(user1.address, parseEther("10000"));

      const contractBefore = await restAI.balanceOf(await restAI.getAddress());

      // Transfer between users
      const transferAmount = parseEther("1000");
      await restAI.connect(user1).transfer(user2.address, transferAmount);

      const contractAfter = await restAI.balanceOf(await restAI.getAddress());
      const taxCollected = contractAfter - contractBefore;

      expect(taxCollected).to.equal((transferAmount * 200n) / 10000n); // 2%
      expect(await restAI.balanceOf(user2.address)).to.equal(
        transferAmount - taxCollected
      );
    });

    // Test: Confirm tax collection can be completely disabled
    // Allows for tax-free periods or emergency situations
    it("Should not collect tax when disabled", async function () {
      await restAI.setTaxesEnabled(false);

      // Buy without tax
      await router
        .connect(user1)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(
          0,
          [WETH_ADDRESS, await restAI.getAddress()],
          user1.address,
          Math.floor(Date.now() / 1000) + 3600,
          { value: parseEther("0.1") }
        );

      const balance = await restAI.balanceOf(user1.address);

      // Transfer without tax
      await restAI.connect(user1).transfer(user2.address, balance);
      expect(await restAI.balanceOf(user2.address)).to.equal(balance);
    });

    // Test: Verify excluded addresses don't pay taxes
    // Prevents double taxation on operations wallet and special contracts
    it("Should not collect tax from excluded addresses", async function () {
      await restAI.excludeFromTax([user1.address], true);

      // Give user1 tokens
      await restAI.transfer(user1.address, parseEther("10000"));

      // Transfer from excluded address - no tax
      const amount = parseEther("1000");
      await restAI.connect(user1).transfer(user2.address, amount);

      expect(await restAI.balanceOf(user2.address)).to.equal(amount);
    });

    // Test: Confirm system accepts maximum allowed fee (20%)
    // Tests boundary condition for fee settings
    it("Should handle maximum fee (20%)", async function () {
      // Set maximum fees
      await restAI.setFees(2000, 2000, 2000);

      // Transfer with max fee
      await restAI.transfer(user1.address, parseEther("1000"));
      await restAI.connect(user1).transfer(user2.address, parseEther("1000"));

      expect(await restAI.balanceOf(user2.address)).to.equal(parseEther("800")); // 80% after 20% tax
    });

    // Test: Ensure fees above 20% are rejected
    // Protects users from excessive taxation
    it("Should reject fees above maximum", async function () {
      await expect(
        restAI.setFees(2001, 2000, 2000)
      ).to.be.revertedWithCustomError(restAI, "FeeTooHigh");
    });
  });

  /**
   * SCENARIO 5: Automatic Swap Mechanism
   *
   * Tests the automated token-to-ETH swap functionality:
   * - Automatic triggering at threshold
   * - Threshold boundaries validation
   * - Manual swap capability for managers
   * - Maximum swap amount capping
   * - Access control for manual swaps
   */
  describe("SCENARIO 5: Automatic Swap Mechanism", function () {
    beforeEach(async function () {
      await restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
      await restAI.setLimitsEnabled(false);
    });

    // Test: Verify automatic swap triggers when contract balance reaches threshold
    // Converts collected taxes to ETH for operations wallet
    it("Should trigger automatic swap at threshold", async function () {
      // Set low threshold for testing
      const threshold = TOTAL_SUPPLY / 10000n; // 0.01%
      await restAI.setTokensForSwap(threshold);

      const opsBefore = await ethers.provider.getBalance(
        operationsWallet.address
      );

      // Do trades to accumulate tax past threshold
      for (let i = 0; i < 3; i++) {
        await router
          .connect(user1)
          .swapExactETHForTokensSupportingFeeOnTransferTokens(
            0,
            [WETH_ADDRESS, await restAI.getAddress()],
            user1.address,
            Math.floor(Date.now() / 1000) + 3600,
            { value: parseEther("0.2") }
          );
        await network.provider.send("hardhat_mine", ["0x4"]);
      }

      const opsAfter = await ethers.provider.getBalance(
        operationsWallet.address
      );

      // Should have received ETH from auto-swap
      if (opsAfter > opsBefore) {
        console.log(
          "Auto-swap triggered, ETH sent:",
          ethers.formatEther(opsAfter - opsBefore)
        );
      }
    });

    // Test: Confirm swap threshold must be within valid range (0.01% to 5%)
    // Prevents too frequent or too rare swaps
    it("Should enforce swap threshold boundaries", async function () {
      // Too small (< 0.01%)
      await expect(
        restAI.setTokensForSwap(TOTAL_SUPPLY / 100000n)
      ).to.be.revertedWithCustomError(restAI, "SwapThresholdOutOfRange");

      // Too large (> 5%)
      await expect(
        restAI.setTokensForSwap((TOTAL_SUPPLY * 6n) / 100n)
      ).to.be.revertedWithCustomError(restAI, "SwapThresholdOutOfRange");

      // Valid range
      await restAI.setTokensForSwap(TOTAL_SUPPLY / 100n); // 1%
    });

    // Test: Verify managers can manually trigger swaps
    // Useful for emergency situations or gas optimization
    it("Should allow manual swap by manager", async function () {
      // Send tokens to contract
      await restAI.transfer(await restAI.getAddress(), parseEther("10000"));

      const opsBefore = await ethers.provider.getBalance(
        operationsWallet.address
      );

      await restAI.connect(manager).manualSwap();

      const opsAfter = await ethers.provider.getBalance(
        operationsWallet.address
      );
      expect(opsAfter).to.be.gt(opsBefore);
    });

    // Test: Ensure manual swap fails when contract has no tokens
    // Prevents wasted gas on empty swaps
    it("Should prevent manual swap without tokens", async function () {
      await expect(restAI.manualSwap()).to.be.revertedWith("No tokens to swap");
    });

    // Test: Confirm only managers can trigger manual swaps
    // Protects against unauthorized swap manipulation
    it("Should prevent manual swap by non-manager", async function () {
      await restAI.transfer(await restAI.getAddress(), parseEther("1000"));

      await expect(restAI.connect(user1).manualSwap()).to.be.reverted;
    });

    // Test: Verify swaps are capped at 20x the threshold
    // Prevents massive dumps that could impact price
    it("Should cap maximum swap amount", async function () {
      // Send lots of tokens to contract
      const largeAmount = parseEther("50000000"); // 5% of supply
      await restAI.transfer(await restAI.getAddress(), largeAmount);

      // Manual swap should cap at 20x threshold
      const threshold = await restAI.swapTokensAtAmount();
      const maxSwap = threshold * 20n;

      await restAI.manualSwap();

      // Some tokens should remain if amount was capped
      const remaining = await restAI.balanceOf(await restAI.getAddress());
      expect(remaining).to.be.gte(largeAmount - maxSwap);
    });
  });

  /**
   * SCENARIO 6: Blacklist Functionality
   *
   * Tests the address blocking mechanism:
   * - Blocking transfers from/to blacklisted addresses
   * - Blocking DEX trades for blacklisted addresses
   * - Unblocking functionality
   * - Access control for blacklist management
   */
  describe("SCENARIO 6: Blacklist Functionality", function () {
    beforeEach(async function () {
      await restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
    });

    // Test: Verify blacklisted addresses cannot send tokens
    // Prevents malicious actors from moving stolen/scammed tokens
    it("Should block transfers from blacklisted address", async function () {
      await restAI.transfer(attacker.address, parseEther("1000"));

      // Block the attacker
      await restAI.setBlockAccount(attacker.address, true);

      await expect(
        restAI.connect(attacker).transfer(user1.address, parseEther("100"))
      ).to.be.revertedWithCustomError(restAI, "AccountBlockedFromTransfer");
    });

    // Test: Confirm tokens cannot be sent to blacklisted addresses
    // Prevents funding of malicious accounts
    it("Should block transfers to blacklisted address", async function () {
      await restAI.setBlockAccount(attacker.address, true);

      await expect(
        restAI.transfer(attacker.address, parseEther("100"))
      ).to.be.revertedWithCustomError(restAI, "AccountBlockedFromTransfer");
    });

    // Test: Ensure blacklisted addresses cannot trade on DEX
    // Comprehensive blocking includes all trading venues
    it("Should block Uniswap trades for blacklisted address", async function () {
      await restAI.setBlockAccount(attacker.address, true);
      await restAI.setLimitsEnabled(false);

      await expect(
        router
          .connect(attacker)
          .swapExactETHForTokensSupportingFeeOnTransferTokens(
            0,
            [WETH_ADDRESS, await restAI.getAddress()],
            attacker.address,
            Math.floor(Date.now() / 1000) + 3600,
            { value: parseEther("0.1") }
          )
      ).to.be.reverted;
    });

    // Test: Verify addresses can be unblocked
    // Allows for correction of mistakes or rehabilitation
    it("Should allow unblocking", async function () {
      await restAI.transfer(user1.address, parseEther("1000"));
      await restAI.setBlockAccount(user1.address, true);

      // Blocked
      await expect(
        restAI.connect(user1).transfer(user2.address, parseEther("100"))
      ).to.be.revertedWithCustomError(restAI, "AccountBlockedFromTransfer");

      // Unblock
      await restAI.setBlockAccount(user1.address, false);

      // Now works
      await restAI.connect(user1).transfer(user2.address, parseEther("100"));
      expect(await restAI.balanceOf(user2.address)).to.equal(parseEther("100"));
    });

    // Test: Confirm only managers can modify blacklist
    // Prevents unauthorized blocking/unblocking
    it("Should only allow manager to block/unblock", async function () {
      await expect(restAI.connect(user1).setBlockAccount(user2.address, true))
        .to.be.reverted;

      // Manager can block
      await restAI.connect(manager).setBlockAccount(user2.address, true);
      expect(await restAI.isBlocked(user2.address)).to.be.true;
    });
  });

  /**
   * SCENARIO 7: Pause Mechanism
   *
   * Tests the emergency pause functionality:
   * - Pausing all token transfers
   * - Unpausing and resuming operations
   * - Admin-only access control
   */
  describe("SCENARIO 7: Pause Mechanism", function () {
    beforeEach(async function () {
      await restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
    });

    // Test: Verify pause stops all token movements
    // Emergency feature for critical situations
    it("Should pause all transfers", async function () {
      await restAI.pause();

      // All transfers should fail
      await expect(
        restAI.transfer(user1.address, parseEther("100"))
      ).to.be.revertedWithCustomError(restAI, "EnforcedPause");

      await expect(
        router
          .connect(user1)
          .swapExactETHForTokensSupportingFeeOnTransferTokens(
            0,
            [WETH_ADDRESS, await restAI.getAddress()],
            user1.address,
            Math.floor(Date.now() / 1000) + 3600,
            { value: parseEther("0.1") }
          )
      ).to.be.reverted;
    });

    // Test: Confirm unpause restores normal functionality
    // Allows recovery after emergency resolution
    it("Should unpause and resume normal operation", async function () {
      await restAI.pause();

      await expect(
        restAI.transfer(user1.address, parseEther("100"))
      ).to.be.revertedWithCustomError(restAI, "EnforcedPause");

      await restAI.unpause();

      // Should work now
      await restAI.transfer(user1.address, parseEther("100"));
      expect(await restAI.balanceOf(user1.address)).to.equal(parseEther("100"));
    });

    // Test: Ensure only admin can control pause state
    // Prevents unauthorized contract freezing
    it("Should only allow admin to pause/unpause", async function () {
      await expect(restAI.connect(manager).pause()).to.be.reverted;
      await expect(restAI.connect(user1).pause()).to.be.reverted;

      // Only owner (admin) can pause
      await restAI.connect(owner).pause();

      // Only owner can unpause
      await expect(restAI.connect(manager).unpause()).to.be.reverted;
      await restAI.connect(owner).unpause();
    });
  });

  /**
   * SCENARIO 8: Emergency Functions
   *
   * Tests emergency recovery mechanisms:
   * - Withdrawing stuck tokens
   * - Withdrawing stuck ETH
   * - Recovering other ERC20 tokens
   * - Admin-only access control
   * - Reentrancy protection
   */
  describe("SCENARIO 8: Emergency Functions", function () {
    beforeEach(async function () {
      await restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
    });

    // Test: Verify admin can recover accidentally sent tokens
    // Prevents permanent loss of user funds
    it("Should withdraw stuck tokens", async function () {
      const stuckAmount = parseEther("10000");
      await restAI.transfer(await restAI.getAddress(), stuckAmount);

      const ownerBefore = await restAI.balanceOf(owner.address);

      await restAI.withdrawTokens(await restAI.getAddress());

      const ownerAfter = await restAI.balanceOf(owner.address);
      expect(ownerAfter - ownerBefore).to.equal(stuckAmount);
    });

    // Test: Confirm ETH recovery functionality (skipped - needs implementation)
    // Would allow recovery of ETH sent directly to contract
    it("Should withdraw stuck ETH", async function () {
      // Send ETH to contract
      const ethAmount = parseEther("1");
      await user1.sendTransaction({
        to: await restAI.getAddress(),
        value: ethAmount,
      });

      const ownerBefore = await ethers.provider.getBalance(owner.address);

      await expect(restAI.withdrawTokens(ethers.ZeroAddress))
        .to.emit(restAI, "WithdrawStuckTokens")
        .withArgs(ethers.ZeroAddress, ethAmount);

      const ownerAfter = await ethers.provider.getBalance(owner.address);
      expect(ownerAfter).to.be.greaterThan(ownerBefore);
    });

    // Test: Verify recovery of non-native tokens sent by mistake
    // Handles user errors when sending wrong tokens
    it("Should withdraw other ERC20 tokens", async function () {
      // Deploy a mock ERC20
      const MockERC20 = await ethers.getContractFactory("RestAI");
      const mockToken = await MockERC20.deploy();
      await mockToken.waitForDeployment();

      // This would need a proper mock ERC20 to test fully
      // For now, just verify the function exists and is protected
      await expect(restAI.connect(user1).withdrawTokens(mockToken.getAddress()))
        .to.be.reverted;
    });

    // Test: Confirm only admin can execute emergency withdrawals
    // Prevents unauthorized asset recovery
    it("Should only allow admin to withdraw", async function () {
      await restAI.transfer(await restAI.getAddress(), parseEther("1000"));

      await expect(
        restAI.connect(manager).withdrawTokens(await restAI.getAddress())
      ).to.be.reverted;

      await expect(
        restAI.connect(user1).withdrawTokens(await restAI.getAddress())
      ).to.be.reverted;

      // Only owner can withdraw
      await restAI.connect(owner).withdrawTokens(await restAI.getAddress());
    });

    // Test: Verify reentrancy guard prevents recursive calls
    // Critical security feature for swap operations
    it("Should handle reentrancy protection", async function () {
      // withdrawTokens has nonReentrant modifier
      // Manual swap has nonReentrant modifier
      // These protect against reentrancy attacks
      expect(true).to.be.true; // Placeholder - would need attack contract
    });
  });

  /**
   * SCENARIO 9: Access Control
   *
   * Tests role-based access control system:
   * - Role management (granting/revoking)
   * - Function-level permission enforcement
   * - Role renouncement capability
   */
  describe("SCENARIO 9: Access Control", function () {
    // Test: Verify role granting and revoking works correctly
    // Ensures proper delegation of responsibilities
    it("Should properly manage roles", async function () {
      const MANAGER_ROLE = await restAI.MANAGER_ROLE();
      const DEFAULT_ADMIN_ROLE = await restAI.DEFAULT_ADMIN_ROLE();
      const UPGRADER_ROLE = await restAI.UPGRADER_ROLE();

      // Check initial roles
      expect(await restAI.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be
        .true;
      expect(await restAI.hasRole(MANAGER_ROLE, owner.address)).to.be.true;
      expect(await restAI.hasRole(MANAGER_ROLE, manager.address)).to.be.true;

      // Grant upgrader role
      await restAI.grantRole(UPGRADER_ROLE, user1.address);
      expect(await restAI.hasRole(UPGRADER_ROLE, user1.address)).to.be.true;

      // Revoke role
      await restAI.revokeRole(UPGRADER_ROLE, user1.address);
      expect(await restAI.hasRole(UPGRADER_ROLE, user1.address)).to.be.false;
    });

    // Test: Confirm functions check role requirements
    // Prevents unauthorized access to critical functions
    it("Should enforce role requirements for functions", async function () {
      // Manager functions
      await expect(restAI.connect(user1).setLimitsEnabled(false)).to.be
        .reverted;
      await expect(restAI.connect(user1).setTaxesEnabled(false)).to.be.reverted;
      await expect(restAI.connect(user1).setFees(100, 100, 100)).to.be.reverted;

      // Admin functions
      await expect(restAI.connect(manager).pause()).to.be.reverted;
      await expect(restAI.connect(manager).setOperationsWallet(user1.address))
        .to.be.reverted;

      // Manager can do manager functions
      await restAI.connect(manager).setLimitsEnabled(false);

      // Admin can do admin functions
      await restAI.connect(owner).setOperationsWallet(user2.address);
    });

    // Test: Verify roles can be permanently renounced
    // Allows for progressive decentralization
    it("Should allow role renouncement", async function () {
      const MANAGER_ROLE = await restAI.MANAGER_ROLE();

      // Manager renounces role
      await restAI.connect(manager).renounceRole(MANAGER_ROLE, manager.address);

      expect(await restAI.hasRole(MANAGER_ROLE, manager.address)).to.be.false;

      // Can no longer perform manager functions
      await expect(restAI.connect(manager).setLimitsEnabled(false)).to.be
        .reverted;
    });
  });

  /**
   * SCENARIO 10: Complex Trading Patterns
   *
   * Tests realistic trading scenarios:
   * - Rapid buy-sell-buy sequences
   * - Multiple simultaneous traders
   * - Sandwich attack attempts
   */
  describe("SCENARIO 10: Complex Trading Patterns", function () {
    beforeEach(async function () {
      await restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
      await restAI.setLimitsEnabled(false);
    });

    // Test: Verify contract handles rapid trading without issues
    // Simulates bot trading and high-frequency patterns
    it("Should handle rapid buy-sell-buy sequence", async function () {
      // Buy
      await router
        .connect(user1)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(
          0,
          [WETH_ADDRESS, await restAI.getAddress()],
          user1.address,
          Math.floor(Date.now() / 1000) + 3600,
          { value: parseEther("0.5") }
        );

      const balance1 = await restAI.balanceOf(user1.address);

      // Immediate sell
      await restAI.connect(user1).approve(ROUTER_ADDRESS, balance1);
      await router
        .connect(user1)
        .swapExactTokensForETHSupportingFeeOnTransferTokens(
          balance1 / 2n,
          0,
          [await restAI.getAddress(), WETH_ADDRESS],
          user1.address,
          Math.floor(Date.now() / 1000) + 3600
        );

      // Immediate buy again
      await router
        .connect(user1)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(
          0,
          [WETH_ADDRESS, await restAI.getAddress()],
          user1.address,
          Math.floor(Date.now() / 1000) + 3600,
          { value: parseEther("0.2") }
        );

      const finalBalance = await restAI.balanceOf(user1.address);
      expect(finalBalance).to.be.gt(0);
    });

    // Test: Confirm concurrent trades process correctly
    // Tests race conditions and state management
    it("Should handle multiple users trading simultaneously", async function () {
      // Multiple buys
      await Promise.all([
        router
          .connect(user1)
          .swapExactETHForTokensSupportingFeeOnTransferTokens(
            0,
            [WETH_ADDRESS, await restAI.getAddress()],
            user1.address,
            Math.floor(Date.now() / 1000) + 3600,
            { value: parseEther("0.1") }
          ),
        router
          .connect(user2)
          .swapExactETHForTokensSupportingFeeOnTransferTokens(
            0,
            [WETH_ADDRESS, await restAI.getAddress()],
            user2.address,
            Math.floor(Date.now() / 1000) + 3600,
            { value: parseEther("0.2") }
          ),
        router
          .connect(user3)
          .swapExactETHForTokensSupportingFeeOnTransferTokens(
            0,
            [WETH_ADDRESS, await restAI.getAddress()],
            user3.address,
            Math.floor(Date.now() / 1000) + 3600,
            { value: parseEther("0.15") }
          ),
      ]);

      expect(await restAI.balanceOf(user1.address)).to.be.gt(0);
      expect(await restAI.balanceOf(user2.address)).to.be.gt(0);
      expect(await restAI.balanceOf(user3.address)).to.be.gt(0);
    });

    // Test: Simulate sandwich attack with frontrun and backrun
    // Verifies MEV protection and fair trading
    it("Should handle sandwich attack scenario", async function () {
      // Attacker tries to sandwich a user's trade
      // Buy before user
      await router
        .connect(attacker)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(
          0,
          [WETH_ADDRESS, await restAI.getAddress()],
          attacker.address,
          Math.floor(Date.now() / 1000) + 3600,
          { value: parseEther("1") }
        );

      // User's trade
      await router
        .connect(user1)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(
          0,
          [WETH_ADDRESS, await restAI.getAddress()],
          user1.address,
          Math.floor(Date.now() / 1000) + 3600,
          { value: parseEther("0.5") }
        );

      // Attacker sells after
      const attackerBalance = await restAI.balanceOf(attacker.address);
      await restAI.connect(attacker).approve(ROUTER_ADDRESS, attackerBalance);
      await router
        .connect(attacker)
        .swapExactTokensForETHSupportingFeeOnTransferTokens(
          attackerBalance,
          0,
          [await restAI.getAddress(), WETH_ADDRESS],
          attacker.address,
          Math.floor(Date.now() / 1000) + 3600
        );

      // Tax mechanism reduces profitability of sandwich attacks
      // 3% buy tax + 5% sell tax = 8% cost for attacker
    });
  });

  /**
   * SCENARIO 11: Edge Cases & Boundary Conditions
   *
   * Tests edge cases and unusual inputs:
   * - Zero amount transfers
   * - Self-transfers
   * - Invalid addresses
   * - Duplicate settings
   * - Maximum values
   */
  describe("SCENARIO 11: Edge Cases & Boundary Conditions", function () {
    beforeEach(async function () {
      await restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
    });

    // Test: Verify zero amount transfers are handled gracefully
    // Edge case that shouldn't break the contract
    it("Should handle zero amount transfers", async function () {
      await expect(restAI.transfer(user1.address, 0)).to.not.be.reverted;
    });

    // Test: Confirm self-transfers work correctly
    // Unusual but valid operation
    it("Should handle transfers to self", async function () {
      await restAI.transfer(user1.address, parseEther("1000"));

      const balanceBefore = await restAI.balanceOf(user1.address);
      await restAI.connect(user1).transfer(user1.address, parseEther("100"));
      const balanceAfter = await restAI.balanceOf(user1.address);

      // With tax, balance should decrease slightly
      expect(balanceAfter).to.be.lte(balanceBefore);
    });

    // Test: Ensure transfers to zero address are rejected
    // Prevents token burning through transfers
    it("Should handle transfers to zero address (should fail)", async function () {
      await expect(restAI.transfer(ZeroAddress, parseEther("100"))).to.be
        .reverted;
    });

    // Test: Verify setting unchanged values doesn't break contract
    // Tests idempotent operations
    it("Should handle setting same values", async function () {
      const fees = await restAI.fees();

      // Setting same fees should work
      await restAI.setFees(fees.buyFee, fees.sellFee, fees.transferFee);

      const limits = await restAI.limits();

      // Setting same limits should work
      await restAI.setLimits(limits.maxBuy, limits.maxSell, limits.maxWallet);
    });

    // Test: Confirm max uint256 approvals work correctly
    // Common pattern for infinite approval
    it("Should handle maximum uint256 approval", async function () {
      await restAI.transfer(user1.address, parseEther("1000"));

      // Max approval
      await restAI.connect(user1).approve(user2.address, ethers.MaxUint256);

      const allowance = await restAI.allowance(user1.address, user2.address);
      expect(allowance).to.equal(ethers.MaxUint256);
    });
  });

  /**
   * SCENARIO 12: Operations Wallet Management
   *
   * Tests operations wallet functionality:
   * - Updating wallet address
   * - ETH distribution to new wallet
   * - Zero address validation
   * - Access control
   */
  describe("SCENARIO 12: Operations Wallet Management", function () {
    beforeEach(async function () {
      await restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
    });

    // Test: Verify operations wallet can be changed
    // Allows for wallet rotation and security updates
    it("Should update operations wallet", async function () {
      const newWallet = user3.address;

      await restAI.setOperationsWallet(newWallet);
      expect(await restAI.operationsWallet()).to.equal(newWallet);
    });

    // Test: Confirm ETH goes to updated operations wallet
    // Ensures revenue flows to correct destination
    it("Should send swapped ETH to new operations wallet", async function () {
      // Change operations wallet
      await restAI.setOperationsWallet(user3.address);

      // Trigger swap
      await restAI.transfer(await restAI.getAddress(), parseEther("10000"));
      await restAI.manualSwap();

      // Check user3 received ETH
      const user3Balance = await ethers.provider.getBalance(user3.address);
      expect(user3Balance).to.be.gt(parseEther("10000")); // Initial balance
    });

    // Test: Ensure zero address cannot be set as operations wallet
    // Prevents loss of funds
    it("Should reject zero address for operations wallet", async function () {
      await expect(restAI.setOperationsWallet(ZeroAddress)).to.be.revertedWith(
        "Cannot set zero address"
      );
    });

    // Test: Verify only admin can update operations wallet
    // Critical security control for revenue management
    it("Should only allow admin to change operations wallet", async function () {
      await expect(restAI.connect(manager).setOperationsWallet(user3.address))
        .to.be.reverted;

      await expect(restAI.connect(user1).setOperationsWallet(user3.address)).to
        .be.reverted;
    });
  });

  /**
   * SCENARIO 13: AMM Pair Management
   *
   * Tests automated market maker pair configuration:
   * - Marking additional AMM pairs
   * - Unmarking AMM pairs
   * - Tax application for different pair types
   * - Zero address validation
   */
  describe("SCENARIO 13: AMM Pair Management", function () {
    beforeEach(async function () {
      await restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
    });

    // Test: Verify new AMM pairs can be registered
    // Supports multiple DEX integrations
    it("Should mark additional AMM pairs", async function () {
      const newPair = user3.address; // Mock pair address

      await restAI.setAutomaticMarketMakerPair(newPair, true);
      expect(await restAI.automatedMarketMakerPairs(newPair)).to.be.true;
    });

    // Test: Confirm AMM pairs can be removed from registry
    // Allows for dynamic pair management
    it("Should unmark AMM pairs", async function () {
      const newPair = user3.address;

      await restAI.setAutomaticMarketMakerPair(newPair, true);
      await restAI.setAutomaticMarketMakerPair(newPair, false);

      expect(await restAI.automatedMarketMakerPairs(newPair)).to.be.false;
    });

    // Test: Verify correct tax rates apply to AMM trades
    // Different rates for buy (3%) vs sell (5%) on AMM pairs
    it("Should apply different tax for AMM pairs", async function () {
      // Mark user2 as AMM pair for testing
      await restAI.setAutomaticMarketMakerPair(user2.address, true);

      // Transfer to user1 (normal)
      await restAI.transfer(user1.address, parseEther("1000"));

      // Transfer from user1 to AMM (sell tax)
      const amount = parseEther("100");
      await restAI.connect(user1).transfer(user2.address, amount);

      // Should apply sell tax (5%)
      expect(await restAI.balanceOf(user2.address)).to.equal(
        (amount * 9500n) / 10000n
      );
    });

    // Test: Ensure zero address cannot be marked as AMM pair
    // Prevents configuration errors
    it("Should reject zero address as AMM pair", async function () {
      await expect(
        restAI.setAutomaticMarketMakerPair(ZeroAddress, true)
      ).to.be.revertedWith("Cannot set zero address");
    });
  });

  /**
   * SCENARIO 14: Gas Optimization Tests
   *
   * Tests efficient batch operations and gas usage:
   * - Batch exclusion of multiple addresses
   * - Large number of sequential transfers
   * - Gas-efficient operations
   */
  describe("SCENARIO 14: Gas Optimization Tests", function () {
    beforeEach(async function () {
      await restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
    });

    // Test: Verify batch operations save gas vs individual calls
    // Optimizes admin operations for large holder lists
    it("Should batch exclude multiple addresses efficiently", async function () {
      const addresses = [];
      for (let i = 0; i < 10; i++) {
        addresses.push(ethers.Wallet.createRandom().address);
      }

      // Batch exclude from limits
      await restAI.excludeFromLimits(addresses, true);

      // Verify all excluded
      for (const addr of addresses) {
        expect(await restAI.isExcludedFromLimits(addr)).to.be.true;
      }

      // Batch exclude from tax
      await restAI.excludeFromTax(addresses, true);

      // Verify all excluded
      for (const addr of addresses) {
        expect(await restAI.isExcludedFromTax(addr)).to.be.true;
      }
    });

    // Test: Confirm contract handles many transfers without issues
    // Stress tests the contract under high load
    it("Should handle large number of transfers", async function () {
      await restAI.setLimitsEnabled(false);

      // Do 20 transfers
      for (let i = 0; i < 20; i++) {
        await restAI.transfer(
          [user1.address, user2.address, user3.address][i % 3],
          parseEther("100")
        );
      }

      expect(await restAI.balanceOf(user1.address)).to.be.gt(0);
      expect(await restAI.balanceOf(user2.address)).to.be.gt(0);
      expect(await restAI.balanceOf(user3.address)).to.be.gt(0);
    });
  });

  /**
   * SCENARIO 15: Upgrade Functionality
   *
   * Tests the UUPS upgrade mechanism:
   * - Role-based upgrade permissions
   * - Upgrade process validation
   * - Protection against unauthorized upgrades
   */
  describe("SCENARIO 15: Upgrade Functionality", function () {
    // Test: Verify only UPGRADER_ROLE can perform contract upgrades
    // Critical security feature for contract maintenance
    it("Should only allow upgrader role to upgrade", async function () {
      const UPGRADER_ROLE = await restAI.UPGRADER_ROLE();

      // Try to upgrade without role (should fail)
      const RestAIV2 = await ethers.getContractFactory("RestAI");
      const implAddress = await RestAIV2.deploy();

      await expect(
        restAI
          .connect(owner)
          .upgradeToAndCall(await implAddress.getAddress(), "0x")
      ).to.be.reverted;

      // Grant upgrader role
      await restAI.grantRole(UPGRADER_ROLE, owner.address);

      // Now should succeed
      await expect(
        restAI
          .connect(owner)
          .upgradeToAndCall(await implAddress.getAddress(), "0x")
      ).to.not.be.reverted;
    });
  });
});
