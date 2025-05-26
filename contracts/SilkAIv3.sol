// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import "./interfaces/IAerodomeV2Factory.sol";
import "./interfaces/IAerodomeV2Router02.sol";

contract SilkAIv3 is
    Initializable,
    AccessControlUpgradeable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    ERC20PausableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable
{
    IAerodomeV2Router02 private aerodomeV2Router;
    address private aerodomeV2Pair;

    // Roles for AccessControl
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    // Boolean flags for contract state
    bool public isLimitsEnabled; // Whether buy/sell/wallet limits are enforced
    bool public isTaxEnabled; // Whether fees (taxes) are applied
    bool public isLaunched; // Whether the token has been launched

    // Limits struct to store maxBuy, maxSell, and maxWallet
    struct Limits {
        uint256 maxBuy;
        uint256 maxSell;
        uint256 maxWallet;
    }
    Limits public limits;

    // Fees struct to store buyFee, sellFee, and transferFee
    struct Fees {
        uint256 buyFee;
        uint256 sellFee;
        uint256 transferFee;
    }
    Fees public fees;

    uint256 public swapTokensAtAmount;

    // Constants: maximum fee (10%) and denominator (10000 = basis points)
    uint256 private constant MAX_FEE = 1000; // 10%
    uint256 private constant DENM = 10000;

    // Track addresses excluded from fees & limits, and AMM pairs
    mapping(address => bool) public isExcludedFromLimits;
    mapping(address => bool) public automatedMarketMakerPairs;

    // Addresses blocked from sending and receiving tokens
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
    event SetAutomatedMarketMakerPair(address pair, bool value);
    event SetSwapTokensAtAmount(uint256 newValue, uint256 oldValue);
    event WithdrawStuckTokens(address token, uint256 amount);
    event AccountBlocked(address account, bool value);
    event OperationsWalletChanged(
        address indexed oldWallet,
        address indexed newWallet
    );

    // Custom errors for more explicit reverts
    error AlreadyLaunched();
    error AmountOutOfBounds();
    error FeeTooHigh();
    error NoTokens();
    error FailedToWithdrawTokens();
    error NotLaunched();
    error AccountBlockedFromTransfer();

    error ZeroTokenAmount();
    error ZeroEthAmount();
    error InsufficientToken();

    // Swap and Liquify
    address public operationsWallet;
    bool private inSwapBack;
    uint256 private lastSwapBackExecutionBlock;

    // Missing modifier
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
     */
    function initialize(address ownerAddress) external initializer {
        // Initialize parent contracts
        __ERC20_init("SAKI AI", "SAKI");
        __ERC20Permit_init("SAKI AI");
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        address sender = msg.sender;

        // Assign default roles
        _grantRole(DEFAULT_ADMIN_ROLE, ownerAddress);
        _grantRole(MANAGER_ROLE, sender);

        // Define total supply
        uint256 _totalSupply = 1_000_000_000 ether;

        // Set default limits
        limits = Limits({
            maxBuy: (_totalSupply * 500) / DENM,
            maxSell: (_totalSupply * 500) / DENM,
            maxWallet: (_totalSupply * 800) / DENM
        });

        isLimitsEnabled = true;
        isTaxEnabled = true;
        swapTokensAtAmount = (_totalSupply * 10) / DENM;
        fees = Fees({buyFee: 500, sellFee: 500, transferFee: 500});

        // Set router address but don't create pair yet
        aerodomeV2Router = IAerodomeV2Router02(
            0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43
        );

        // Exclude important addresses
        _excludeFromLimits(address(this), true);
        _excludeFromLimits(address(0), true);
        _excludeFromLimits(sender, true);
        _excludeFromLimits(ownerAddress, true);

        operationsWallet = ownerAddress;

        // Mint tokens
        _mint(ownerAddress, _totalSupply);
    }

    // Add a function to create the pair after deployment
    function setupPair() external onlyRole(MANAGER_ROLE) {
        require(aerodomeV2Pair == address(0), "Pair already created");
        aerodomeV2Pair = IAerodomeV2Factory(aerodomeV2Router.defaultFactory())
            .createPool(address(this), aerodomeV2Router.weth(), false);

        _setAutomatedMarketMakerPair(aerodomeV2Pair, true);
        _excludeFromLimits(aerodomeV2Pair, true);
    }

    /**
     * @dev Launch the token and enable transfers.
     *      This can only be done once by MANAGER_ROLE.
     */
    function launch(
        uint256 tokenAmount
    ) external payable onlyRole(MANAGER_ROLE) nonReentrant {
        require(!isLaunched, AlreadyLaunched());

        require(tokenAmount > 0, ZeroTokenAmount());
        require(msg.value > 0, ZeroEthAmount());
        require(balanceOf(msg.sender) >= tokenAmount, InsufficientToken());

        // Transfer tokens to this contract
        _transfer(msg.sender, address(this), tokenAmount);

        // Approve router to handle these tokens
        _approve(address(this), address(aerodomeV2Router), type(uint256).max);
        aerodomeV2Router.addLiquidityETH{value: msg.value}(
            address(this),
            false,
            tokenAmount,
            0,
            0,
            address(this),
            block.timestamp
        );

        // Approve the pair to spend tokens
        IERC20(aerodomeV2Pair).approve(
            address(aerodomeV2Router),
            type(uint256).max
        );

        isLaunched = true;
        emit Launch();
    }

    /**
     * @dev Enable or disable the buy/sell/wallet limits.
     *      Only MANAGER_ROLE can call.
     */
    function setLimitsEnabled(bool enabled) external onlyRole(MANAGER_ROLE) {
        isLimitsEnabled = enabled;
        emit SetLimitsEnabled(enabled);
    }

    /**
     * @dev Enable or disable tax (fee).
     *      Only MANAGER_ROLE can call.
     */
    function setTaxesEnabled(bool value) external onlyRole(MANAGER_ROLE) {
        isTaxEnabled = value;
        emit SetTaxesEnabled(value);
    }

    /**
     * @dev Set the fees for buying, selling, and transferring.
     *      Only MANAGER_ROLE can call.
     *      Each fee cannot exceed MAX_FEE (currently 10%).
     */
    function setFees(
        uint256 newBuyFee,
        uint256 newSellFee,
        uint256 newTransferFee
    ) external onlyRole(MANAGER_ROLE) {
        // Validate new fees against the maximum
        require(
            newBuyFee <= MAX_FEE &&
                newSellFee <= MAX_FEE &&
                newTransferFee <= MAX_FEE,
            FeeTooHigh()
        );
        fees = Fees(newBuyFee, newSellFee, newTransferFee);
        emit SetFees(newBuyFee, newSellFee, newTransferFee);
    }

    /**
     * @dev Set the transaction and wallet limits.
     *      maxBuy, maxSell, and maxWallet must be within 0.01% to 5% range of total supply.
     *      Only MANAGER_ROLE can call.
     */
    function setLimits(
        uint256 newMaxBuy,
        uint256 newMaxSell,
        uint256 newMaxWallet
    ) external onlyRole(MANAGER_ROLE) {
        uint256 _totalSupply = totalSupply();
        require(
            newMaxBuy >= (_totalSupply * 1) / DENM &&
                newMaxBuy <= (_totalSupply * 1000) / DENM,
            AmountOutOfBounds()
        ); // 0.01% to 10%
        require(
            newMaxSell >= (_totalSupply * 1) / DENM &&
                newMaxSell <= (_totalSupply * 1000) / DENM,
            AmountOutOfBounds()
        ); // 0.01% to 10%
        require(
            newMaxWallet >= (_totalSupply * 1) / DENM &&
                newMaxWallet <= (_totalSupply * 1000) / DENM,
            AmountOutOfBounds()
        ); // 0.01% to 10%

        limits = Limits(newMaxBuy, newMaxSell, newMaxWallet);
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
        require(pair != address(0), "Cannot set zero address");
        automatedMarketMakerPairs[pair] = value;
        emit SetAutomatedMarketMakerPair(pair, value);
    }

    /**
     * @dev Set (or unset) an address as an automated market maker pair.
     *      Typically used for DEX pairs.
     *      Only MANAGER_ROLE can call.
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
        require(_wallet != address(0), "Cannot set zero address");
        address oldWallet = operationsWallet;
        operationsWallet = _wallet;
        emit OperationsWalletChanged(oldWallet, _wallet);
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
     * @dev Exclude a batch of accounts from limits.
     *      Only MANAGER_ROLE can call.
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
     * @dev Withdraw stuck tokens (including ETH if _token == address(0))
     *      Only DEFAULT_ADMIN_ROLE can call.
     *      Uses ReentrancyGuard to prevent reentrant calls.
     */
    function withdrawTokens(
        address _token
    ) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        uint256 amount = _token == address(0)
            ? address(this).balance
            : IERC20(_token).balanceOf(address(this));
        require(amount > 0, NoTokens());

        if (_token == address(0)) {
            (bool success, ) = address(msg.sender).call{value: amount}("");
            require(success, FailedToWithdrawTokens());
        } else {
            IERC20(_token).transfer(msg.sender, amount);
        }
        emit WithdrawStuckTokens(_token, amount);
    }

    /**
     * @dev Internal override of _update (from ERC20Upgradeable):
     *      - Checks if token is launched unless sender/receiver is excluded
     *      - Checks if addresses are blocked
     *      - Enforces transaction limits if enabled
     *      - Calculates fees if taxes are enabled
     *      - Swaps tokens to ETH when threshold is reached
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
        // Ensure token is launched or sender/receiver is excluded
        require(
            isLaunched ||
                isExcludedFromLimits[from] ||
                isExcludedFromLimits[to],
            NotLaunched()
        );

        // Check if either the sender or receiver is blocked
        require(
            !isBlocked[from] && !isBlocked[to],
            AccountBlockedFromTransfer()
        );

        // Apply transaction & wallet size limits if needed
        if (
            isLimitsEnabled &&
            !isExcludedFromLimits[from] &&
            !isExcludedFromLimits[to]
        ) {
            // If buying from an AMM pair
            if (automatedMarketMakerPairs[from]) {
                require(
                    amount <= limits.maxBuy &&
                        amount + balanceOf(to) <= limits.maxWallet,
                    AmountOutOfBounds()
                );
            } else if (automatedMarketMakerPairs[to]) {
                require(amount <= limits.maxSell, AmountOutOfBounds());
            } else {
                require(
                    amount + balanceOf(to) <= limits.maxWallet,
                    AmountOutOfBounds()
                );
            }
        }

        // Apply tax logic if enabled
        if (
            isTaxEnabled &&
            !isExcludedFromLimits[from] &&
            !isExcludedFromLimits[to]
        ) {
            uint256 tax = automatedMarketMakerPairs[from]
                ? (amount * fees.buyFee) / DENM
                : automatedMarketMakerPairs[to]
                ? (amount * fees.sellFee) / DENM
                : (amount * fees.transferFee) / DENM;

            // If any fee is accrued, subtract it from transfer and add to contract
            if (tax > 0) {
                amount -= tax;
                super._update(from, address(this), tax);
            }
        }
        uint256 balance = balanceOf(address(this));

        bool takeFee = isTaxEnabled &&
            !inSwapBack &&
            !(isExcludedFromLimits[from] || isExcludedFromLimits[to]);
        bool shouldSwap = balance >= swapTokensAtAmount;
        if (takeFee && !automatedMarketMakerPairs[from] && shouldSwap) {
            if (block.number > lastSwapBackExecutionBlock) {
                _swapBack(balance);
                lastSwapBackExecutionBlock = block.number;
            }
        }

        // Proceed with the normal transfer
        super._update(from, to, amount);
    }

    function _swapBack(
        uint256 balance
    ) internal virtual lockSwapBack nonReentrant {
        bool success;
        address[] memory path = new address[](2);
        path[0] = address(this);
        path[1] = aerodomeV2Router.weth();

        uint256 maxSwapAmount = swapTokensAtAmount * 20;

        if (balance > maxSwapAmount) {
            balance = maxSwapAmount;
        }

        aerodomeV2Router.swapExactTokensForETHSupportingFeeOnTransferTokens(
            balance,
            0,
            path,
            address(this),
            block.timestamp
        );

        uint256 ethBalance = address(this).balance;

        (success, ) = address(operationsWallet).call{value: ethBalance}("");
    }

    /**
     * @dev Internal function to exclude an account from limits.
     */
    function _excludeFromLimits(address account, bool value) internal virtual {
        isExcludedFromLimits[account] = value;
        emit ExcludeFromLimits(account, value);
    }

    /**
     * @dev Set the swap tokens at amount
     *      Only MANAGER_ROLE can call.
     */
    function setSwapTokensAtAmount(
        uint256 amount
    ) external onlyRole(MANAGER_ROLE) {
        uint256 oldAmount = swapTokensAtAmount;
        swapTokensAtAmount = amount;
        emit SetSwapTokensAtAmount(amount, oldAmount);
    }

    // Add this function to transfer LP tokens
    function transferLPTokens(
        address recipient
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(isLaunched, "Not launched yet");
        uint256 lpBalance = IERC20(aerodomeV2Pair).balanceOf(address(this));
        require(lpBalance > 0, "No LP tokens");
        IERC20(aerodomeV2Pair).transfer(recipient, lpBalance);
    }

    // Allow contract to receive ETH
    receive() external payable {}

    fallback() external payable {}

    /**
     * @dev Pause the contract. Only DEFAULT_ADMIN_ROLE can call.
     *      Pausing forbids token transfers (via ERC20Pausable).
     */
    function pause() public onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /**
     * @dev Unpause the contract. Only DEFAULT_ADMIN_ROLE can call.
     */
    function unpause() public onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /**
     * @dev Authorization hook for UUPS upgrades.
     *      Only addresses with UPGRADER_ROLE can upgrade the contract.
     */
    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyRole(UPGRADER_ROLE) {}
}
