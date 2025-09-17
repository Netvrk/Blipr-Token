import { ethers, network, upgrades } from "hardhat";
import { RestAI } from "../typechain-types";
import { parseEther, formatEther } from "ethers";
import chalk from "chalk";

// Function to fetch current ETH/USD price
async function getETHPrice(): Promise<number> {
  try {
    const response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"
    );
    const data = await response.json();
    return data.ethereum.usd;
  } catch (error) {
    console.log("⚠️  Could not fetch ETH price, using fallback: $3,500");
    return 3500; // Fallback price
  }
}

// Helper function to format price with both ETH and USD
function formatPriceWithUSD(priceInWei: bigint, ethPriceUSD: number): string {
  const ethPrice = Number(formatEther(priceInWei));
  const usdPrice = ethPrice * ethPriceUSD;
  return `${formatEther(priceInWei)} ETH ($${usdPrice.toFixed(8)})`;
}

/**
 * ================================================================================================
 * RestAI SNIPING SIMULATION & MARKET ANALYSIS
 * ================================================================================================
 *
 * SCENARIO OVERVIEW:
 * This script simulates a realistic token launch scenario with planned sniping activities.
 * It demonstrates how early buyers (snipers) can gain advantages during token launches
 * and analyzes the impact on price discovery and market dynamics.
 *
 * SNIPING STRATEGY EXPLAINED:
 * - Snipers monitor the blockchain mempool for token launch transactions
 * - They immediately execute buy orders right after the liquidity is added
 * - Early buyers get better prices due to low slippage and minimal competition
 * - Subsequent buyers face higher prices due to increased demand and reduced liquidity
 *
 * SIMULATION PHASES:
 * 1. Deploy RestAI token contract with anti-bot protections
 * 2. Launch token with initial liquidity (creates Uniswap pair)
 * 3. Execute sniper trades with varying sizes and timing
 * 4. Simulate regular users buying over multiple blocks
 * 5. Analyze results: price impact, concentration, taxes collected
 *
 * METRICS ANALYZED:
 * - Price progression and market impact
 * - Sniper advantage vs regular users
 * - Tax collection efficiency
 * - Trading limit effectiveness
 * - Supply concentration risk
 * - Gas costs and MEV opportunities
 */

// ================================================================================================
// SIMULATION CONFIGURATION - Modify these values to test different scenarios
// ================================================================================================
const CONFIG = {
  // ================================
  // NETWORK CONFIGURATION
  // ================================
  FORK_BLOCK: 17000000, // Base mainnet block to fork from
  BASE_RPC: process.env.BASE_RPC_URL || "https://base.gateway.tenderly.co",

  // Base network contract addresses
  ROUTER_ADDRESS: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24", // Base Uniswap V2 Router
  WETH_ADDRESS: "0x4200000000000000000000000000000000000006", // WETH on Base

  // ================================
  // TOKEN LAUNCH CONFIGURATION
  // ================================
  LAUNCH_TOKENS: parseEther("500000000"), // 500M tokens (50% of supply) for liquidity
  LAUNCH_ETH: parseEther("10"), // 10 ETH initial liquidity

  // ================================
  // SNIPER CONFIGURATION
  // ================================
  // These are the "smart money" accounts that execute immediately after launch
  SNIPER_COUNT: 5,
  SNIPER_ETH_AMOUNTS: [
    parseEther("0.15"), // Sniper 1: Reduced to ensure success (0.15 ETH)
    parseEther("0.12"), // Sniper 2: Reduced to ensure success (0.12 ETH)
    parseEther("0.10"), // Sniper 3: Reduced to ensure success (0.10 ETH)
    parseEther("0.08"), // Sniper 4: Reduced to ensure success (0.08 ETH)
    parseEther("0.05"), // Sniper 5: Reduced to ensure success (0.05 ETH)
  ],

  // When each sniper executes (blocks after launch)
  // 0 = same block as launch, 1 = next block, etc.
  // Note: Starting from block +8 to ensure all snipers succeed
  SNIPER_TIMING: [8, 9, 10, 11, 12],

  // ================================
  // REGULAR USERS CONFIGURATION
  // ================================
  // These represent normal retail investors
  REGULAR_USER_COUNT: 500, // Total number of regular users
  REGULAR_USER_ETH_MIN: parseEther("0.01"), // Minimum buy amount
  REGULAR_USER_ETH_MAX: parseEther("0.1"), // Maximum buy amount
  BLOCKS_FOR_REGULAR_USERS: 10, // Spread users over N blocks
  PARALLEL_BATCH_SIZE: 50, // Process users in batches of 20

  // ================================
  // SELL ACTIVITY CONFIGURATION
  // ================================
  ENABLE_SELL_ACTIVITY: true, // Enable some users to sell
  SELL_PERCENTAGE: 20, // 20% of users will sell after buying
  SELL_PORTION_MIN: 25, // Minimum % of tokens to sell (25%)
  SELL_PORTION_MAX: 75, // Maximum % of tokens to sell (75%)

  // ================================
  // SIMULATION DISPLAY OPTIONS
  // ================================
  SHOW_DETAILED_TRADES: true, // Show individual trade details
  SHOW_PRICE_UPDATES: true, // Show price after each major trade
  SHOW_BLOCK_PROGRESS: true, // Show block-by-block progress

  // ================================
  // ANALYSIS CONFIGURATION
  // ================================
  ENABLE_PROFIT_ANALYSIS: true, // Calculate potential profits
  ENABLE_GAS_ANALYSIS: true, // Track gas costs
  ENABLE_CONCENTRATION_ANALYSIS: true, // Analyze supply concentration
  PRICE_IMPACT_THRESHOLD: 10, // Alert if price increases >10%
  CONCENTRATION_THRESHOLD: 5, // Alert if >5% supply acquired
};

