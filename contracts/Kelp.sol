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

contract Kelp is
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

    // Constants: maximum fee (50%) and denominator (10000 = basis points)
    uint256 private constant MAX_FEE = 5000; // 50%
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
    event WithdrawStuckTokens(address token, uint256 amount);
    event AccountBlocked(address account, bool value);

    // Custom errors for more explicit reverts
    error AlreadyLaunched();
    error AmountOutOfBounds();
    error FeeTooHigh();
    error AMMAlreadySet();
    error NoTokens();
    error FailedToWithdrawTokens();
    error NotLaunched();
    error AccountBlockedFromTransfer();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // Disable initializers to prevent logic contract from being initialized directly
        _disableInitializers();
    }

    /**
     * @dev Initializes the contract after deployment behind a proxy.
     */
    function initialize() external initializer {
        // Initialize parent contracts
        __ERC20_init("Kelp AI", "KLXP");
        __ERC20Permit_init("Kelp AI");
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        address sender = msg.sender;

        // Assign default roles
        _grantRole(DEFAULT_ADMIN_ROLE, sender);
        _grantRole(MANAGER_ROLE, sender);

        // Define total supply: 1 billion tokens, 18 decimals => 1_000_000_000 ether
        uint256 totalSupply = 1_000_000_000 ether;

        // Set default limits
        limits = Limits({
            maxBuy: (totalSupply * 50) / DENM, //  0.5% of total supply
            maxSell: (totalSupply * 50) / DENM, // 0.5% of total supply
            maxWallet: (totalSupply * 100) / DENM // 1% of total supply
        });

        // By default, limits and tax are enabled
        isLimitsEnabled = true;
        isTaxEnabled = true;

        // Default fees are set to 10% for buy, sell, and transfer
        fees = Fees({buyFee: 1000, sellFee: 1000, transferFee: 1000}); // 10%

        // Exclude important addresses from limits
        _excludeFromLimits(address(this), true);
        _excludeFromLimits(address(0), true);
        _excludeFromLimits(sender, true);

        // Mint the total supply to the deployer (sender)
        _mint(sender, totalSupply);
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

    /**
     * @dev Launch the token and enable transfers.
     *      This can only be done once by MANAGER_ROLE.
     */
    function launch() external onlyRole(MANAGER_ROLE) nonReentrant {
        require(!isLaunched, AlreadyLaunched());
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
     *      Each fee cannot exceed MAX_FEE (currently 50%).
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
     * @dev Set (or unset) an address as an automated market maker pair.
     *      Typically used for DEX pairs.
     *      Only MANAGER_ROLE can call.
     */
    function setAutomaticMarketMakerPair(
        address pair,
        bool value
    ) external onlyRole(MANAGER_ROLE) {
        // If already set to true, revert to avoid re-setting
        require(!automatedMarketMakerPairs[pair], AMMAlreadySet());
        automatedMarketMakerPairs[pair] = value;
        emit SetAutomatedMarketMakerPair(pair, value);
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
    ) internal virtual override(ERC20Upgradeable, ERC20PausableUpgradeable) {
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

        // Proceed with the normal transfer
        super._update(from, to, amount);
    }

    /**
     * @dev Internal function to exclude an account from limits.
     */
    function _excludeFromLimits(address account, bool value) internal virtual {
        isExcludedFromLimits[account] = value;
        emit ExcludeFromLimits(account, value);
    }
}
