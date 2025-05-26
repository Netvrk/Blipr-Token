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

contract SilkAIv2 is
    Initializable,
    AccessControlUpgradeable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    ERC20PausableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable
{
    IUniswapV2Router02 private uniswapV2Router;
    address private uniswapV2Pair;

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

    // Constants: maximum fee (50%) and denominator (10000 = basis points)
    uint256 private constant MAX_FEE = 2000; // 20%
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

    // Custom errors for more explicit reverts
    error AlreadyLaunched();
    error AmountOutOfBounds();
    error FeeTooHigh();
    error NoTokens();
    error FailedToWithdrawTokens();
    error NotLaunched();
    error AccountBlockedFromTransfer();

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
        __ERC20_init("BONK AI", "BONKAI");
        __ERC20Permit_init("BONK AI");
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        address sender = msg.sender;

        // Assign default roles
        _grantRole(DEFAULT_ADMIN_ROLE, ownerAddress); // Multisig wallet
        _grantRole(MANAGER_ROLE, sender);
        // Update upgrader when needed in future

        // Define total supply: 1 billion tokens, 18 decimals => 1_000_000_000 ether
        uint256 _totalSupply = 1_000_000_000 ether;

        // Set default limits
        // 5% maxbuy, 5% maxsell, 10% maxwallet
        limits = Limits({
            maxBuy: (_totalSupply * 400) / DENM, //  4% of total supply
            maxSell: (_totalSupply * 200) / DENM, // 2% of total supply
            maxWallet: (_totalSupply * 500) / DENM // 5% of total supply
        });

        // By default, limits and tax are enabled
        isLimitsEnabled = true;
        isTaxEnabled = true;

        swapTokensAtAmount = (_totalSupply * 5) / DENM; // 0.05% of total supply

        // Default fees are set to 1% for buy, sell, and transfer
        fees = Fees({buyFee: 200, sellFee: 200, transferFee: 0}); // 2% buy/sell tax

        // Set operations wallet
        operationsWallet = ownerAddress;

        // Exclude important addresses from limits
        _excludeFromLimits(address(this), true);
        _excludeFromLimits(address(0), true);
        _excludeFromLimits(sender, true);
        _excludeFromLimits(ownerAddress, true);

        // Mint the total supply to the owner
        _mint(ownerAddress, _totalSupply);
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
        uniswapV2Router = IUniswapV2Router02(
            0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24
        );
        address uniswapFeeCollector = 0x5d64D14D2CF4fe5fe4e65B1c7E3D11e18D493091;
        uniswapV2Pair = IUniswapV2Factory(uniswapV2Router.factory()).createPair(
                address(this),
                uniswapV2Router.WETH()
            );
        _excludeFromLimits(uniswapFeeCollector, true);
        _setAutomatedMarketMakerPair(uniswapV2Pair, true);
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
        operationsWallet = _wallet;
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
        uint256 amount;

        if (_token == address(0)) {
            // Withdraw ETH
            amount = address(this).balance;
            require(amount > 0, NoTokens());
            (bool success, ) = address(msg.sender).call{value: amount}("");
            require(success, FailedToWithdrawTokens());
        } else if (_token == address(this)) {
            // Withdraw this contract's own tokens
            amount = balanceOf(address(this));
            require(amount > 0, NoTokens());
            _transfer(address(this), msg.sender, amount);
        } else {
            // Withdraw other ERC20 tokens
            amount = IERC20(_token).balanceOf(address(this));
            require(amount > 0, NoTokens());
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

        // Skip limits and fees during swap operations
        if (inSwapBack) {
            super._update(from, to, amount);
            return;
        }

        // Check if we should swap accumulated tokens
        uint256 contractTokenBalance = balanceOf(address(this));
        bool shouldSwap = contractTokenBalance >= swapTokensAtAmount;

        // Perform swap if threshold reached and not buying tokens
        if (shouldSwap && !automatedMarketMakerPairs[from]) {
            _swapBack(contractTokenBalance);
            lastSwapBackExecutionBlock = block.number;
        }

        // Apply transaction & wallet size limits if needed
        bool isExempt = isExcludedFromLimits[from] || isExcludedFromLimits[to];
        if (isLimitsEnabled && !isExempt) {
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
        if (isTaxEnabled && !isExempt) {
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

    function _swapBack(uint256 balance) internal virtual lockSwapBack {
        bool success;
        address[] memory path = new address[](2);
        path[0] = address(this);
        path[1] = uniswapV2Router.WETH();

        uint256 maxSwapAmount = swapTokensAtAmount * 20;

        if (balance > maxSwapAmount) {
            balance = maxSwapAmount;
        }

        uniswapV2Router.swapExactTokensForETHSupportingFeeOnTransferTokens(
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
}