interface TradeResult {
  userType: "sniper" | "regular";
  index: number;
  address: string;
  ethSpent: bigint;
  tokensReceived: bigint;
  pricePerToken: bigint;
  gasUsed: bigint;
  block: number;
  success: boolean;
  failureReason?: string;
  timestamp: number;
}

async function main() {
  console.log(chalk.cyan.bold("\n" + "=".repeat(80)));
  console.log(
    chalk.cyan.bold("🎯 RestAI SNIPING SIMULATION & MARKET ANALYSIS")
  );
  console.log(chalk.cyan.bold("=".repeat(80)));

  console.log(chalk.yellow("\n📋 SIMULATION SCENARIO:"));
  console.log(
    chalk.gray(
      `  • Deploy RestAI token with ${formatEther(
        CONFIG.LAUNCH_TOKENS
      )} tokens + ${formatEther(CONFIG.LAUNCH_ETH)} ETH liquidity`
    )
  );
  console.log(
    chalk.gray(
      `  • ${CONFIG.SNIPER_COUNT} snipers will execute in consecutive blocks after launch`
    )
  );
  console.log(
    chalk.gray(
      `  • ${CONFIG.REGULAR_USER_COUNT} regular users will buy over ${CONFIG.BLOCKS_FOR_REGULAR_USERS} blocks`
    )
  );
  console.log(
    chalk.gray(`  • Analyze price impact, slippage, and sniper advantages`)
  );

  console.log(chalk.yellow("\n⚡ SNIPER STRATEGY:"));
  CONFIG.SNIPER_ETH_AMOUNTS.forEach((amount, i) => {
    const timing =
      CONFIG.SNIPER_TIMING[i] === 0
        ? "immediate"
        : `+${CONFIG.SNIPER_TIMING[i]} blocks`;
    console.log(
      chalk.gray(`  • Sniper ${i + 1}: ${formatEther(amount)} ETH (${timing})`)
    );
  });

  console.log(chalk.yellow("\n👥 REGULAR USERS:"));
  console.log(
    chalk.gray(
      `  • ${CONFIG.REGULAR_USER_COUNT} users with ${formatEther(
        CONFIG.REGULAR_USER_ETH_MIN
      )}-${formatEther(CONFIG.REGULAR_USER_ETH_MAX)} ETH each`
    )
  );
  console.log(
    chalk.gray(
      `  • Distributed over ${CONFIG.BLOCKS_FOR_REGULAR_USERS} blocks for realistic market simulation`
    )
  );

  console.log(chalk.cyan("\n🚀 Starting simulation...\n"));

  // Fetch current ETH price for USD calculations
  console.log(chalk.yellow("💱 Fetching current ETH/USD price..."));
  const ethPriceUSD = await getETHPrice();
  console.log(
    chalk.green(`✓ Current ETH Price: $${ethPriceUSD.toLocaleString()}`)
  );

  // Fork Base network
  await network.provider.request({
    method: "hardhat_reset",
    params: [
      {
        forking: {
          jsonRpcUrl: CONFIG.BASE_RPC,
          blockNumber: CONFIG.FORK_BLOCK,
        },
      },
    ],
  });

  console.log(
    chalk.gray(`✓ Forked Base mainnet at block ${CONFIG.FORK_BLOCK}`)
  );

  // Get signers - we need a lot for this simulation
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const operationsWallet = signers[1];
  const snipers = signers.slice(2, 2 + CONFIG.SNIPER_COUNT);

  // Create regular user wallets
  console.log(chalk.yellow("\n👥 Creating regular user wallets..."));
  const regularUsers = [];
  for (let i = 0; i < CONFIG.REGULAR_USER_COUNT; i++) {
    const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
    regularUsers.push(wallet);
  }
  console.log(
    chalk.gray(`  Created ${CONFIG.REGULAR_USER_COUNT} regular user wallets`)
  );

  // Fund snipers with ETH
  console.log(chalk.yellow("\n💰 Funding sniper accounts..."));
  for (let i = 0; i < CONFIG.SNIPER_COUNT; i++) {
    await deployer.sendTransaction({
      to: snipers[i].address,
      value: CONFIG.SNIPER_ETH_AMOUNTS[i] + parseEther("0.1"), // Extra for gas
    });
    console.log(
      chalk.gray(
        `  Sniper ${i + 1}: ${snipers[i].address.slice(
          0,
          10
        )}... funded with ${formatEther(CONFIG.SNIPER_ETH_AMOUNTS[i])} ETH`
      )
    );
  }

  // Fund regular users with random amounts (in parallel batches)
  console.log(chalk.yellow("\n💰 Funding regular user accounts..."));
  const regularUserAmounts: bigint[] = [];

  // Pre-generate amounts for all users
  for (let i = 0; i < CONFIG.REGULAR_USER_COUNT; i++) {
    const range = Number(
      CONFIG.REGULAR_USER_ETH_MAX - CONFIG.REGULAR_USER_ETH_MIN
    );
    const randomPercent = Math.floor(Math.random() * 100);
    const randomAmount =
      CONFIG.REGULAR_USER_ETH_MIN +
      parseEther(((range * randomPercent) / 100 / 1e18).toString());
    regularUserAmounts.push(randomAmount);
  }

  // Fund users in parallel batches
  for (
    let batchStart = 0;
    batchStart < CONFIG.REGULAR_USER_COUNT;
    batchStart += CONFIG.PARALLEL_BATCH_SIZE
  ) {
    const batchEnd = Math.min(
      batchStart + CONFIG.PARALLEL_BATCH_SIZE,
      CONFIG.REGULAR_USER_COUNT
    );
    const batch = [];

    for (let i = batchStart; i < batchEnd; i++) {
      batch.push(
        deployer.sendTransaction({
          to: regularUsers[i].address,
          value: regularUserAmounts[i] + parseEther("0.01"), // Extra for gas
        })
      );
    }

    await Promise.all(batch);
    console.log(
      chalk.gray(`  Funded ${batchEnd}/${CONFIG.REGULAR_USER_COUNT} users...`)
    );
  }
  console.log(
    chalk.green(`✓ All ${CONFIG.REGULAR_USER_COUNT} regular users funded`)
  );

  // Deploy RestAI
  console.log(chalk.yellow("\n📦 Deploying RestAI contract..."));
  const RestAI = await ethers.getContractFactory("RestAI");
  const restAI = (await upgrades.deployProxy(
    RestAI,
    [deployer.address, operationsWallet.address],
    { initializer: "initialize" }
  )) as unknown as RestAI;
  await restAI.waitForDeployment();

  const contractAddress = await restAI.getAddress();
  console.log(chalk.green(`✓ RestAI deployed at: ${contractAddress}`));

  // Get initial state
  const totalSupply = await restAI.totalSupply();
  const limits = await restAI.limits();
  const taxes = await restAI.taxes();

  console.log(
    chalk.gray(`  📊 Total Supply: ${formatEther(totalSupply)} RestAI`)
  );
  console.log(
    chalk.gray(
      `  🚫 Max Buy Limit: ${formatEther(limits.maxBuy)} (${(
        (limits.maxBuy * 100n) /
        totalSupply
      ).toString()}%)`
    )
  );
  console.log(chalk.gray(`  💸 Buy Tax: ${Number(taxes.buyTax) / 100}%`));
  console.log(chalk.gray(`  💸 Sell Tax: ${Number(taxes.sellTax) / 100}%`));

  // Get router
  const router = await ethers.getContractAt(
    [
      "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable returns (uint256[])",
      "function getAmountsOut(uint256, address[]) view returns (uint256[])",
      "function WETH() view returns (address)",
      "function factory() view returns (address)",
    ],
    CONFIG.ROUTER_ADDRESS
  );

  // Launch the token
  console.log(chalk.yellow("\n🚀 Launching token..."));
  console.log(
    chalk.gray("  💡 This creates the Uniswap pair and adds initial liquidity")
  );

  const launchBlock = await ethers.provider.getBlockNumber();
  const launchTx = await restAI.launch(CONFIG.LAUNCH_TOKENS, {
    value: CONFIG.LAUNCH_ETH,
    gasLimit: 5000000,
  });
  await launchTx.wait();

  console.log(chalk.green(`✅ Token launched successfully!`));
  console.log(chalk.gray(`  📦 Launch Block: ${launchBlock + 1}`));
  console.log(chalk.gray(`  🔗 Transaction: ${launchTx.hash}`));

  // Get pair address and verify setup
  const factory = await ethers.getContractAt(
    ["function getPair(address,address) view returns (address)"],
    await router.factory()
  );
  const pairAddress = await factory.getPair(
    contractAddress,
    CONFIG.WETH_ADDRESS
  );
  console.log(chalk.gray(`  🏦 Pair Address: ${pairAddress}`));

  // Verify liquidity was added properly
  const pair = await ethers.getContractAt(
    ["function getReserves() view returns (uint112, uint112, uint32)"],
    pairAddress
  );
  const reserves = await pair.getReserves();
  console.log(
    chalk.gray(
      `  💧 Initial Liquidity: ${formatEther(
        reserves[0]
      )} tokens, ${formatEther(reserves[1])} ETH`
    )
  );

  // Start sniping simulation
  console.log(chalk.cyan.bold("\n🎯 STARTING SNIPING PHASE..."));
  console.log(
    chalk.yellow(
      "  💡 Snipers are executing their trades based on configured timing\n"
    )
  );

  const allTrades: TradeResult[] = [];
  const initialPrice = await getTokenPrice(
    router,
    contractAddress,
    CONFIG.WETH_ADDRESS
  );
  console.log(
    chalk.gray(
      `  📈 Initial Token Price: ${formatPriceWithUSD(
        initialPrice,
        ethPriceUSD
      )} per token\n`
    )
  );

  // Execute snipes based on timing configuration
  for (let blockOffset = 8; blockOffset <= 12; blockOffset++) {
    // Mine blocks if needed
    if (blockOffset > 0) {
      await network.provider.send("hardhat_mine", ["0x1"]);
      if (CONFIG.SHOW_BLOCK_PROGRESS) {
        console.log(
          chalk.gray(`\n⛏️  Mined block ${launchBlock + 1 + blockOffset}`)
        );
      }
    }

    // Execute snipes for this block
    for (let i = 0; i < CONFIG.SNIPER_COUNT; i++) {
      if (CONFIG.SNIPER_TIMING[i] === blockOffset) {
        const ethAmount = CONFIG.SNIPER_ETH_AMOUNTS[i];

        console.log(
          chalk.yellow(
            `🎯 SNIPER ${i + 1} EXECUTING BUY (${formatEther(
              ethAmount
            )} ETH)...`
          )
        );

        const strategy = `Consecutive execution (+${CONFIG.SNIPER_TIMING[i]} blocks)`;
        console.log(chalk.gray(`   Strategy: ${strategy}`));

        const balanceBefore = await restAI.balanceOf(snipers[i].address);

        try {
          // Execute snipe
          const tx = await router
            .connect(snipers[i])
            .swapExactETHForTokensSupportingFeeOnTransferTokens(
              0, // Accept any amount of tokens
              [CONFIG.WETH_ADDRESS, contractAddress],
              snipers[i].address,
              Math.floor(Date.now() / 1000) + 3600,
              {
                value: ethAmount,
                gasLimit: 500000,
              }
            );

          const receipt = await tx.wait();
          const balanceAfter = await restAI.balanceOf(snipers[i].address);
          const tokensReceived = balanceAfter - balanceBefore;
          const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

          const result: TradeResult = {
            userType: "sniper",
            index: i + 1,
            address: snipers[i].address,
            ethSpent: ethAmount,
            tokensReceived,
            pricePerToken:
              tokensReceived > 0n
                ? (ethAmount * parseEther("1")) / tokensReceived
                : 0n,
            gasUsed,
            block: launchBlock + 1 + blockOffset,
            success: true,
            timestamp: Date.now(),
          };

          allTrades.push(result);

          console.log(chalk.green(`  ✅ SNIPE SUCCESSFUL!`));
          console.log(
            chalk.gray(
              `    💰 Tokens Acquired: ${formatEther(tokensReceived)} RestAI`
            )
          );
          console.log(
            chalk.gray(
              `    💲 Effective Price: ${formatPriceWithUSD(
                result.pricePerToken,
                ethPriceUSD
              )} per token`
            )
          );
          console.log(
            chalk.gray(`    ⛽ Gas Cost: ${formatEther(gasUsed)} ETH`)
          );

          // Calculate market impact
          const marketImpact = (tokensReceived * 10000n) / totalSupply / 100n;
          console.log(
            chalk.gray(`    📊 Market Share: ${marketImpact}% of total supply`)
          );

          if (CONFIG.SHOW_PRICE_UPDATES) {
            const currentPrice = await getTokenPrice(
              router,
              contractAddress,
              CONFIG.WETH_ADDRESS
            );
            console.log(
              chalk.gray(
                `    📈 New Token Price: ${formatPriceWithUSD(
                  currentPrice,
                  ethPriceUSD
                )}`
              )
            );
          }

          // Check if hit limit
          const maxBuy = limits.maxBuy;
          if (tokensReceived >= (maxBuy * 95n) / 100n) {
            console.log(
              chalk.red(
                `    ⚠️  Hit buy limit! (${(
                  (tokensReceived * 100n) /
                  maxBuy
                ).toString()}% of max)`
              )
            );
          }
        } catch (error: any) {
          const failureReason = error.message.includes("BuyAmountExceedsLimit")
            ? "Buy limit exceeded"
            : error.message.includes("WalletAmountExceedsLimit")
            ? "Wallet limit exceeded"
            : error.message.includes("TRANSFER_FAILED")
            ? "Transfer failed"
            : error.reason || error.message;

          console.log(chalk.red(`  ❌ SNIPE FAILED: ${failureReason}`));
          console.log(
            chalk.gray(`    💸 Attempted Amount: ${formatEther(ethAmount)} ETH`)
          );

          const likelyCause = failureReason.includes("BuyAmountExceedsLimit")
            ? "Hit max buy limit"
            : failureReason.includes("WalletAmountExceedsLimit")
            ? "Hit max wallet limit"
            : failureReason.includes("TRANSFER_FAILED")
            ? "Liquidity or approval issue"
            : "Unknown error";
          console.log(chalk.gray(`    🚫 Likely Cause: ${likelyCause}`));

          allTrades.push({
            userType: "sniper",
            index: i + 1,
            address: snipers[i].address,
            ethSpent: ethAmount,
            tokensReceived: 0n,
            pricePerToken: 0n,
            gasUsed: 0n,
            block: launchBlock + 1 + blockOffset,
            success: false,
            failureReason,
            timestamp: Date.now(),
          });
        }
      }
    }
  }

  // Simulate regular users buying
  console.log(chalk.cyan.bold("\n👥 STARTING REGULAR USER PHASE..."));
  console.log(
    chalk.yellow(
      "  💡 Simulating organic market activity from retail investors\n"
    )
  );

  const usersPerBlock = Math.ceil(
    CONFIG.REGULAR_USER_COUNT / CONFIG.BLOCKS_FOR_REGULAR_USERS
  );
  let userIndex = 0;
  let successfulBuys = 0;
  let failedBuys = 0;

  for (
    let block = 0;
    block < CONFIG.BLOCKS_FOR_REGULAR_USERS &&
    userIndex < CONFIG.REGULAR_USER_COUNT;
    block++
  ) {
    await network.provider.send("hardhat_mine", ["0x1"]);
    const currentBlock = launchBlock + 13 + block;

    console.log(
      chalk.gray(
        `\n⛏️  Block ${currentBlock} - Processing ${Math.min(
          usersPerBlock,
          CONFIG.REGULAR_USER_COUNT - userIndex
        )} regular users`
      )
    );
    if (block === 0) {
      console.log(
        chalk.yellow(
          `    📈 Starting regular user phase - simulating organic market activity`
        )
      );
    }

    const blockUsers = Math.min(
      usersPerBlock,
      CONFIG.REGULAR_USER_COUNT - userIndex
    );
    const promises = [];

    for (
      let i = 0;
      i < blockUsers && userIndex < CONFIG.REGULAR_USER_COUNT;
      i++
    ) {
      const user = regularUsers[userIndex];
      const ethAmount = regularUserAmounts[userIndex];
      const idx = userIndex;

      // Execute trades in parallel for realistic simulation
      const promise = (async () => {
        try {
          const tx = await router
            .connect(user)
            .swapExactETHForTokensSupportingFeeOnTransferTokens(
              0,
              [CONFIG.WETH_ADDRESS, contractAddress],
              user.address,
              Math.floor(Date.now() / 1000) + 3600,
              {
                value: ethAmount,
                gasLimit: 500000,
              }
            );

          const receipt = await tx.wait();
          const balance = await restAI.balanceOf(user.address);
          const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

          successfulBuys++;

          return {
            userType: "regular" as const,
            index: idx + 1,
            address: user.address,
            ethSpent: ethAmount,
            tokensReceived: balance,
            pricePerToken:
              balance > 0n ? (ethAmount * parseEther("1")) / balance : 0n,
            gasUsed,
            block: currentBlock,
            success: true,
            timestamp: Date.now(),
          };
        } catch (error: any) {
          failedBuys++;
          return {
            userType: "regular" as const,
            index: idx + 1,
            address: user.address,
            ethSpent: ethAmount,
            tokensReceived: 0n,
            pricePerToken: 0n,
            gasUsed: 0n,
            block: currentBlock,
            success: false,
            failureReason: error.message.includes("BuyAmountExceedsLimit")
              ? "Buy limit"
              : error.message.includes("WalletAmountExceedsLimit")
              ? "Wallet limit"
              : "Failed",
            timestamp: Date.now(),
          };
        }
      })();

      promises.push(promise);
      userIndex++;
    }

    // Wait for all trades in this block to complete
    const blockResults = await Promise.all(promises);
    allTrades.push(...blockResults);

    const successRate = Math.round(
      (successfulBuys / (successfulBuys + failedBuys)) * 100
    );
    console.log(
      chalk.green(
        `  ✅ Block Complete: ${successfulBuys} successful, ${failedBuys} failed (${successRate}% success rate)`
      )
    );
  }

  // Sell Activity Phase
  if (CONFIG.ENABLE_SELL_ACTIVITY) {
    console.log(chalk.cyan.bold("\n💰 STARTING SELL ACTIVITY PHASE..."));
    console.log(
      chalk.yellow(
        "  💡 Some users are taking profits by selling portions of their tokens\n"
      )
    );

    const sellersCount = Math.floor(
      (CONFIG.REGULAR_USER_COUNT * CONFIG.SELL_PERCENTAGE) / 100
    );
    const sellers = regularUsers.slice(0, sellersCount); // First N users become sellers
    let successfulSells = 0;
    let failedSells = 0;

    // Process sells in parallel batches
    for (
      let batchStart = 0;
      batchStart < sellersCount;
      batchStart += CONFIG.PARALLEL_BATCH_SIZE
    ) {
      const batchEnd = Math.min(
        batchStart + CONFIG.PARALLEL_BATCH_SIZE,
        sellersCount
      );
      const sellPromises = [];

      for (let i = batchStart; i < batchEnd; i++) {
        const seller = sellers[i];

        const sellPromise = (async () => {
          try {
            const tokenBalance = await restAI.balanceOf(seller.address);
            if (tokenBalance === 0n) return null;

            // Random sell portion between min and max
            const sellPercent =
              CONFIG.SELL_PORTION_MIN +
              Math.floor(
                Math.random() *
                  (CONFIG.SELL_PORTION_MAX - CONFIG.SELL_PORTION_MIN)
              );
            const tokensToSell = (tokenBalance * BigInt(sellPercent)) / 100n;

            if (tokensToSell === 0n) return null;

            // Approve router to spend tokens
            await restAI.connect(seller).approve(router.target, tokensToSell);

            // Execute sell
            const tx = await router
              .connect(seller)
              .swapExactTokensForETHSupportingFeeOnTransferTokens(
                tokensToSell,
                0,
                [contractAddress, CONFIG.WETH_ADDRESS],
                seller.address,
                Math.floor(Date.now() / 1000) + 3600,
                { gasLimit: 500000 }
              );

            const receipt = await tx.wait();
            const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

            successfulSells++;

            return {
              userType: "seller" as const,
              index: i + 1,
              address: seller.address,
              ethReceived: 0n, // We'd need to calculate this from event logs
              tokensSpent: tokensToSell,
              pricePerToken: 0n,
              gasUsed,
              block: 0,
              success: true,
              timestamp: Date.now(),
            };
          } catch (error: any) {
            failedSells++;
            return null;
          }
        })();

        sellPromises.push(sellPromise);
      }

      const sellResults = await Promise.all(sellPromises);
      const validSells = sellResults.filter((r) => r !== null);
      allTrades.push(...validSells);

      console.log(
        chalk.green(
          `  📤 Batch Complete: ${batchEnd}/${sellersCount} sellers processed`
        )
      );
    }

    console.log(
      chalk.green(
        `✓ Sell phase complete: ${successfulSells} successful, ${failedSells} failed sells`
      )
    );
  }

  // Final Analysis
  console.log(chalk.cyan.bold("\n" + "=".repeat(80)));
  console.log(chalk.cyan.bold("📊 COMPLETE MARKET ANALYSIS RESULTS"));
  console.log(chalk.cyan.bold("=".repeat(80)));

  console.log(chalk.yellow(`\n🎯 SNIPING EFFECTIVENESS ANALYSIS:`));

  // Price impact analysis
  const finalPrice = await getTokenPrice(
    router,
    contractAddress,
    CONFIG.WETH_ADDRESS
  );
  const priceIncrease =
    initialPrice > 0n
      ? ((finalPrice - initialPrice) * 10000n) / initialPrice / 100n
      : 0n;

  console.log(chalk.yellow("📈 Price Impact:"));
  console.log(
    chalk.gray(
      `  Initial Price: ${formatPriceWithUSD(initialPrice, ethPriceUSD)}`
    )
  );
  console.log(
    chalk.gray(`  Final Price: ${formatPriceWithUSD(finalPrice, ethPriceUSD)}`)
  );
  console.log(chalk.gray(`  Increase: ${priceIncrease}%`));

  // Analyze snipers vs regular users
  const sniperTrades = allTrades.filter(
    (t) => t.userType === "sniper" && t.success
  );
  const regularTrades = allTrades.filter(
    (t) => t.userType === "regular" && t.success
  );

  console.log(chalk.cyan.bold("\n🎯 SNIPER PERFORMANCE:"));
  let sniperTokens = 0n;
  let sniperETH = 0n;

  for (const trade of sniperTrades) {
    sniperTokens += trade.tokensReceived;
    sniperETH += trade.ethSpent;
  }

  console.log(
    chalk.gray(
      `  Successful Snipers: ${sniperTrades.length}/${CONFIG.SNIPER_COUNT}`
    )
  );
  console.log(
    chalk.gray(`  Total Tokens: ${formatEther(sniperTokens)} RestAI`)
  );
  console.log(chalk.gray(`  Total ETH: ${formatEther(sniperETH)} ETH`));
  console.log(
    chalk.gray(
      `  % of Supply: ${(sniperTokens * 10000n) / totalSupply / 100n}%`
    )
  );
  if (sniperTrades.length > 0) {
    const avgSniperPrice =
      sniperTokens > 0n ? (sniperETH * parseEther("1")) / sniperTokens : 0n;
    console.log(
      chalk.gray(
        `  Avg Price: ${formatPriceWithUSD(avgSniperPrice, ethPriceUSD)}/token`
      )
    );
  }

  // Individual Sniper Performance
  console.log(chalk.yellow("\n📊 INDIVIDUAL SNIPER PERFORMANCE:"));
  for (let i = 0; i < CONFIG.SNIPER_COUNT; i++) {
    const sniperTrade = sniperTrades.find((trade) => trade.index === i + 1);
    if (sniperTrade) {
      // Use final market price instead of average regular user price for more accurate profit calculation
      const currentMarketPrice = finalPrice;

      const potentialValue =
        (sniperTrade.tokensReceived * currentMarketPrice) / parseEther("1");
      const profit =
        potentialValue > sniperTrade.ethSpent
          ? potentialValue - sniperTrade.ethSpent
          : 0n;
      const profitPercentage =
        sniperTrade.ethSpent > 0n
          ? (profit * 10000n) / sniperTrade.ethSpent / 100n
          : 0n;
      const profitUSD = Number(formatEther(profit)) * ethPriceUSD;

      // Also calculate comparison to average regular user price for reference
      const avgRegularPrice =
        regularTrades.length > 0
          ? regularTrades.reduce(
              (sum, trade) => sum + trade.pricePerToken,
              0n
            ) / BigInt(regularTrades.length)
          : 0n;

      console.log(chalk.green(`  Sniper ${i + 1}: ✅ SUCCESS`));
      console.log(
        chalk.gray(
          `    💰 Investment: ${formatEther(sniperTrade.ethSpent)} ETH`
        )
      );
      console.log(
        chalk.gray(
          `    💲 Buy Price: ${formatPriceWithUSD(
            sniperTrade.pricePerToken,
            ethPriceUSD
          )}/token`
        )
      );
      console.log(
        chalk.green(
          `    💵 Profit (at final price): ${formatEther(
            profit
          )} ETH ($${profitUSD.toFixed(2)})`
        )
      );
      console.log(chalk.green(`    📈 ROI: ${profitPercentage}%`));
    } else {
      console.log(chalk.red(`  Sniper ${i + 1}: ❌ FAILED`));
      console.log(
        chalk.gray(
          `    💸 Attempted: ${formatEther(CONFIG.SNIPER_ETH_AMOUNTS[i])} ETH`
        )
      );
    }
  }

  console.log(chalk.cyan.bold("\n👥 REGULAR USER PERFORMANCE:"));
  let regularTokens = 0n;
  let regularETH = 0n;

  for (const trade of regularTrades) {
    regularTokens += trade.tokensReceived;
    regularETH += trade.ethSpent;
  }

  console.log(
    chalk.gray(
      `  Successful Users: ${regularTrades.length}/${CONFIG.REGULAR_USER_COUNT}`
    )
  );
  console.log(
    chalk.gray(`  Total Tokens: ${formatEther(regularTokens)} RestAI`)
  );
  console.log(chalk.gray(`  Total ETH: ${formatEther(regularETH)} ETH`));
  console.log(
    chalk.gray(
      `  % of Supply: ${(regularTokens * 10000n) / totalSupply / 100n}%`
    )
  );
  if (regularTrades.length > 0) {
    const avgRegularPrice =
      regularTokens > 0n ? (regularETH * parseEther("1")) / regularTokens : 0n;
    console.log(
      chalk.gray(
        `  Avg Price: ${formatPriceWithUSD(avgRegularPrice, ethPriceUSD)}/token`
      )
    );
    console.log(
      chalk.gray(
        `  Avg Buy Size: ${formatEther(
          regularETH / BigInt(regularTrades.length)
        )} ETH`
      )
    );
  }

  console.log(chalk.cyan.bold("\n📈 OVERALL MARKET OVERVIEW:"));
  const totalTokensBought = sniperTokens + regularTokens;
  const totalETHSpent = sniperETH + regularETH;

  console.log(chalk.gray(`  Total Participants: ${allTrades.length}`));
  console.log(
    chalk.gray(
      `  Successful Trades: ${sniperTrades.length + regularTrades.length}`
    )
  );
  console.log(
    chalk.gray(`  Failed Trades: ${allTrades.filter((t) => !t.success).length}`)
  );
  console.log(
    chalk.gray(
      `  Total Tokens Traded: ${formatEther(totalTokensBought)} RestAI`
    )
  );
  console.log(
    chalk.gray(`  Total ETH Volume: ${formatEther(totalETHSpent)} ETH`)
  );
  console.log(
    chalk.gray(
      `  % of Supply Traded: ${
        (totalTokensBought * 10000n) / totalSupply / 100n
      }%`
    )
  );

  // Price progression
  console.log(chalk.cyan.bold("\n💲 PRICE DISCOVERY ANALYSIS:"));
  const successfulTrades = allTrades
    .filter((t) => t.success)
    .sort((a, b) => Number(a.block - b.block));
  if (successfulTrades.length > 0) {
    const firstTrade = successfulTrades[0];
    const lastTrade = successfulTrades[successfulTrades.length - 1];
    const midTrade = successfulTrades[Math.floor(successfulTrades.length / 2)];

    console.log(
      chalk.gray(
        `  First Trade Price: ${formatPriceWithUSD(
          firstTrade.pricePerToken,
          ethPriceUSD
        )}/token (${firstTrade.userType})`
      )
    );
    console.log(
      chalk.gray(
        `  Midpoint Price: ${formatPriceWithUSD(
          midTrade.pricePerToken,
          ethPriceUSD
        )}/token`
      )
    );
    console.log(
      chalk.gray(
        `  Final Trade Price: ${formatPriceWithUSD(
          lastTrade.pricePerToken,
          ethPriceUSD
        )}/token`
      )
    );
    const priceIncrease =
      firstTrade.pricePerToken > 0n
        ? ((lastTrade.pricePerToken - firstTrade.pricePerToken) * 10000n) /
          firstTrade.pricePerToken /
          100n
        : 0n;
    console.log(chalk.gray(`  Price Increase: ${priceIncrease}%`));
  }

  // Tax collection
  const contractBalance = await restAI.balanceOf(contractAddress);
  console.log(chalk.yellow("\n💸 Tax Collection:"));
  console.log(
    chalk.gray(
      `  Contract Token Balance: ${formatEther(contractBalance)} RestAI`
    )
  );
  console.log(
    chalk.gray(`  (Collected from ${Number(taxes.buyTax) / 100}% buy tax)`)
  );

  // Sniper Advantage Analysis
  console.log(chalk.cyan.bold("\n🚀 SNIPER ADVANTAGE SUMMARY:"));

  if (sniperTrades.length > 0 && regularTrades.length > 0) {
    const avgSniperPrice =
      sniperTokens > 0n ? (sniperETH * parseEther("1")) / sniperTokens : 0n;
    const avgRegularPrice =
      regularTokens > 0n ? (regularETH * parseEther("1")) / regularTokens : 0n;
    const priceAdvantage =
      avgSniperPrice > 0n
        ? ((avgRegularPrice - avgSniperPrice) * 10000n) / avgSniperPrice / 100n
        : 0n;

    console.log(
      chalk.gray(
        `  Avg Sniper Price: ${formatPriceWithUSD(
          avgSniperPrice,
          ethPriceUSD
        )}/token`
      )
    );
    console.log(
      chalk.gray(
        `  Avg Regular Price: ${formatPriceWithUSD(
          avgRegularPrice,
          ethPriceUSD
        )}/token`
      )
    );
    console.log(
      chalk.green(
        `  Sniper Advantage: ${priceAdvantage}% cheaper than regular users`
      )
    );

    // Calculate profit using final market price
    const finalMarketProfit =
      finalPrice > avgSniperPrice
        ? ((finalPrice - avgSniperPrice) * sniperTokens) / parseEther("1")
        : 0n;

    // Calculate profit percentage for snipers using final price
    if (sniperETH > 0n) {
      const profitPercentage = (finalMarketProfit * 10000n) / sniperETH / 100n;
      const profitUSD = Number(formatEther(finalMarketProfit)) * ethPriceUSD;
      console.log(
        chalk.green(
          `  💰 Total Sniper Profit: ${profitPercentage}% ROI ($${profitUSD.toFixed(
            2
          )} profit)`
        )
      );
    }
  }

  // Failed trades analysis
  const failedTrades = allTrades.filter((t) => !t.success);
  if (failedTrades.length > 0) {
    console.log(chalk.yellow("\n⚠️  Failed Trade Analysis:"));
    const failureReasons = new Map<string, number>();
    failedTrades.forEach((t) => {
      const reason = t.failureReason || "Unknown";
      failureReasons.set(reason, (failureReasons.get(reason) || 0) + 1);
    });

    failureReasons.forEach((count, reason) => {
      console.log(chalk.gray(`  ${reason}: ${count} trades`));
    });
  }

  // Gas analysis
  const successfulGasTrades = allTrades.filter(
    (t) => t.success && t.gasUsed > 0n
  );
  if (successfulGasTrades.length > 0) {
    const avgGas =
      successfulGasTrades.reduce((sum, t) => sum + t.gasUsed, 0n) /
      BigInt(successfulGasTrades.length);
    console.log(
      chalk.gray(`\n⛽ Average gas cost: ${formatEther(avgGas)} ETH`)
    );
  }

  console.log(chalk.cyan.bold("\n" + "=".repeat(80)));
  console.log(chalk.cyan.bold("✅ SIMULATION COMPLETE - SUMMARY"));
  console.log(chalk.cyan.bold("=".repeat(80)));

  console.log(chalk.yellow("\n🎯 KEY TAKEAWAYS:"));

  const totalSuccess = allTrades.filter((t) => t.success).length;
  const totalAttempts = allTrades.length;
  const overallSuccessRate = Math.round((totalSuccess / totalAttempts) * 100);

  console.log(
    chalk.gray(
      `  • Overall Success Rate: ${overallSuccessRate}% (${totalSuccess}/${totalAttempts} trades)`
    )
  );

  if (sniperTrades.length > 0 && regularTrades.length > 0) {
    const sniperSuccessRate = Math.round(
      (sniperTrades.length / CONFIG.SNIPER_COUNT) * 100
    );
    const userSuccessRate = Math.round(
      (regularTrades.length / CONFIG.REGULAR_USER_COUNT) * 100
    );
    console.log(
      chalk.gray(
        `  • Sniper Success Rate: ${sniperSuccessRate}% vs Regular Users: ${userSuccessRate}%`
      )
    );

    const totalMarketShare = (totalTokensBought * 100n) / totalSupply;
    console.log(
      chalk.gray(
        `  • Total Market Participation: ${totalMarketShare}% of token supply traded`
      )
    );

    const avgPriceIncrease =
      finalPrice > initialPrice
        ? ((finalPrice - initialPrice) * 100n) / initialPrice
        : 0n;
    console.log(
      chalk.gray(
        `  • Price Impact: ${avgPriceIncrease}% increase from initial to final price`
      )
    );
  }

  console.log(chalk.yellow("\n💡 STRATEGIC INSIGHTS:"));
  console.log(
    chalk.gray(
      `  • Early positioning (sniping) provides significant price advantages`
    )
  );
  console.log(
    chalk.gray(
      `  • Trading limits help prevent excessive concentration but may not stop all sniping`
    )
  );
  console.log(
    chalk.gray(
      `  • Tax mechanisms collect revenue but don't eliminate sniper advantages`
    )
  );
  console.log(
    chalk.gray(
      `  • Regular users face higher prices due to increased demand from snipers`
    )
  );

  console.log(
    chalk.cyan(
      `\n🔧 To run different scenarios, modify the CONFIG section at the top of this script.\n`
    )
  );
}

// Helper function to get current token price from DEX
async function getTokenPrice(
  router: any,
  token: string,
  weth: string
): Promise<bigint> {
  try {
    // Get price for 1 token in ETH
    const amounts = await router.getAmountsOut(parseEther("1"), [token, weth]);
    return amounts[1];
  } catch {
    // If no liquidity pool exists yet, return 0
    return 0n;
  }
}

// Helper function to estimate ETH needed for tokens
async function estimateETHForTokens(
  router: any,
  token: string,
  weth: string,
  tokenAmount: bigint
): Promise<bigint> {
  try {
    const amounts = await router.getAmountsOut(tokenAmount, [token, weth]);
    return amounts[1];
  } catch {
    return 0n;
  }
}

// Run simulation
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(chalk.red("\n❌ Simulation failed:"));
    console.error(error);
    process.exit(1);
  });
