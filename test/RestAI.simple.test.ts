import { expect } from "chai";
import { ethers, upgrades, network } from "hardhat";
import { RestAI } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { parseEther } from "ethers";

describe("RestAI Real-World Tests (Base Fork)", function () {
  let restAI: RestAI;
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let operationsWallet: SignerWithAddress;
  let router: any;

  // Base mainnet addresses
  const ROUTER_ADDRESS = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24"; // Base Uniswap V2 Router
  const WETH_ADDRESS = "0x4200000000000000000000000000000000000006"; // Base WETH

  const TOTAL_SUPPLY = parseEther("1000000000"); // 1 billion tokens
  const LAUNCH_TOKENS = parseEther("500000000"); // 500M tokens for liquidity (50%)
  const LAUNCH_ETH = parseEther("10"); // 10 ETH for initial liquidity

  beforeEach(async function () {
    // Fork Base mainnet for each test
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
            blockNumber: 17000000 // Use a recent block
          }
        }
      ]
    });

    [owner, user1, user2, operationsWallet] = await ethers.getSigners();

    // Deploy RestAI
    const RestAI = await ethers.getContractFactory("RestAI");
    restAI = await upgrades.deployProxy(
      RestAI,
      [owner.address, operationsWallet.address],
      { initializer: "initialize" }
    ) as unknown as RestAI;
    await restAI.waitForDeployment();

    // Get router contract
    router = await ethers.getContractAt(
      [
        "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable",
        "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)",
        "function WETH() view returns (address)",
        "function factory() view returns (address)"
      ],
      ROUTER_ADDRESS
    );
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

      // Verify pair was created
      const factory = await ethers.getContractAt(
        ["function getPair(address,address) view returns (address)"],
        await router.factory()
      );
      const pairAddress = await factory.getPair(await restAI.getAddress(), WETH_ADDRESS);
      expect(pairAddress).to.not.equal(ethers.ZeroAddress);

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

  describe("3. Trading with Uniswap V2 (Buy/Sell with Tax)", function () {
    beforeEach(async function () {
      // Launch the token first
      await restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });

      // Disable limits for easier testing
      await restAI.setLimitsEnabled(false);
    });

    it("Should apply 3% buy tax when purchasing from Uniswap", async function () {
      const contractBalanceBefore = await restAI.balanceOf(await restAI.getAddress());
      const user1BalanceBefore = await restAI.balanceOf(user1.address);

      // Buy tokens from Uniswap
      const buyAmountETH = parseEther("0.5");
      const path = [WETH_ADDRESS, await restAI.getAddress()];

      await router.connect(user1).swapExactETHForTokensSupportingFeeOnTransferTokens(
        0, // Accept any amount of tokens
        path,
        user1.address,
        Math.floor(Date.now() / 1000) + 3600,
        { value: buyAmountETH }
      );

      // Check user received tokens
      const user1BalanceAfter = await restAI.balanceOf(user1.address);
      const tokensReceived = user1BalanceAfter - user1BalanceBefore;
      expect(tokensReceived).to.be.gt(0);

      // Check that 3% buy tax was collected
      const contractBalanceAfter = await restAI.balanceOf(await restAI.getAddress());
      const taxCollected = contractBalanceAfter - contractBalanceBefore;

      // Tax should be approximately 3% of the gross amount
      const expectedTax = tokensReceived * 300n / 9700n;
      expect(taxCollected).to.be.closeTo(expectedTax, expectedTax / 100n);

      console.log("Buy Tax Test:");
      console.log("  Tokens received:", ethers.formatEther(tokensReceived));
      console.log("  Tax collected:", ethers.formatEther(taxCollected));
      console.log("  Tax rate:", Number(taxCollected * 10000n / (tokensReceived + taxCollected)) / 100, "%");
    });

    it("Should apply 5% sell tax when selling to Uniswap", async function () {
      // First buy tokens
      await router.connect(user1).swapExactETHForTokensSupportingFeeOnTransferTokens(
        0,
        [WETH_ADDRESS, await restAI.getAddress()],
        user1.address,
        Math.floor(Date.now() / 1000) + 3600,
        { value: parseEther("1") }
      );

      // Wait a few blocks to avoid triggering swap in same block
      await network.provider.send("hardhat_mine", ["0x5"]);

      const user1Balance = await restAI.balanceOf(user1.address);
      const sellAmount = user1Balance / 4n; // Sell quarter

      // Record balances
      const contractBalanceBefore = await restAI.balanceOf(await restAI.getAddress());
      const operationsBalanceBefore = await ethers.provider.getBalance(operationsWallet.address);

      // Approve and sell
      await restAI.connect(user1).approve(ROUTER_ADDRESS, sellAmount);
      await router.connect(user1).swapExactTokensForETHSupportingFeeOnTransferTokens(
        sellAmount,
        0,
        [await restAI.getAddress(), WETH_ADDRESS],
        user1.address,
        Math.floor(Date.now() / 1000) + 3600
      );

      const contractBalanceAfter = await restAI.balanceOf(await restAI.getAddress());
      const operationsBalanceAfter = await ethers.provider.getBalance(operationsWallet.address);

      // Check if automatic swap occurred
      if (contractBalanceAfter < contractBalanceBefore) {
        // Automatic swap happened
        console.log("Sell Tax Test (with auto-swap):");
        console.log("  Operations received ETH:", ethers.formatEther(operationsBalanceAfter - operationsBalanceBefore));
        expect(operationsBalanceAfter).to.be.gt(operationsBalanceBefore);
      } else {
        // No automatic swap, tax in contract
        const taxCollected = contractBalanceAfter - contractBalanceBefore;
        const expectedTax = sellAmount * 500n / 10000n; // 5%
        expect(taxCollected).to.equal(expectedTax);
        console.log("Sell Tax Test:");
        console.log("  Tax collected:", ethers.formatEther(taxCollected));
      }
    });

    it("Should handle multiple trades with tax accumulation", async function () {
      const contractStart = await restAI.balanceOf(await restAI.getAddress());

      // Buy 1
      await router.connect(user1).swapExactETHForTokensSupportingFeeOnTransferTokens(
        0,
        [WETH_ADDRESS, await restAI.getAddress()],
        user1.address,
        Math.floor(Date.now() / 1000) + 3600,
        { value: parseEther("0.2") }
      );

      // Buy 2
      await router.connect(user2).swapExactETHForTokensSupportingFeeOnTransferTokens(
        0,
        [WETH_ADDRESS, await restAI.getAddress()],
        user2.address,
        Math.floor(Date.now() / 1000) + 3600,
        { value: parseEther("0.3") }
      );

      const contractMid = await restAI.balanceOf(await restAI.getAddress());
      const buyTaxes = contractMid - contractStart;
      expect(buyTaxes).to.be.gt(0);

      // User1 sells
      const user1Tokens = await restAI.balanceOf(user1.address);
      const sellAmount = user1Tokens / 2n;

      await restAI.connect(user1).approve(ROUTER_ADDRESS, sellAmount);
      await router.connect(user1).swapExactTokensForETHSupportingFeeOnTransferTokens(
        sellAmount,
        0,
        [await restAI.getAddress(), WETH_ADDRESS],
        user1.address,
        Math.floor(Date.now() / 1000) + 3600
      );

      console.log("Multi-trade Test:");
      console.log("  Buy taxes collected:", ethers.formatEther(buyTaxes));
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
      const totalSupply = await restAI.totalSupply();
      const newThreshold = totalSupply * 10n / 10000n; // 0.1%

      await restAI.setTokensForSwap(newThreshold);
      expect(await restAI.swapTokensAtAmount()).to.equal(newThreshold);
    });

    it("Should allow manual swap", async function () {
      // Send tokens to contract to simulate tax collection
      await restAI.transfer(await restAI.getAddress(), parseEther("1000"));

      // Manual swap should not revert
      await expect(restAI.manualSwap()).to.not.be.reverted;
    });

    it("Should trigger automatic swap when threshold reached", async function () {
      // Set lower threshold
      const totalSupply = await restAI.totalSupply();
      await restAI.setTokensForSwap(totalSupply / 10000n); // 0.01% minimum

      // Disable limits for easier testing
      await restAI.setLimitsEnabled(false);

      const operationsBalanceBefore = await ethers.provider.getBalance(operationsWallet.address);

      // Do multiple buys to accumulate tax
      for (let i = 0; i < 5; i++) {
        await router.connect(user1).swapExactETHForTokensSupportingFeeOnTransferTokens(
          0,
          [WETH_ADDRESS, await restAI.getAddress()],
          user1.address,
          Math.floor(Date.now() / 1000) + 3600,
          { value: parseEther("0.1") }
        );

        // Wait blocks between trades
        await network.provider.send("hardhat_mine", ["0x3"]);
      }

      const operationsBalanceAfter = await ethers.provider.getBalance(operationsWallet.address);
      const ethReceived = operationsBalanceAfter - operationsBalanceBefore;

      console.log("Auto-swap Test:");
      console.log("  ETH sent to operations:", ethers.formatEther(ethReceived));
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

  describe("11. Liquidity Pool Verification", function () {
    beforeEach(async function () {
      await restAI.launch(LAUNCH_TOKENS, { value: LAUNCH_ETH });
    });

    it("Should have correct pool reserves", async function () {
      const factory = await ethers.getContractAt(
        ["function getPair(address,address) view returns (address)"],
        await router.factory()
      );

      const pairAddress = await factory.getPair(await restAI.getAddress(), WETH_ADDRESS);
      const pair = await ethers.getContractAt(
        [
          "function getReserves() view returns (uint112,uint112,uint32)",
          "function token0() view returns (address)",
          "function token1() view returns (address)"
        ],
        pairAddress
      );

      const reserves = await pair.getReserves();
      const token0 = await pair.token0();
      const isToken0 = token0.toLowerCase() === (await restAI.getAddress()).toLowerCase();

      const tokenReserve = isToken0 ? reserves[0] : reserves[1];
      const wethReserve = isToken0 ? reserves[1] : reserves[0];

      console.log("Pool Reserves:");
      console.log("  RestAI:", ethers.formatEther(tokenReserve));
      console.log("  WETH:", ethers.formatEther(wethReserve));

      expect(tokenReserve).to.equal(LAUNCH_TOKENS);
      expect(wethReserve).to.equal(LAUNCH_ETH);
    });
  });
});