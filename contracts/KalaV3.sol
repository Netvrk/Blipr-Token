// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/*
 * -----------------------------
 *    UNISWAP V3 INTERFACES
 * -----------------------------
 *
 * You can import these from the official Uniswap v3-periphery repository,
 * or define minimal versions yourself.
 *
 * - https://github.com/Uniswap/v3-periphery
 * - https://github.com/Uniswap/v3-core
 */

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut);
}

interface INonfungiblePositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function createAndInitializePoolIfNecessary(
        address token0,
        address token1,
        uint24 fee,
        uint160 sqrtPriceX96
    ) external payable returns (address pool);

    function mint(
        MintParams calldata params
    )
        external
        payable
        returns (
            uint256 tokenId,
            uint128 liquidity,
            uint256 amount0,
            uint256 amount1
        );
}

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

/**
 * @title KalaV3 (Example)
 */
contract KalaV3 is
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable
{
    // --------------------------
    //       ROLES
    // --------------------------
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    // --------------------------
    //     UNISWAP V3 DATA
    // --------------------------
    ISwapRouter public uniswapV3Router;
    INonfungiblePositionManager public positionManager;

    // example: 0.3% pool
    uint24 public constant POOL_FEE = 3000;

    // This will be the address of the pool you create.
    // You could store multiple pool addresses if you want to track multiple.
    address public uniswapV3Pool;

    address public operationsWallet;

    // MISC
    bool public isTaxEnabled;
    bool public isLaunched;
    bool private inSwap;

    // fee (in basis points; 100 = 1%)
    uint256 public buyFee;
    uint256 public sellFee;
    uint256 public transferFee;
    uint256 public constant MAX_FEE = 6000; // 60%
    uint256 public constant DENOMINATOR = 10000;

    // Example threshold to trigger swaps
    uint256 public swapTokensAtAmount;

    // track addresses excluded from fees
    mapping(address => bool) public isExcludedFromFees;

    // track recognized "AMM pool" addresses for buy/sell detection
    mapping(address => bool) public automatedMarketMakerPairs;

    // Using a reentrancy guard pattern
    modifier lockSwap() {
        inSwap = true;
        _;
        inSwap = false;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // -------------------------------------------------
    //  INITIALIZE (instead of constructor)
    // -------------------------------------------------
    function initialize(
        address _operationsWallet,
        address _swapRouter,
        address _positionManager
    ) external initializer {
        __ERC20_init("KalaV3", "KALA-V3");
        __ERC20Permit_init("KalaV3");
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        // Set Roles
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MANAGER_ROLE, msg.sender);
        _grantRole(UPGRADER_ROLE, msg.sender);

        // set addresses
        operationsWallet = _operationsWallet;
        uniswapV3Router = ISwapRouter(_swapRouter);
        positionManager = INonfungiblePositionManager(_positionManager);

        // default fees
        isTaxEnabled = true;
        buyFee = 1000; // 10%
        sellFee = 1000; // 10%
        transferFee = 500; // 5%

        // default threshold for swap
        uint256 totalSupply = 100_000_000 * 1e18;
        swapTokensAtAmount = (totalSupply * 20) / DENOMINATOR; // 0.2% of supply

        // exclude some addresses from fees
        isExcludedFromFees[msg.sender] = true;
        isExcludedFromFees[address(this)] = true;
        isExcludedFromFees[_operationsWallet] = true;

        // mint total supply to deployer
        _mint(msg.sender, totalSupply);
    }

    // UUPS upgrade authorization
    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyRole(UPGRADER_ROLE) {}

    receive() external payable {}

    // -------------------------------------------------
    //  EXAMPLE "LAUNCH" for UNISWAP V3
    // -------------------------------------------------
    /**
     * @dev Create and Initialize a Uniswap V3 pool if it doesn't exist,
     *      then mint an initial liquidity position.
     * @param tokenAmount The amount of this token to add as liquidity
     * @param ethAmount   The ETH amount to pair with tokenAmount
     * @param tickLower   Lower tick range
     * @param tickUpper   Upper tick range
     * @param sqrtPriceX96 The sqrt price for initialization if pool doesn't exist
     */
    function launch(
        uint256 tokenAmount,
        uint256 ethAmount,
        int24 tickLower,
        int24 tickUpper,
        uint160 sqrtPriceX96
    ) external payable onlyRole(MANAGER_ROLE) nonReentrant {
        require(!isLaunched, "AlreadyLaunched");
        require(tokenAmount > 0, "ZeroTokenAmount");
        require(ethAmount > 0, "ZeroEthAmount");
        require(msg.value >= ethAmount, "Insufficient ETH sent");

        // Transfer tokens from manager to this contract
        _update(msg.sender, address(this), tokenAmount);

        // Approve position manager to use these tokens
        _approve(address(this), address(positionManager), tokenAmount);

        // Step 1: Create/Initialize Pool if necessary
        //  - token0 < token1 by address, or you'll get a different ordering
        //    than you might expect. Adjust accordingly in production.
        //  - For simplicity, assume this contract's token is token0
        //    if address(this) < WETH, etc.
        // In production, you'd need the WETH address here.
        // For demonstration, assume `0xC02AAA...` is WETH on mainnet.
        // Adjust for your chain/test environment.
        address WETH9 = 0x4200000000000000000000000000000000000006;

        bool isToken0 = address(this) < WETH9;
        address token0 = isToken0 ? address(this) : WETH9;
        address token1 = isToken0 ? WETH9 : address(this);

        // Create or get pool
        address pool = positionManager.createAndInitializePoolIfNecessary(
            token0,
            token1,
            POOL_FEE,
            sqrtPriceX96
        );
        uniswapV3Pool = pool; // store reference

        // Mark this pool as an AMM pair for fee logic
        _setAutomatedMarketMakerPair(pool, true);

        // Step 2: Actually mint an LP position (NFT)
        // We must deposit the ETH into the position manager’s contract as well.
        // Wrap it if needed (WETH).
        // For simplicity, we assume the positionManager can handle msg.value if using WETH9
        // (in practice, you'd deposit WETH or use a specialized function).
        INonfungiblePositionManager.MintParams memory params = INonfungiblePositionManager
            .MintParams({
                token0: token0,
                token1: token1,
                fee: POOL_FEE,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: isToken0 ? tokenAmount : 0,
                amount1Desired: isToken0 ? 0 : tokenAmount,
                amount0Min: 0,
                amount1Min: 0,
                recipient: msg.sender, // or address(this) if you want to hold the NFT
                deadline: block.timestamp
            });

        // Actually call mint
        (, uint128 liquidity, , ) = positionManager.mint{value: ethAmount}(
            params
        );

        require(liquidity > 0, "No liquidity minted");

        // If any ETH leftover in this function call, it remains in the contract.
        // Or you can refund it back to the caller if you like.

        // Flag as launched
        isLaunched = true;
    }

    // -------------------------------------------------
    //  EXAMPLE SWAP BACK (TOKENS -> ETH)
    //  Using Uniswap V3 Router
    // -------------------------------------------------
    /**
     * @dev Swap an amount of tokens for ETH via Uniswap V3
     *      using exactInputSingle with a known fee tier.
     */
    function _swapTokensForEth(uint256 tokenAmount) internal lockSwap {
        // Approve the router to spend tokens
        _approve(address(this), address(uniswapV3Router), tokenAmount);

        // Construct swap params
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter
            .ExactInputSingleParams({
                tokenIn: address(this),
                tokenOut: 0x4200000000000000000000000000000000000006, // WETH9 on mainnet
                fee: POOL_FEE,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: tokenAmount,
                amountOutMinimum: 0, // WARNING: no slippage protection
                sqrtPriceLimitX96: 0
            });

        // Execute swap
        uniswapV3Router.exactInputSingle(params);

        // Now contract holds WETH, not raw ETH.
        // You must unwrap WETH9 if you want actual ETH. This code snippet
        // does not demonstrate the unwrap.
        // A typical approach:
        // IWETH9(WETH).withdraw(IERC20(WETH).balanceOf(address(this)));

        // then you'd do something with the ETH, e.g.,
        // send to operationsWallet
        // (bool success, ) = operationsWallet.call{value: ethAmount}("");
    }

    // -------------------------------------------------
    //  EXAMPLE MANUAL SWAP
    // -------------------------------------------------
    function manualSwap(uint256 percent) external onlyRole(MANAGER_ROLE) {
        uint256 balance = balanceOf(address(this));
        uint256 amountToSwap = (balance * percent) / DENOMINATOR;
        require(amountToSwap > 0, "Nothing to swap");
        _swapTokensForEth(amountToSwap);
    }

    // -------------------------------------------------
    //   TRANSFER OVERRIDE - ADD TAX LOGIC
    // -------------------------------------------------
    function _update(
        address from,
        address to,
        uint256 amount
    ) internal virtual override {
        require(
            isLaunched || isExcludedFromFees[from] || isExcludedFromFees[to],
            "NotLaunched"
        );

        // early return if zero amount
        if (amount == 0) {
            super._update(from, to, 0);
            return;
        }

        uint256 finalAmount = amount;

        // Apply fees if enabled, not swapping, and neither party is excluded
        bool applyFee = isTaxEnabled &&
            !inSwap &&
            !isExcludedFromFees[from] &&
            !isExcludedFromFees[to];

        if (applyFee) {
            // identify buy/sell/transfer
            bool isBuy = automatedMarketMakerPairs[from];
            bool isSell = automatedMarketMakerPairs[to];
            uint256 fees;
            if (isBuy && buyFee > 0) {
                fees = (amount * buyFee) / DENOMINATOR;
            } else if (isSell && sellFee > 0) {
                fees = (amount * sellFee) / DENOMINATOR;
            } else if (!isBuy && !isSell && transferFee > 0) {
                fees = (amount * transferFee) / DENOMINATOR;
            }

            if (fees > 0) {
                finalAmount = amount - fees;
                super._update(from, address(this), fees);
            }
        }

        // Possibly trigger a swap if enough tokens have accumulated
        // (only if not a buy, to avoid re-entrancy on the same tx)
        if (
            !inSwap &&
            automatedMarketMakerPairs[to] && // if it's a sell, typically
            balanceOf(address(this)) >= swapTokensAtAmount
        ) {
            _swapTokensForEth(swapTokensAtAmount);
        }

        // Normal transfer
        super._update(from, to, finalAmount);
    }

    // -------------------------------------------------
    //      HELPER: set/unset AMM pairs
    // -------------------------------------------------
    function setAutomatedMarketMakerPair(
        address pool,
        bool value
    ) external onlyRole(MANAGER_ROLE) {
        _setAutomatedMarketMakerPair(pool, value);
    }

    function _setAutomatedMarketMakerPair(address pool, bool value) internal {
        automatedMarketMakerPairs[pool] = value;
    }

    // -------------------------------------------------
    //      ADMIN FEE/LIMIT FUNCTIONS
    // -------------------------------------------------
    function setFees(
        uint256 _buyFee,
        uint256 _sellFee,
        uint256 _updateFee
    ) external onlyRole(MANAGER_ROLE) {
        require(_buyFee <= MAX_FEE, "Buy fee too high");
        require(_sellFee <= MAX_FEE, "Sell fee too high");
        require(_updateFee <= MAX_FEE, "Transfer fee too high");
        buyFee = _buyFee;
        sellFee = _sellFee;
        transferFee = _updateFee;
    }

    function setTaxesEnabled(bool enabled) external onlyRole(MANAGER_ROLE) {
        isTaxEnabled = enabled;
    }

    function excludeFromFees(
        address account,
        bool excluded
    ) external onlyRole(MANAGER_ROLE) {
        isExcludedFromFees[account] = excluded;
    }

    // -------------------------------------------------
    //      MISC
    // -------------------------------------------------
    function withdrawStuckTokens(
        address _token
    ) external onlyRole(MANAGER_ROLE) {
        if (_token == address(0)) {
            // withdraw ETH
            uint256 balanceETH = address(this).balance;
            require(balanceETH > 0, "No ETH to withdraw");
            (bool success, ) = msg.sender.call{value: balanceETH}("");
            require(success, "Withdraw ETH failed");
        } else {
            uint256 bal = IERC20(_token).balanceOf(address(this));
            require(bal > 0, "No tokens to withdraw");
            IERC20(_token).transfer(msg.sender, bal);
        }
    }
}
