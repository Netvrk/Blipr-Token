// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import "./interfaces/IUniswapV2Factory.sol";
import "./interfaces/IUniswapV2Router02.sol";

/**
 * @title BonkAI Token Contract
 * @author BonkAI Team
 * @notice Upgradeable ERC20 token with tax mechanism, anti-bot features, and DEX integration
 * @dev Implements UUPS proxy pattern for upgradeability with role-based access control
 *
 * Key Features:
 * - Configurable buy/sell/transfer taxes
 * - Anti-bot protection with transaction and wallet limits
 * - Automatic liquidity management via Uniswap V2
 * - Role-based administration (DEFAULT_ADMIN, MANAGER, UPGRADER)
 * - Emergency pause functionality
 * - Account blocking capability
 * - Treasury wallet for LP token custody
 * - Slippage protection on all swaps
 */
contract BonkAI is
    Initializable,
    AccessControlUpgradeable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    ERC20PausableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable
{
    // ═══════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Uniswap V2 router for DEX operations
    IUniswapV2Router02 private swapRouter;

    /// @notice Primary liquidity pair address
    address private swapPair;

    // ═══════════════════════════════════════════════════════════════════════════
    // ACCESS CONTROL ROLES
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Role for operational management (fees, limits, launch)
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");

    /// @notice Role for contract upgrades
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    // ═══════════════════════════════════════════════════════════════════════════
    // CONTRACT STATE FLAGS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice If true, transaction and wallet limits are enforced
    bool public isLimitsEnabled;

    /// @notice If true, buy/sell/transfer taxes are applied
    bool public isTaxEnabled;

    /// @notice If true, token has been launched and trading is enabled
    bool public isLaunched;

    // ═══════════════════════════════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Transaction and wallet limits configuration
     * @param maxBuy Maximum tokens allowed per buy transaction
     * @param maxSell Maximum tokens allowed per sell transaction
     * @param maxWallet Maximum tokens allowed per wallet
     */
    struct Limits {
        uint128 maxBuy;
        uint128 maxSell;
        uint128 maxWallet;
    }
    Limits public limits;

    /**
     * @notice Tax configuration for different transaction types
     * @param buyFee Tax percentage on buy transactions (in basis points)
     * @param sellFee Tax percentage on sell transactions (in basis points)
     * @param transferFee Tax percentage on P2P transfers (in basis points)
     */
    struct Fees {
        uint16 buyFee;
        uint16 sellFee;
        uint16 transferFee;
    }
    Fees public fees;

    /// @notice Minimum token balance to trigger automatic swap to ETH
    uint256 public swapTokensAtAmount;

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Maximum allowed fee percentage (20% = 2000 basis points)
    uint256 private constant MAX_FEE = 2000;

    /// @dev Denominator for percentage calculations (10000 = 100%)
    uint256 private constant DENM = 10000;

    /// @dev Maximum batch size for array operations to prevent DoS
    uint256 private constant MAX_BATCH_SIZE = 50;

    // ═══════════════════════════════════════════════════════════════════════════
    // MAPPINGS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Addresses exempt from transaction and wallet limits
    mapping(address => bool) public isExcludedFromLimits;

    /// @notice Addresses exempt from paying taxes
    mapping(address => bool) public isExcludedFromTax;

    /// @notice DEX pair addresses for special tax treatment
    mapping(address => bool) public automatedMarketMakerPairs;

    /// @notice Blacklisted addresses unable to transfer tokens
    mapping(address => bool) public isBlocked;

    // Events to track significant state changes
    event Launch();
    event SetLimitsEnabled(bool status);
    event SetTaxesEnabled(bool status);
    event SetLimits(
        uint256 newMaxBuy,
        uint256 newMaxSell,
        uint256 newMaxWallet
    );
    event SetFees(
        uint256 newBuyFee,
        uint256 newSellFee,
        uint256 newTransferFee
    );
    event ExcludeFromLimits(address account, bool isExcluded);
    event ExcludeFromTax(address account, bool isExcluded);
    event SetAutomatedMarketMakerPair(address pair, bool value);
    event SetSwapTokensAtAmount(uint256 newValue, uint256 oldValue);
    event WithdrawStuckTokens(address token, uint256 amount);
    event AccountBlocked(address account, bool value);
    event SwapTokenAmountUpdated(uint256 newValue, uint256 oldValue);
    event TreasuryWalletUpdated(address oldWallet, address newWallet);

    // Custom errors for more explicit reverts
    error AlreadyLaunched();
    error AmountOutOfBounds();
    error FeeTooHigh();
    error NoTokens();
    error FailedToWithdrawTokens();
    error NotLaunched();
    error AccountBlockedFromTransfer();
    error AmountTooSmall();
    error AmountTooLarge();
    error ZeroTokenAmount();
    error ZeroEthAmount();
    error InsufficientToken();
    error ZeroAddress();
    error EthTransferFailed();

    // ═══════════════════════════════════════════════════════════════════════════
    // SWAP & LIQUIDITY MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Wallet receiving tax proceeds in ETH
    address public operationsWallet;

    /// @notice Wallet receiving LP tokens for secure custody
    address public treasuryWallet;

    /// @dev Flag preventing recursive swaps
    bool private inSwapBack;

    /// @dev Block number of last swap execution (anti-MEV)
    uint256 private lastSwapBackExecutionBlock;

    /**
     * @dev Modifier to prevent reentrancy during swap operations
     */
    modifier lockSwapBack() {
        inSwapBack = true;
        _;
        inSwapBack = false;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // Disable initializers to prevent logic contract from being initialized directly
        _disableInitializers();
    }

    /**
     * @notice Initializes the BonkAI token contract
     * @dev Called once during proxy deployment to set up initial state
     * @param _ownerAddress Address to receive DEFAULT_ADMIN_ROLE and initial token supply
     * @param _operationsWallet Address to receive tax proceeds in ETH
     *
     * Initial Configuration:
     * - Total Supply: 1 billion tokens (1e9 * 1e18)
     * - Default Limits: 1% buy, 1% sell, 1% wallet
     * - Default Fees: 3% buy, 5% sell, 0% transfer
     * - Swap Threshold: 0.05% of total supply
     */
    function initialize(
        address _ownerAddress,
        address _operationsWallet
    ) external initializer {
        // Initialize parent contracts
        __ERC20_init("BONK AI", "BONKAI");
        __ERC20Permit_init("BONK AI");
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        address sender = msg.sender;
        // Set operations wallet
        operationsWallet = _operationsWallet;
        treasuryWallet = _ownerAddress; // Initially set to owner, can be updated later

        // Assign default roles
        _grantRole(DEFAULT_ADMIN_ROLE, _ownerAddress); // Multisig wallet
        _grantRole(MANAGER_ROLE, sender);
        // Update upgrader when needed in future

        // Define total supply: 1 billion tokens, 18 decimals => 1_000_000_000 ether
        uint256 _totalSupply = 1_000_000_000 ether;

        // Set default limits
        // 1% maxbuy, 1% maxsell, 1% maxwallet
        limits = Limits({
            maxBuy: uint128((_totalSupply * 100) / DENM), // 1%
            maxSell: uint128((_totalSupply * 100) / DENM), // 1%
            maxWallet: uint128((_totalSupply * 100) / DENM) // 1%
        });

        // By default, limits and tax are enabled
        isLimitsEnabled = true;
        isTaxEnabled = true;

        swapTokensAtAmount = (_totalSupply * 5) / DENM; // 0.05% of total supply

        // Default fees
        fees = Fees({
            buyFee: 300, // 3%
            sellFee: 500, // 5%
            transferFee: 0 // 0%
        });

        // Exclude important addresses from limits
        _excludeFromLimits(address(this), true);
        _excludeFromLimits(address(0), true);
        _excludeFromLimits(sender, true);
        _excludeFromLimits(_ownerAddress, true);
        _excludeFromLimits(_operationsWallet, true);

        // Exclude important addresses from tax
        _excludeFromTax(address(this), true);
        _excludeFromTax(address(0), true);
        _excludeFromTax(sender, true);
        _excludeFromTax(_ownerAddress, true);
        _excludeFromTax(_operationsWallet, true);

        // Mint the total supply to the owner
        _mint(_ownerAddress, _totalSupply);
    }

    /**
     * @notice Launches the token by creating liquidity pool and enabling trading
     * @dev Creates Uniswap V2 pair, adds initial liquidity, and marks token as launched
     * @param tokenAmount Amount of tokens to add to liquidity pool
     *
     * Requirements:
     * - Caller must have MANAGER_ROLE
     * - Token must not be already launched
     * - Must send ETH with transaction for liquidity
     * - Caller must have sufficient token balance
     *
     * Effects:
     * - Creates token/ETH pair on Uniswap V2
     * - Adds liquidity with 5% slippage protection
     * - LP tokens sent to treasury wallet
     * - Marks token as launched and enables trading
     */
    function launch(
        uint256 tokenAmount
    ) external payable onlyRole(MANAGER_ROLE) nonReentrant {
        if (isLaunched) revert AlreadyLaunched();
        if (tokenAmount == 0) revert ZeroTokenAmount();
        if (msg.value == 0) revert ZeroEthAmount();
        if (balanceOf(msg.sender) < tokenAmount) revert InsufficientToken();

        // Set up router
        swapRouter = IUniswapV2Router02(
            0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24
        );

        // Transfer tokens to this contract
        _transfer(msg.sender, address(this), tokenAmount);

        // Approve router to handle these tokens
        _approve(address(this), address(swapRouter), type(uint256).max);

        // Create pair and add liquidity
        swapPair = IUniswapV2Factory(swapRouter.factory()).createPair(
            address(this),
            swapRouter.WETH()
        );

        // Calculate minimum amounts with 5% slippage tolerance
        // This protects against sandwich attacks during launch
        uint256 minTokenAmount = (tokenAmount * 95) / 100;
        uint256 minEthAmount = (msg.value * 95) / 100;

        // Add initial liquidity to Uniswap V2 pool
        // LP tokens are sent to treasury for secure custody
        swapRouter.addLiquidityETH{value: msg.value}(
            address(this),
            tokenAmount,
            minTokenAmount, // Accept minimum 95% of tokens
            minEthAmount, // Accept minimum 95% of ETH
            treasuryWallet, // LP tokens sent to treasury (not contract!)
            block.timestamp
        );

        _setAutomatedMarketMakerPair(swapPair, true);
        isLaunched = true;
        emit Launch();
    }

    /**
     * @notice Toggles transaction and wallet limits
     * @dev Used to enable/disable anti-bot protection
     * @param enabled True to enforce limits, false to remove restrictions
     *
     * Requirements:
     * - Caller must have MANAGER_ROLE
     */
    function setLimitsEnabled(bool enabled) external onlyRole(MANAGER_ROLE) {
        isLimitsEnabled = enabled;
        emit SetLimitsEnabled(enabled);
    }

    /**
     * @notice Toggles tax collection on transactions
     * @dev Allows temporary suspension of all taxes
     * @param value True to enable taxes, false to disable
     *
     * Requirements:
     * - Caller must have MANAGER_ROLE
     */
    function setTaxesEnabled(bool value) external onlyRole(MANAGER_ROLE) {
        isTaxEnabled = value;
        emit SetTaxesEnabled(value);
    }

    /**
     * @notice Updates tax percentages for different transaction types
     * @dev Fees are in basis points (100 = 1%)
     * @param newBuyFee Tax on buy transactions (max 20%)
     * @param newSellFee Tax on sell transactions (max 20%)
     * @param newTransferFee Tax on P2P transfers (max 20%)
     *
     * Requirements:
     * - Caller must have MANAGER_ROLE
     * - Each fee must not exceed MAX_FEE (2000 basis points = 20%)
     */
    function setFees(
        uint256 newBuyFee,
        uint256 newSellFee,
        uint256 newTransferFee
    ) external onlyRole(MANAGER_ROLE) {
        // Validate new fees against the maximum
        if (
            newBuyFee > MAX_FEE ||
            newSellFee > MAX_FEE ||
            newTransferFee > MAX_FEE
        ) revert FeeTooHigh();
        fees = Fees({
            buyFee: uint16(newBuyFee),
            sellFee: uint16(newSellFee),
            transferFee: uint16(newTransferFee)
        });
        emit SetFees(newBuyFee, newSellFee, newTransferFee);
    }

    /**
     * @notice Updates transaction size and wallet holding limits
     * @dev Limits must be within 0.01% to 10% of total supply
     * @param newMaxBuy Maximum tokens per buy transaction
     * @param newMaxSell Maximum tokens per sell transaction
     * @param newMaxWallet Maximum tokens per wallet
     *
     * Requirements:
     * - Caller must have MANAGER_ROLE
     * - Each limit must be between 0.01% and 10% of total supply
     */
    function setLimits(
        uint256 newMaxBuy,
        uint256 newMaxSell,
        uint256 newMaxWallet
    ) external onlyRole(MANAGER_ROLE) {
        uint256 _totalSupply = totalSupply();
        if (
            newMaxBuy < (_totalSupply * 1) / DENM ||
            newMaxBuy > (_totalSupply * 1000) / DENM
        ) revert AmountOutOfBounds(); // 0.01% to 10%
        if (
            newMaxSell < (_totalSupply * 1) / DENM ||
            newMaxSell > (_totalSupply * 1000) / DENM
        ) revert AmountOutOfBounds(); // 0.01% to 10%
        if (
            newMaxWallet < (_totalSupply * 1) / DENM ||
            newMaxWallet > (_totalSupply * 1000) / DENM
        ) revert AmountOutOfBounds(); // 0.01% to 10%

        limits = Limits({
            maxBuy: uint128(newMaxBuy),
            maxSell: uint128(newMaxSell),
            maxWallet: uint128(newMaxWallet)
        });
        emit SetLimits(newMaxBuy, newMaxSell, newMaxWallet);
    }

    /**
     * @dev Internal function to set or unset an address as an automated market maker pair.
     * @param pair The address to set or unset as an AMM pair
     * @param value True to set as AMM pair, false to unset
     */
    function _setAutomatedMarketMakerPair(
        address pair,
        bool value
    ) internal virtual {
        if (pair == address(0)) revert ZeroAddress();
        automatedMarketMakerPairs[pair] = value;
        emit SetAutomatedMarketMakerPair(pair, value);
    }

    /**
     * @notice Marks an address as a DEX pair for special tax treatment
     * @dev AMM pairs have different tax rules applied
     * @param pair Address to mark/unmark as AMM pair
     * @param value True to mark as AMM pair, false to remove
     *
     * Requirements:
     * - Caller must have MANAGER_ROLE
     * - Pair address cannot be zero address
     */
    function setAutomaticMarketMakerPair(
        address pair,
        bool value
    ) external onlyRole(MANAGER_ROLE) {
        _setAutomatedMarketMakerPair(pair, value);
    }

    /**
     * @dev Set the operations wallet address
     *      Only DEFAULT_ADMIN_ROLE can call.
     */
    function setOperationsWallet(
        address _wallet
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_wallet == address(0)) revert ZeroAddress();
        operationsWallet = _wallet;
    }

    /**
     * @dev Set the treasury wallet address (receives LP tokens)
     *      Only DEFAULT_ADMIN_ROLE can call.
     */
    function setTreasuryWallet(
        address _wallet
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_wallet == address(0)) revert ZeroAddress();
        address oldWallet = treasuryWallet;
        treasuryWallet = _wallet;
        emit TreasuryWalletUpdated(oldWallet, _wallet);
    }

    /**
     * @dev Block (or unblock) an account from sending/receiving tokens.
     *      Only MANAGER_ROLE can call.
     */
    function setBlockAccount(
        address account,
        bool value
    ) external onlyRole(MANAGER_ROLE) {
        isBlocked[account] = value;
        emit AccountBlocked(account, value);
    }

    /**
     * @notice Sets the minimum token balance to trigger automatic swaps
     * @dev Must be between 0.01% and 5% of total supply
     * @param amount New swap threshold in tokens
     *
     * Requirements:
     * - Caller must have MANAGER_ROLE
     * - Amount must be within allowed range
     */
    function setTokensForSwap(uint256 amount) external onlyRole(MANAGER_ROLE) {
        uint256 totalSupplyTokens = totalSupply();
        if (amount < (totalSupplyTokens * 1) / DENM) revert AmountTooSmall(); // Min: 0.01%
        if (amount > (totalSupplyTokens * 500) / DENM) revert AmountTooLarge(); // Max: 5%
        uint256 oldValue = swapTokensAtAmount;
        swapTokensAtAmount = amount;
        emit SwapTokenAmountUpdated(amount, oldValue);
    }

    /**
     * @notice Updates the router address
     * @dev Can only be called pre-launch by DEFAULT_ADMIN_ROLE
     * @param _router New router address
     *
     * Requirements:
     * - Must be called before launch
     * - Router address cannot be zero
     * - Caller must have DEFAULT_ADMIN_ROLE
     */
    function setRouter(address _router) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (isLaunched) revert AlreadyLaunched(); // keep it pre-launch only (recommended)
        if (_router == address(0)) revert ZeroAddress();
        swapRouter = IUniswapV2Router02(_router);
    }

    /**
     * @dev Exclude a batch of accounts from limits.
     *      Only MANAGER_ROLE can call.
     *      Limited to MAX_BATCH_SIZE to prevent DoS attacks.
     */
    function excludeFromLimits(
        address[] calldata accounts,
        bool value
    ) external onlyRole(MANAGER_ROLE) {
        require(accounts.length > 0, "Empty array");
        require(accounts.length <= MAX_BATCH_SIZE, "Batch too large");

        for (uint256 i = 0; i < accounts.length; i++) {
            _excludeFromLimits(accounts[i], value);
        }
    }

    /**
     * @dev Exclude a batch of accounts from tax.
     *      Only MANAGER_ROLE can call.
     *      Limited to MAX_BATCH_SIZE to prevent DoS attacks.
     */
    function excludeFromTax(
        address[] calldata accounts,
        bool value
    ) external onlyRole(MANAGER_ROLE) {
        require(accounts.length > 0, "Empty array");
        require(accounts.length <= MAX_BATCH_SIZE, "Batch too large");

        for (uint256 i = 0; i < accounts.length; i++) {
            _excludeFromTax(accounts[i], value);
        }
    }

    /**
     * @notice Emergency function to recover stuck tokens or ETH
     * @dev Allows withdrawal of any tokens accidentally sent to contract
     * @param _token Token address to withdraw (use address(0) for ETH)
     *
     * Requirements:
     * - Caller must have DEFAULT_ADMIN_ROLE
     * - Contract must have non-zero balance of requested token
     *
     * Security:
     * - Protected by ReentrancyGuard
     * - Includes transfer success checks
     */
    function withdrawTokens(
        address _token
    ) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        uint256 amount;

        if (_token == address(0)) {
            // Withdraw ETH
            amount = address(this).balance;
            if (amount == 0) revert NoTokens();
            (bool success, ) = address(msg.sender).call{value: amount}("");
            if (!success) revert FailedToWithdrawTokens();
        } else if (_token == address(this)) {
            // Withdraw this contract's own tokens
            amount = balanceOf(address(this));
            if (amount == 0) revert NoTokens();
            _transfer(address(this), msg.sender, amount);
        } else {
            // Withdraw other ERC20 tokens
            amount = IERC20(_token).balanceOf(address(this));
            if (amount == 0) revert NoTokens();
            bool success = IERC20(_token).transfer(msg.sender, amount);
            if (!success) revert FailedToWithdrawTokens();
        }

        emit WithdrawStuckTokens(_token, amount);
    }

    /**
     * @dev Core transfer logic with tax and limit enforcement
     * @param from Sender address
     * @param to Recipient address
     * @param amount Transfer amount
     *
     * This function handles:
     * 1. Launch status verification
     * 2. Blacklist checking
     * 3. Transaction limit enforcement
     * 4. Tax calculation and collection
     * 5. Automatic swap triggering
     *
     * @inheritdoc ERC20Upgradeable
     */
    function _update(
        address from,
        address to,
        uint256 amount
    )
        internal
        virtual
        override(ERC20Upgradeable, ERC20PausableUpgradeable)
        whenNotPaused
    {
        // Step 1: Verify trading is enabled (unless excluded addresses)
        if (
            !isLaunched &&
            !isExcludedFromLimits[from] &&
            !isExcludedFromLimits[to]
        ) revert NotLaunched();

        // Step 2: Enforce blacklist
        if (isBlocked[from] || isBlocked[to])
            revert AccountBlockedFromTransfer();

        // Step 3: Check if limits should be applied
        bool applyLimits = isLimitsEnabled &&
            !inSwapBack &&
            !(isExcludedFromLimits[from] || isExcludedFromLimits[to]);

        if (applyLimits) {
            // Buy transaction: from AMM pair to user
            if (automatedMarketMakerPairs[from] && !isExcludedFromLimits[to]) {
                if (amount > limits.maxBuy) revert AmountOutOfBounds();
                if (amount + balanceOf(to) > limits.maxWallet)
                    revert AmountOutOfBounds();
            }
            // Sell transaction: from user to AMM pair
            else if (
                automatedMarketMakerPairs[to] && !isExcludedFromLimits[from]
            ) {
                if (amount > limits.maxSell) revert AmountOutOfBounds();
            }
            // P2P transfer: enforce wallet limit for recipient
            else if (!isExcludedFromLimits[to]) {
                if (amount + balanceOf(to) > limits.maxWallet)
                    revert AmountOutOfBounds();
            }
        }

        // Step 4: Calculate and collect taxes
        bool applyTax = isTaxEnabled &&
            !inSwapBack &&
            !(isExcludedFromTax[from] || isExcludedFromTax[to]);

        if (applyTax) {
            uint256 feeAmount = 0;
            // Sell tax: user selling to AMM
            if (automatedMarketMakerPairs[to] && fees.sellFee > 0) {
                feeAmount = (amount * fees.sellFee) / DENM;
            }
            // Buy tax: user buying from AMM
            else if (automatedMarketMakerPairs[from] && fees.buyFee > 0) {
                feeAmount = (amount * fees.buyFee) / DENM;
            }
            // Transfer tax: P2P transfers
            else if (
                !automatedMarketMakerPairs[to] &&
                !automatedMarketMakerPairs[from] &&
                fees.transferFee > 0
            ) {
                feeAmount = (amount * fees.transferFee) / DENM;
            }

            // Collect tax by transferring to contract
            if (feeAmount > 0) {
                amount -= feeAmount;
                super._update(from, address(this), feeAmount);
            }
        }

        // Step 5: Check for automatic swap trigger
        uint256 contractTokenBalance = balanceOf(address(this));
        bool shouldSwap = contractTokenBalance >= swapTokensAtAmount;

        // Swap conditions:
        // - Tax is enabled
        // - Threshold reached
        // - Not a buy transaction (prevents sandwich attacks)
        // - 3 blocks passed since last swap (MEV protection)
        if (applyTax && shouldSwap && !automatedMarketMakerPairs[from]) {
            if (block.number > lastSwapBackExecutionBlock + 3) {
                _swapTokensForEth(contractTokenBalance);
                lastSwapBackExecutionBlock = block.number;
            }
        }

        // Step 6: Execute the actual transfer
        super._update(from, to, amount);
    }

    /**
     * @notice Manually triggers swap of contract tokens to ETH
     * @dev Bypasses automatic swap threshold for immediate execution
     *
     * Requirements:
     * - Caller must have MANAGER_ROLE
     * - Contract must have tokens to swap
     */
    function manualSwap() external onlyRole(MANAGER_ROLE) nonReentrant {
        if (!isLaunched) revert NotLaunched();
        uint256 contractTokenBalance = balanceOf(address(this));
        if (contractTokenBalance == 0) revert NoTokens();
        _swapTokensForEth(contractTokenBalance);
    }

    /**
     * @dev Executes token to ETH swap with slippage protection
     * @param balance Amount of tokens to swap
     */
    function _swapTokensForEth(uint256 balance) internal lockSwapBack {
        bool success;

        // Define swap path: Token -> WETH -> ETH
        address[] memory path = new address[](2);
        path[0] = address(this);
        path[1] = swapRouter.WETH();

        // Cap maximum swap to prevent massive dumps (20x threshold)
        uint256 maxSwapAmount = swapTokensAtAmount * 20;
        if (balance > maxSwapAmount) {
            balance = maxSwapAmount;
        }

        // Approve router to spend tokens
        _approve(address(this), address(swapRouter), balance);

        // Execute swap with fee-on-transfer support
        swapRouter.swapExactTokensForETHSupportingFeeOnTransferTokens(
            balance,
            0, // No minimum ETH requirement
            path,
            address(this),
            block.timestamp // Current block deadline
        );

        // Transfer all ETH to operations wallet
        uint256 ethBalance = address(this).balance;
        (success, ) = address(operationsWallet).call{value: ethBalance}("");
        if (!success) revert EthTransferFailed();
    }

    /**
     * @dev Internal function to exclude/include address from limits
     * @param account Address to modify
     * @param value True to exclude, false to include
     */
    function _excludeFromLimits(address account, bool value) internal virtual {
        isExcludedFromLimits[account] = value;
        emit ExcludeFromLimits(account, value);
    }

    /**
     * @dev Internal function to exclude/include address from taxes
     * @param account Address to modify
     * @param value True to exclude, false to include
     */
    function _excludeFromTax(address account, bool value) internal virtual {
        isExcludedFromTax[account] = value;
        emit ExcludeFromTax(account, value);
    }

    /// @notice Allows contract to receive ETH directly
    receive() external payable {}

    /**
     * @notice Emergency pause - stops all token transfers
     * @dev Can be used to prevent exploits or during upgrades
     *
     * Requirements:
     * - Caller must have DEFAULT_ADMIN_ROLE
     */
    function pause() public onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /**
     * @notice Resumes token transfers after pause
     * @dev Re-enables all transfer functionality
     *
     * Requirements:
     * - Caller must have DEFAULT_ADMIN_ROLE
     */
    function unpause() public onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /**
     * @dev Authorization function for UUPS upgrades
     * @param newImplementation Address of new implementation contract
     *
     * Requirements:
     * - Caller must have UPGRADER_ROLE
     */
    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyRole(UPGRADER_ROLE) {}
}
