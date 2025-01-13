// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import "./interfaces/IUniswapV2Router02.sol";
import "./interfaces/IUniswapV2Factory.sol";

contract Cipher is
    Initializable,
    AccessControlUpgradeable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable
{
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    IUniswapV2Router02 public uniswapV2Router;

    address public constant ZERO_ADDRESS = address(0);
    address public constant DEAD_ADDRESS = address(0xdEaD);
    uint256 public cooldownPeriodBlocks;

    address public uniswapV2Pair;
    address public operationsWallet;

    bool public isLimitsEnabled;
    bool public isCooldownEnabled;
    bool public isTaxEnabled;
    bool private inSwapBack;
    bool public isLaunched;

    uint256 public launchBlock;
    uint256 public launchTime;

    uint256 private lastSwapBackExecutionBlock;

    uint256 public maxBuy;
    uint256 public maxSell;
    uint256 public maxWallet;

    uint256 public swapTokensAtAmount;
    uint256 public buyFee;
    uint256 public sellFee;
    uint256 public transferFee;

    uint256 private constant MAX_FEE = 6000;
    uint256 private constant DENM = 10000;

    mapping(address => bool) public isExcludedFromFees;
    mapping(address => bool) public isExcludedFromLimits;
    mapping(address => bool) public automatedMarketMakerPairs;
    mapping(address => uint256) private _holderLastTransferBlock;

    event Launch();
    event SetOperationsWallet(address newWallet, address oldWallet);
    event SetmarketingWallet(address newWallet, address oldWallet);
    event SetLimitsEnabled(bool status);
    event SetCooldownEnabled(bool status);
    event SetTaxesEnabled(bool status);
    event SetMaxBuy(uint256 amount);
    event SetMaxSell(uint256 amount);
    event SetMaxWallet(uint256 amount);
    event SetSwapTokensAtAmount(uint256 newValue, uint256 oldValue);
    event SetBuyFees(uint256 newValue, uint256 oldValue);
    event SetSellFees(uint256 newValue, uint256 oldValue);
    event SetTransferFees(uint256 newValue, uint256 oldValue);
    event ExcludeFromFees(address account, bool isExcluded);
    event ExcludeFromLimits(address account, bool isExcluded);
    event SetAutomatedMarketMakerPair(address pair, bool value);
    event WithdrawStuckTokens(address token, uint256 amount);

    error AlreadyLaunched();
    error AddressZero();
    error AmountTooLow();
    error AmountTooHigh();
    error FeeTooHigh();
    error AMMAlreadySet();
    error NoNativeTokens();
    error NoTokens();
    error FailedToWithdrawNativeTokens();
    error BotDetected();
    error TransferDelay();
    error MaxBuyAmountExceed();
    error MaxSellAmountExceed();
    error MaxWalletAmountExceed();
    error NotLaunched();

    modifier lockSwapBack() {
        inSwapBack = true;
        _;
        inSwapBack = false;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _operationsWallet) external initializer {
        __ERC20_init("Cipher Protocol", "CIPHER");
        __ERC20Permit_init("Cipher Protocol");
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        address sender = msg.sender;

        _grantRole(DEFAULT_ADMIN_ROLE, sender);
        _grantRole(MANAGER_ROLE, sender);
        _grantRole(UPGRADER_ROLE, sender);

        uint256 totalSupply = 100_000_000 ether;

        cooldownPeriodBlocks = 3;
        operationsWallet = _operationsWallet;

        maxBuy = (totalSupply * 70) / DENM; // 0.7%
        maxSell = (totalSupply * 70) / DENM; // 0.7%
        maxWallet = (totalSupply * 70) / DENM; // 0.7%
        swapTokensAtAmount = (totalSupply * 20) / DENM; // 0.2%

        isLimitsEnabled = true;
        isCooldownEnabled = true;
        isTaxEnabled = true;

        buyFee = 3000;
        sellFee = 3000;
        transferFee = 3000;

        uniswapV2Router = IUniswapV2Router02(
            0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24
        );

        // Exclude the contract from fees
        _excludeFromFees(address(this), true);
        _excludeFromFees(ZERO_ADDRESS, true);
        _excludeFromFees(DEAD_ADDRESS, true);
        _excludeFromFees(sender, true);
        _excludeFromFees(operationsWallet, true);

        // Exclude the contract from limits
        _excludeFromLimits(address(this), true);
        _excludeFromLimits(ZERO_ADDRESS, true);
        _excludeFromLimits(DEAD_ADDRESS, true);
        _excludeFromLimits(sender, true);
        _excludeFromLimits(operationsWallet, true);

        // Mint the total supply to owner
        _mint(sender, totalSupply);
    }

    receive() external payable {}

    fallback() external payable {}

    /*
     * /////////////////////////////////////////////////////////////////
     * @dev Upgrade the contract
     * @dev Only the upgrader can call this function
     * /////////////////////////////////////////////////////////////////
     */
    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyRole(UPGRADER_ROLE) {}

    /*
     * /////////////////////////////////////////////////////////////////
     * @dev Launch the token
     * @dev Add liquidity to the uniswap pair
     * @dev Approve the uniswap pair to spend the token
     * @dev Set the token as launched
     * /////////////////////////////////////////////////////////////////
     */

    function launch() external onlyRole(MANAGER_ROLE) nonReentrant {
        require(!isLaunched, AlreadyLaunched());

        uniswapV2Pair = IUniswapV2Factory(uniswapV2Router.factory()).createPair(
                address(this),
                uniswapV2Router.WETH()
            );

        _setAutomatedMarketMakerPair(uniswapV2Pair, true);
        _approve(address(this), address(uniswapV2Router), type(uint256).max);
        uniswapV2Router.addLiquidityETH{value: address(this).balance}(
            address(this),
            balanceOf(address(this)),
            0,
            0,
            msg.sender,
            block.timestamp
        );
        IERC20(uniswapV2Pair).approve(address(uniswapV2Router), type(uint).max);
        isLaunched = true;
        launchBlock = block.number;
        launchTime = block.timestamp;
        emit Launch();
    }

    /*
     * /////////////////////////////////////////////////////////////////
     * @dev Remove the limits
     * /////////////////////////////////////////////////////////////////
     */
    function RemoveLimits() external onlyRole(MANAGER_ROLE) {
        isLimitsEnabled = false;
        emit SetLimitsEnabled(false);
    }

    /*
     * /////////////////////////////////////////////////////////////////
     * @dev Remove the cooldown
     * /////////////////////////////////////////////////////////////////
     */
    function RemoveCooldown() external onlyRole(MANAGER_ROLE) {
        isCooldownEnabled = false;
        emit SetCooldownEnabled(false);
    }

    /*
     * /////////////////////////////////////////////////////////////////
     * @dev Remove the taxes
     * @dev Emit SetTaxesEnabled event
     * /////////////////////////////////////////////////////////////////
     */
    function setTaxesEnabled(bool value) external onlyRole(MANAGER_ROLE) {
        isTaxEnabled = value;
        emit SetTaxesEnabled(value);
    }

    /*
     * /////////////////////////////////////////////////////////////////
     * @dev Set swap tokens at amount
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

    /*
     * /////////////////////////////////////////////////////////////////
     * @dev Set automatic market maker pair
     * /////////////////////////////////////////////////////////////////
     */
    function setAutomaticMarketMakerPair(
        address pair,
        bool value
    ) external onlyRole(MANAGER_ROLE) {
        require(!automatedMarketMakerPairs[pair], AMMAlreadySet());
        _setAutomatedMarketMakerPair(pair, value);
    }

    /*
     * /////////////////////////////////////////////////////////////////
     * @dev Reduce the fees (buy, sell, transfer)
     * @param newBuyFee The new buy fee value
     * @param newSellFee The new sell fee value
     * @param newTransferFee The new transfer fee value
     * /////////////////////////////////////////////////////////////////
     */
    function setFees(
        uint256 newBuyFee,
        uint256 newSellFee,
        uint256 newTransferFee
    ) external onlyRole(MANAGER_ROLE) {
        // Reduce buy fee
        require(newBuyFee <= MAX_FEE, FeeTooHigh());
        uint256 oldBuyFee = buyFee;
        buyFee = newBuyFee;
        emit SetBuyFees(newBuyFee, oldBuyFee);

        // Reduce sell fee
        require(newSellFee <= MAX_FEE, FeeTooHigh());
        uint256 oldSellFee = sellFee;
        sellFee = newSellFee;
        emit SetSellFees(newSellFee, oldSellFee);

        // Reduce transfer fee
        require(newTransferFee <= MAX_FEE, FeeTooHigh());
        uint256 oldTransferFee = transferFee;
        transferFee = newTransferFee;
        emit SetTransferFees(newTransferFee, oldTransferFee);
    }

    function setLimits(
        uint256 newMaxBuy,
        uint256 newMaxSell,
        uint256 newMaxWallet
    ) external onlyRole(MANAGER_ROLE) {
        uint256 _totalSupply = totalSupply();
        require(newMaxBuy >= (_totalSupply * 1) / DENM, AmountTooLow()); // 0.01%
        require(newMaxBuy <= (_totalSupply * 500) / DENM, AmountTooHigh()); // 5%
        maxBuy = newMaxBuy;
        emit SetMaxBuy(newMaxBuy);

        require(newMaxSell >= (_totalSupply * 1) / DENM, AmountTooLow()); // 0.01%
        require(newMaxSell <= (_totalSupply * 500) / DENM, AmountTooHigh()); // 5%
        maxSell = newMaxSell;
        emit SetMaxSell(newMaxSell);

        require(newMaxWallet >= (_totalSupply * 1) / DENM, AmountTooLow()); // 0.01%
        require(newMaxWallet <= (_totalSupply * 500) / DENM, AmountTooHigh()); // 5%
        maxWallet = newMaxWallet;
        emit SetMaxWallet(newMaxWallet);
    }

    /*
     * /////////////////////////////////////////////////////////////////
     * @dev Exclude an accounts from fees
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

    /*
     * /////////////////////////////////////////////////////////////////
     * @dev Exclude an accounts from limits
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

    /*
     * /////////////////////////////////////////////////////////////////
     * @dev Withdraw stuck tokens
     * /////////////////////////////////////////////////////////////////
     */
    function withdrawStuckTokens(
        address _token
    ) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        address sender = msg.sender;
        uint256 amount;
        if (_token == ZERO_ADDRESS) {
            bool success;
            amount = address(this).balance;
            require(amount > 0, NoNativeTokens());
            (success, ) = address(sender).call{value: amount}("");
            require(success, FailedToWithdrawNativeTokens());
        } else {
            amount = IERC20(_token).balanceOf(address(this));
            require(amount > 0, NoTokens());
            IERC20(_token).transfer(msg.sender, amount);
        }
        emit WithdrawStuckTokens(_token, amount);
    }

    /*
     * /////////////////////////////////////////////////////////////////
     * @dev Manually swap tokens
     * /////////////////////////////////////////////////////////////////
     */
    function manualSwap(
        uint256 _percen
    ) external onlyRole(MANAGER_ROLE) nonReentrant {
        uint256 balance = balanceOf(address(this));
        uint256 amt = (balance * _percen) / DENM;
        _swapBack(amt);
    }

    /*
     * /////////////////////////////////////////////////////////////////
     * @dev Override the _update function
     * @dev Handles the tax, limits and cooldown
     * /////////////////////////////////////////////////////////////////
     */
    function _update(
        address from,
        address to,
        uint256 amount
    ) internal virtual override(ERC20Upgradeable) {
        address origin = tx.origin;

        require(
            isLaunched ||
                isExcludedFromLimits[from] ||
                isExcludedFromLimits[to],
            NotLaunched()
        );

        // Check if the transaction is limited
        bool isLimited = isLimitsEnabled &&
            !inSwapBack &&
            !(isExcludedFromLimits[from] || isExcludedFromLimits[to]);
        if (isLimited) {
            if (isCooldownEnabled) {
                if (to != address(uniswapV2Router) && to != uniswapV2Pair) {
                    require(
                        _holderLastTransferBlock[origin] +
                            cooldownPeriodBlocks <
                            block.number + cooldownPeriodBlocks &&
                            _holderLastTransferBlock[to] < block.number,
                        TransferDelay()
                    );
                    _holderLastTransferBlock[origin] = block.number;
                    _holderLastTransferBlock[to] = block.number;
                }
            }

            if (automatedMarketMakerPairs[from] && !isExcludedFromLimits[to]) {
                require(amount <= maxBuy, MaxBuyAmountExceed());
                require(
                    amount + balanceOf(to) <= maxWallet,
                    MaxWalletAmountExceed()
                );
            } else if (
                automatedMarketMakerPairs[to] && !isExcludedFromLimits[from]
            ) {
                require(amount <= maxSell, MaxSellAmountExceed());
            } else if (!isExcludedFromLimits[to]) {
                require(
                    amount + balanceOf(to) <= maxWallet,
                    MaxWalletAmountExceed()
                );
            }
        }

        // Check if the transaction is taxed
        bool isTaxed = isTaxEnabled &&
            !inSwapBack &&
            !(isExcludedFromFees[from] || isExcludedFromFees[to]);
        if (isTaxed) {
            uint256 fees = 0;
            if (automatedMarketMakerPairs[to] && sellFee > 0) {
                fees = (amount * sellFee) / DENM;
            } else if (automatedMarketMakerPairs[from] && buyFee > 0) {
                fees = (amount * buyFee) / DENM;
            } else if (
                !automatedMarketMakerPairs[to] &&
                !automatedMarketMakerPairs[from] &&
                transferFee > 0
            ) {
                fees = (amount * transferFee) / DENM;
            }

            if (fees > 0) {
                amount -= fees;
                super._update(from, address(this), fees);
            }
        }

        // Check if the contract should swap tokens
        uint256 balance = balanceOf(address(this));
        bool shouldSwap = balance >= swapTokensAtAmount;
        if (isTaxed && !automatedMarketMakerPairs[from] && shouldSwap) {
            if (block.number > lastSwapBackExecutionBlock) {
                if (balance > swapTokensAtAmount) {
                    balance = swapTokensAtAmount;
                }
                _swapBack(balance);
                lastSwapBackExecutionBlock = block.number;
            }
        }

        // Transfer the tokens
        super._update(from, to, amount);
    }

    /*
     * /////////////////////////////////////////////////////////////////
     * @dev Swap tokens for eth
     * @dev Transfer the eth to the operations wallet
     * /////////////////////////////////////////////////////////////////
     */
    function _swapBack(uint256 balance) internal virtual lockSwapBack {
        bool success;
        address[] memory path = new address[](2);
        path[0] = address(this);
        path[1] = uniswapV2Router.WETH();
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

    /*
     * /////////////////////////////////////////////////////////////////
     * @dev Set excluded from fees
     * /////////////////////////////////////////////////////////////////
     */
    function _excludeFromFees(address account, bool value) internal virtual {
        isExcludedFromFees[account] = value;
        emit ExcludeFromFees(account, value);
    }

    /*
     * /////////////////////////////////////////////////////////////////
     * @dev Set excluded from limits
     * /////////////////////////////////////////////////////////////////
     */
    function _excludeFromLimits(address account, bool value) internal virtual {
        isExcludedFromLimits[account] = value;
        emit ExcludeFromLimits(account, value);
    }

    /*
     * /////////////////////////////////////////////////////////////////
     * @dev Set automated market maker pair
     * /////////////////////////////////////////////////////////////////
     */
    function _setAutomatedMarketMakerPair(
        address pair,
        bool value
    ) internal virtual {
        automatedMarketMakerPairs[pair] = value;
        emit SetAutomatedMarketMakerPair(pair, value);
    }
}
