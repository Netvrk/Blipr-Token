// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

// Importing OpenZeppelin Upgradeable libraries and interfaces for:
// - ERC20 (basic token logic)
// - ERC20Permit (permit support via EIP-2612 signatures)
// - ERC20Pausable (pausable token transfers)
// - AccessControl (role-based access control)
// - UUPSUpgradeable (upgradeable contract pattern)
// - ReentrancyGuardUpgradeable (protection from reentrancy attacks)
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import "./interfaces/IUniswapV2Router02.sol";
import "./interfaces/IUniswapV2Factory.sol";

contract SilkAI is
    Initializable,
    AccessControlUpgradeable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    ERC20PausableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable
{
    // Roles for AccessControl
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    // Common address references
    address public constant ZERO_ADDRESS = address(0);
    address public constant DEAD_ADDRESS = address(0xdEaD);

    // Uniswap-like router and pair addresses
    IUniswapV2Router02 public uniswapV2Router;
    address public uniswapV2Pair;
    address public operationsWallet; // Receives tokens/ETH for operations

    // Boolean flags for contract state
    bool public isLimitsEnabled; // Whether buy/sell/wallet limits are enforced
    bool public isTaxEnabled; // Whether fees (taxes) are applied
    bool private inSwapBack; // Lock to prevent reentrancy during swaps
    bool public isLaunched; // Whether the token has been launched

    // Limits struct to store maxBuy, maxSell, and maxWallet
    struct Limits {
        uint256 maxBuy;
        uint256 maxSell;
        uint256 maxWallet;
    }
    Limits public limits;

    // The threshold for swapping tokens in contract to ETH
    uint256 public swapTokensAtAmount;

    // Fees struct to store buyFee, sellFee, and transferFee
    struct Fees {
        uint256 buyFee;
        uint256 sellFee;
        uint256 transferFee;
    }
    Fees public fees;

    // Constants: maximum fee (50%) and denominator (10000 = basis points)
    uint256 private constant MAX_FEE = 5000;
    uint256 private constant DENM = 10000;

    // Track addresses excluded from fees & limits, and AMM pairs
    mapping(address => bool) public isExcludedFromFees;
    mapping(address => bool) public isExcludedFromLimits;
    mapping(address => bool) public automatedMarketMakerPairs;

    // Last block where a swap was performed, to avoid multiple swaps in one block
    uint256 private lastSwapBackExecutionBlock;

    // Addresses blocked from sending and receiving tokens
    mapping(address => bool) public isBlocked;

    // Events to track significant state changes
    event Launch();
    event SetOperationsWallet(address newWallet, address oldWallet);
    event SetLimitsEnabled(bool status);
    event SetTaxesEnabled(bool status);
    event SetLimits(
        uint256 newMaxBuy,
        uint256 newMaxSell,
        uint256 newMaxWallet
    );
    event SetSwapTokensAtAmount(uint256 newValue, uint256 oldValue);
    event SetFees(
        uint256 newBuyFee,
        uint256 newSellFee,
        uint256 newTransferFee
    );
    event ExcludeFromFees(address account, bool isExcluded);
    event ExcludeFromLimits(address account, bool isExcluded);
    event SetAutomatedMarketMakerPair(address pair, bool value);
    event WithdrawStuckTokens(address token, uint256 amount);
    event AddressBlocked(address account, bool value);

    // Custom errors for more explicit reverts
    error AlreadyLaunched();
    error AmountTooLow();
    error AmountTooHigh();
    error FeeTooHigh();
    error AMMAlreadySet();
    error NoNativeTokens();
    error NoTokens();
    error FailedToWithdrawNativeTokens();
    error MaxBuyAmountExceed();
    error MaxSellAmountExceed();
    error MaxWalletAmountExceed();
    error NotLaunched();
    error InsufficientToken();
    error ZeroTokenAmount();
    error ZeroEthAmount();
    error AccountBlocked();
    error TransferFailed();

    // Lock mechanism to prevent nested calls that trigger swaps
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
     * @dev Initializes the contract after deployment behind a proxy.
     * @param _operationsWallet The wallet that will receive operation funds (fees).
     */
    function initialize(address _operationsWallet) external initializer {
        // Initialize parent contracts
        __ERC20_init("AI Silk", "ASLK");
        __ERC20Permit_init("AI Silk");
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        address sender = msg.sender;

        // Assign default roles
        _grantRole(DEFAULT_ADMIN_ROLE, sender);
        _grantRole(MANAGER_ROLE, sender);

        // Define total supply: 1 billion tokens, 18 decimals => 1_000_000_000 ether
        uint256 totalSupply = 1_000_000_000 ether;

        // Set the operations wallet
        operationsWallet = _operationsWallet;

        // Set default limits
        limits.maxBuy = (totalSupply * 50) / DENM; // 0.5%
        limits.maxSell = (totalSupply * 50) / DENM; // 0.5%
        limits.maxWallet = (totalSupply * 50) / DENM; // 0.5%

        // The contract will swap once it has 1% of total supply
        swapTokensAtAmount = (totalSupply * 100) / DENM; // 1%

        // By default, limits and tax are enabled
        isLimitsEnabled = true;
        isTaxEnabled = true;

        // Default fees are set to 20% for buy, sell, and transfer
        fees.buyFee = 2000; // 20%
        fees.sellFee = 2000; // 20%
        fees.transferFee = 2000; // 20%

        // Set the uniswap router address
        uniswapV2Router = IUniswapV2Router02(
            0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24
        );

        // Exclude important addresses from fees
        _excludeFromFees(address(this), true);
        _excludeFromFees(ZERO_ADDRESS, true);
        _excludeFromFees(DEAD_ADDRESS, true);
        _excludeFromFees(sender, true);
        _excludeFromFees(operationsWallet, true);

        // Exclude important addresses from limits
        _excludeFromLimits(address(this), true);
        _excludeFromLimits(ZERO_ADDRESS, true);
        _excludeFromLimits(DEAD_ADDRESS, true);
        _excludeFromLimits(sender, true);
        _excludeFromLimits(operationsWallet, true);

        // Mint the total supply to the deployer (sender)
        _mint(sender, totalSupply);
    }

    // Allow contract to receive ETH
    receive() external payable {}

    fallback() external payable {}

    /**
     * /////////////////////////////////////////////////////////////////
     * @dev Pause the contract. Only DEFAULT_ADMIN_ROLE can call.
     *      Pausing forbids token transfers (via ERC20Pausable).
     * /////////////////////////////////////////////////////////////////
     */
    function pause() public onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /**
     * /////////////////////////////////////////////////////////////////
     * @dev Unpause the contract. Only DEFAULT_ADMIN_ROLE can call.
     * /////////////////////////////////////////////////////////////////
     */
    function unpause() public onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /**
     * /////////////////////////////////////////////////////////////////
     * @dev Authorization hook for UUPS upgrades.
     *      Only addresses with UPGRADER_ROLE can upgrade the contract.
     * /////////////////////////////////////////////////////////////////
     */
    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyRole(UPGRADER_ROLE) {}

    /**
     * /////////////////////////////////////////////////////////////////
     * @dev Launch the token by creating a Uniswap pair and adding liquidity.
     *      This can only be done once by MANAGER_ROLE.
     * @param tokenAmount The amount of tokens to add as liquidity.
     * /////////////////////////////////////////////////////////////////
     */
    function launch(
        uint256 tokenAmount
    ) external payable onlyRole(MANAGER_ROLE) nonReentrant {
        require(!isLaunched, AlreadyLaunched());
        require(tokenAmount > 0, ZeroTokenAmount());
        require(msg.value > 0, ZeroEthAmount());

        // Create the pair (contract token <-> WETH)
        uniswapV2Pair = IUniswapV2Factory(uniswapV2Router.factory()).createPair(
                address(this),
                uniswapV2Router.WETH()
            );
        // Mark this pair as an Automated Market Maker pair
        _setAutomatedMarketMakerPair(uniswapV2Pair, true);

        // Transfer required tokens from the manager to this contract
        require(balanceOf(msg.sender) >= tokenAmount, InsufficientToken());
        _transfer(msg.sender, address(this), tokenAmount);

        // Approve router to handle these tokens
        _approve(address(this), address(uniswapV2Router), type(uint256).max);

        // Add liquidity with token + ETH from the manager's call
        uniswapV2Router.addLiquidityETH{value: msg.value}(
            address(this),
            tokenAmount,
            0,
            0,
            msg.sender,
            block.timestamp
        );

        // Approve the pair for the router
        IERC20(uniswapV2Pair).approve(
            address(uniswapV2Router),
            type(uint256).max
        );

        // Set launched flag
        isLaunched = true;
        emit Launch();
    }

    /**
     * /////////////////////////////////////////////////////////////////
     * @dev Enable or disable the buy/sell/wallet limits.
     *      Only MANAGER_ROLE can call.
     * /////////////////////////////////////////////////////////////////
     */
    function setLimitsEnabled(bool enabled) external onlyRole(MANAGER_ROLE) {
        isLimitsEnabled = enabled;
        emit SetLimitsEnabled(enabled);
    }

    /**
     * /////////////////////////////////////////////////////////////////
     * @dev Set the operations wallet (receives swap proceeds).
     *      Only DEFAULT_ADMIN_ROLE can call.
     * /////////////////////////////////////////////////////////////////
     */
    function setOperationsWallet(
        address newWallet
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        address oldWallet = operationsWallet;
        operationsWallet = newWallet;
        emit SetOperationsWallet(newWallet, oldWallet);
    }

    /**
     * /////////////////////////////////////////////////////////////////
     * @dev Enable or disable tax (fee).
     *      Only MANAGER_ROLE can call.
     * /////////////////////////////////////////////////////////////////
     */
    function setTaxesEnabled(bool value) external onlyRole(MANAGER_ROLE) {
        isTaxEnabled = value;
        emit SetTaxesEnabled(value);
    }

    /**
     * /////////////////////////////////////////////////////////////////
     * @dev Set the fees for buying, selling, and transferring.
     *      Only MANAGER_ROLE can call.
     *      Each fee cannot exceed MAX_FEE (currently 50%).
     * /////////////////////////////////////////////////////////////////
     */
    function setFees(
        uint256 newBuyFee,
        uint256 newSellFee,
        uint256 newTransferFee
    ) external onlyRole(MANAGER_ROLE) {
        // Validate new fees against the maximum
        require(newBuyFee <= MAX_FEE, FeeTooHigh());
        fees.buyFee = newBuyFee;

        require(newSellFee <= MAX_FEE, FeeTooHigh());
        fees.sellFee = newSellFee;

        require(newTransferFee <= MAX_FEE, FeeTooHigh());
        fees.transferFee = newTransferFee;

        emit SetFees(newBuyFee, newSellFee, newTransferFee);
    }

    /**
     * /////////////////////////////////////////////////////////////////
     * @dev Set the transaction and wallet limits.
     *      maxBuy, maxSell, and maxWallet must be within 0.01% to 5% range of total supply.
     *      Only MANAGER_ROLE can call.
     * /////////////////////////////////////////////////////////////////
     */
    function setLimits(
        uint256 newMaxBuy,
        uint256 newMaxSell,
        uint256 newMaxWallet
    ) external onlyRole(MANAGER_ROLE) {
        uint256 _totalSupply = totalSupply();

        // maxBuy: must be >=0.01% and <=5% of total supply
        require(newMaxBuy >= (_totalSupply * 1) / DENM, AmountTooLow());
        require(newMaxBuy <= (_totalSupply * 500) / DENM, AmountTooHigh());
        limits.maxBuy = newMaxBuy;

        // maxSell: must be >=0.01% and <=5%
        require(newMaxSell >= (_totalSupply * 1) / DENM, AmountTooLow());
        require(newMaxSell <= (_totalSupply * 500) / DENM, AmountTooHigh());
        limits.maxSell = newMaxSell;

        // maxWallet: must be >=0.01% and <=5%
        require(newMaxWallet >= (_totalSupply * 1) / DENM, AmountTooLow());
        require(newMaxWallet <= (_totalSupply * 500) / DENM, AmountTooHigh());
        limits.maxWallet = newMaxWallet;

        emit SetLimits(newMaxBuy, newMaxSell, newMaxWallet);
    }

    /**
     * /////////////////////////////////////////////////////////////////
     * @dev Update the swapTokensAtAmount (threshold to swap).
     *      Must be between 0.1% and 2% of the total supply.
     *      Only MANAGER_ROLE can call.
     * /////////////////////////////////////////////////////////////////
     */
    function setSwapTokensAtAmount(
        uint256 amount
    ) external onlyRole(MANAGER_ROLE) {
        uint256 _totalSupply = totalSupply();
        require(amount >= (_totalSupply * 10) / DENM, AmountTooLow()); // 0.1%
        require(amount <= (_totalSupply * 200) / DENM, AmountTooHigh()); // 2%

        uint256 oldValue = swapTokensAtAmount;
        swapTokensAtAmount = amount;

        emit SetSwapTokensAtAmount(amount, oldValue);
    }

    /**
     * /////////////////////////////////////////////////////////////////
     * @dev Set (or unset) an address as an automated market maker pair.
     *      Typically used for DEX pairs.
     *      Only MANAGER_ROLE can call.
     * /////////////////////////////////////////////////////////////////
     */
    function setAutomaticMarketMakerPair(
        address pair,
        bool value
    ) external onlyRole(MANAGER_ROLE) {
        // If already set to true, revert to avoid re-setting
        require(!automatedMarketMakerPairs[pair], AMMAlreadySet());
        _setAutomatedMarketMakerPair(pair, value);
    }

    /**
     * /////////////////////////////////////////////////////////////////
     * @dev Block (or unblock) an account from sending/receiving tokens.
     *      Only MANAGER_ROLE can call.
     * /////////////////////////////////////////////////////////////////
     */
    function setBlockAccount(
        address account,
        bool value
    ) external onlyRole(MANAGER_ROLE) {
        isBlocked[account] = value;
        emit AddressBlocked(account, value);
    }

    /**
     * /////////////////////////////////////////////////////////////////
     * @dev Exclude a batch of accounts from fees.
     *      Only MANAGER_ROLE can call.
     * /////////////////////////////////////////////////////////////////
     */
    function excludeFromFees(
        address[] calldata accounts,
        bool value
    ) external onlyRole(MANAGER_ROLE) {
        for (uint256 i = 0; i < accounts.length; i++) {
            _excludeFromFees(accounts[i], value);
        }
    }

    /**
     * /////////////////////////////////////////////////////////////////
     * @dev Exclude a batch of accounts from limits.
     *      Only MANAGER_ROLE can call.
     * /////////////////////////////////////////////////////////////////
     */
    function excludeFromLimits(
        address[] calldata accounts,
        bool value
    ) external onlyRole(MANAGER_ROLE) {
        for (uint256 i = 0; i < accounts.length; i++) {
            _excludeFromLimits(accounts[i], value);
        }
    }

    /**
     * /////////////////////////////////////////////////////////////////
     * @dev Withdraw stuck tokens (including ETH if _token == ZERO_ADDRESS)
     *      Only DEFAULT_ADMIN_ROLE can call.
     *      Uses ReentrancyGuard to prevent reentrant calls.
     * /////////////////////////////////////////////////////////////////
     */
    function withdrawStuckTokens(
        address _token
    ) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        address sender = msg.sender;
        uint256 amount;

        if (_token == ZERO_ADDRESS) {
            // Withdraw ETH
            amount = address(this).balance;
            require(amount > 0, NoNativeTokens());
            (bool success, ) = address(sender).call{value: amount}("");
            require(success, FailedToWithdrawNativeTokens());
        } else {
            // Withdraw any ERC20 tokens
            amount = IERC20(_token).balanceOf(address(this));
            require(amount > 0, NoTokens());
            IERC20(_token).transfer(msg.sender, amount);
        }
        emit WithdrawStuckTokens(_token, amount);
    }

    /**
     * /////////////////////////////////////////////////////////////////
     * @dev Manual swap of tokens stored in the contract for ETH,
     *      using a specified percentage of the contract's token balance.
     *      Only MANAGER_ROLE can call.
     * /////////////////////////////////////////////////////////////////
     */
    function manualSwap(
        uint256 _percen
    ) external onlyRole(MANAGER_ROLE) nonReentrant {
        uint256 balance = balanceOf(address(this));
        uint256 amt = (balance * _percen) / DENM;
        _swapBack(amt);
    }

    /**
     * /////////////////////////////////////////////////////////////////
     * @dev Internal override of _update (from ERC20Upgradeable):
     *      - Checks if token is launched unless sender/receiver is excluded
     *      - Checks if addresses are blocked
     *      - Enforces transaction limits if enabled
     *      - Calculates fees if taxes are enabled
     *      - Swaps tokens to ETH when threshold is reached
     * /////////////////////////////////////////////////////////////////
     */
    function _update(
        address from,
        address to,
        uint256 amount
    ) internal virtual override(ERC20Upgradeable, ERC20PausableUpgradeable) {
        // Ensure token is launched or sender/receiver is excluded
        require(
            isLaunched ||
                isExcludedFromLimits[from] ||
                isExcludedFromLimits[to],
            NotLaunched()
        );

        // Check if either the sender or receiver is blocked
        require(!isBlocked[from] && !isBlocked[to], AccountBlocked());

        // Apply transaction & wallet size limits if needed
        bool isLimited = isLimitsEnabled &&
            !inSwapBack &&
            !(isExcludedFromLimits[from] || isExcludedFromLimits[to]);

        if (isLimited) {
            // If buying from an AMM pair
            if (automatedMarketMakerPairs[from] && !isExcludedFromLimits[to]) {
                require(amount <= limits.maxBuy, MaxBuyAmountExceed());
                require(
                    amount + balanceOf(to) <= limits.maxWallet,
                    MaxWalletAmountExceed()
                );
            }
            // If selling into an AMM pair
            else if (
                automatedMarketMakerPairs[to] && !isExcludedFromLimits[from]
            ) {
                require(amount <= limits.maxSell, MaxSellAmountExceed());
            }
            // If simply transferring (not a buy or sell) and the receiver is not excluded
            else if (!isExcludedFromLimits[to]) {
                require(
                    amount + balanceOf(to) <= limits.maxWallet,
                    MaxWalletAmountExceed()
                );
            }
        }

        // Apply tax logic if enabled
        bool isTaxed = isTaxEnabled &&
            !inSwapBack &&
            !(isExcludedFromFees[from] || isExcludedFromFees[to]);

        if (isTaxed) {
            uint256 tax = 0;

            // Sell fee
            if (automatedMarketMakerPairs[to] && fees.sellFee > 0) {
                tax = (amount * fees.sellFee) / DENM;
            }
            // Buy fee
            else if (automatedMarketMakerPairs[from] && fees.buyFee > 0) {
                tax = (amount * fees.buyFee) / DENM;
            }
            // Transfer fee (wallet-to-wallet)
            else if (
                !automatedMarketMakerPairs[to] &&
                !automatedMarketMakerPairs[from] &&
                fees.transferFee > 0
            ) {
                tax = (amount * fees.transferFee) / DENM;
            }

            // If any fee is accrued, subtract it from transfer and add to contract
            if (tax > 0) {
                amount -= tax;
                super._update(from, address(this), tax);
            }
        }

        // Check if we should perform an automatic swap of tokens to ETH
        uint256 contractTokenBalance = balanceOf(address(this));
        bool shouldSwap = contractTokenBalance >= swapTokensAtAmount;

        // Only swap if it's taxed (so there's some tokens in the contract),
        // and the transaction is not originating from the contract's own sell
        // and we haven't swapped this block already.
        if (isTaxed && !automatedMarketMakerPairs[from] && shouldSwap) {
            if (block.number > lastSwapBackExecutionBlock) {
                // In case contract balance > swapTokensAtAmount, limit it
                if (contractTokenBalance > swapTokensAtAmount) {
                    contractTokenBalance = swapTokensAtAmount;
                }
                _swapBack(contractTokenBalance);
                lastSwapBackExecutionBlock = block.number;
            }
        }

        // Proceed with the normal transfer
        super._update(from, to, amount);
    }

    /**
     * /////////////////////////////////////////////////////////////////
     * @dev Internal function to swap contract tokens for ETH,
     *      then send ETH to the operations wallet.
     *      Protected by lockSwapBack modifier to prevent reentrancy.
     * /////////////////////////////////////////////////////////////////
     */
    function _swapBack(uint256 balance) internal virtual lockSwapBack {
        // Build the path for token -> WETH
        address[] memory path = new address[](2);
        path[0] = address(this);
        path[1] = uniswapV2Router.WETH();

        // Execute the swap on the router, ignoring slip
        uniswapV2Router.swapExactTokensForETHSupportingFeeOnTransferTokens(
            balance,
            0, // Accept any amount of ETH
            path,
            address(this),
            block.timestamp
        );

        // Transfer the resulting ETH to operations wallet
        uint256 ethBalance = address(this).balance;
        (bool success, ) = address(operationsWallet).call{value: ethBalance}(
            ""
        );
        require(success, TransferFailed());
    }

    /**
     * @dev Internal function to exclude an account from fees.
     */
    function _excludeFromFees(address account, bool value) internal virtual {
        isExcludedFromFees[account] = value;
        emit ExcludeFromFees(account, value);
    }

    /**
     * @dev Internal function to exclude an account from limits.
     */
    function _excludeFromLimits(address account, bool value) internal virtual {
        isExcludedFromLimits[account] = value;
        emit ExcludeFromLimits(account, value);
    }

    /**
     * @dev Internal function to define an address as an AMM pair.
     */
    function _setAutomatedMarketMakerPair(
        address pair,
        bool value
    ) internal virtual {
        automatedMarketMakerPairs[pair] = value;
        emit SetAutomatedMarketMakerPair(pair, value);
    }
}
