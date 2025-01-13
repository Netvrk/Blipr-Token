// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "./interfaces/IUniswapV2Router02.sol";
import "./interfaces/IUniswapV2Factory.sol";

contract Cipher is Ownable, ERC20 {
    IUniswapV2Router02 public immutable uniswapV2Router;

    address public constant ZERO_ADDRESS = address(0);
    address public constant DEAD_ADDRESS = address(0xdEaD);
    uint256 public cooldownPeriodBlocks = 3;

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

    constructor(
        address _operationsWallet
    ) Ownable(msg.sender) ERC20("Cipher Protocol", "CIPHER") {
        address sender = msg.sender;
        _mint(sender, 100_000_000 ether);
        uint256 totalSupply = totalSupply();

        operationsWallet = _operationsWallet;

        maxBuy = (totalSupply * 7) / 1000; // 0.7%
        maxSell = (totalSupply * 7) / 1000; // 0.7%
        maxWallet = (totalSupply * 7) / 1000; // 0.7%
        swapTokensAtAmount = (totalSupply * 2) / 1000; // 0.2%

        isLimitsEnabled = true;
        isCooldownEnabled = true;
        isTaxEnabled = true;

        buyFee = 30;
        sellFee = 45;
        transferFee = 45;

        uniswapV2Router = IUniswapV2Router02(
            0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24
        );

        _excludeFromFees(address(this), true);
        _excludeFromFees(address(0xdead), true);
        _excludeFromFees(sender, true);
        _excludeFromFees(operationsWallet, true);
        _excludeFromLimits(address(this), true);
        _excludeFromLimits(address(0xdead), true);
        _excludeFromLimits(sender, true);
    }

    receive() external payable {}

    fallback() external payable {}

    function _transferOwnership(address newOwner) internal override {
        address oldOwner = owner();
        if (oldOwner != address(0)) {
            _excludeFromFees(oldOwner, false);
            _excludeFromLimits(oldOwner, false);
        }
        _excludeFromFees(newOwner, true);
        _excludeFromLimits(newOwner, true);
        super._transferOwnership(newOwner);
    }

    function launch() external onlyOwner {
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
            owner(),
            block.timestamp
        );
        IERC20(uniswapV2Pair).approve(address(uniswapV2Router), type(uint).max);
        isLaunched = true;
        launchBlock = block.number;
        launchTime = block.timestamp;
        emit Launch();
    }

    function RemoveLimits() external onlyOwner {
        isLimitsEnabled = false;
        emit SetLimitsEnabled(false);
    }

    function RemoveCooldown() external onlyOwner {
        isCooldownEnabled = false;
        emit SetCooldownEnabled(false);
    }

    function setTaxesEnabled(bool value) external onlyOwner {
        isTaxEnabled = value;
        emit SetTaxesEnabled(value);
    }

    function setSwapTokensAtAmount(uint256 amount) external onlyOwner {
        uint256 _totalSupply = totalSupply();
        require(amount >= (_totalSupply * 1) / 1000000, AmountTooLow()); // 0.0001%
        require(amount <= (_totalSupply * 5) / 1000, AmountTooHigh()); // 0.5%
        uint256 oldValue = swapTokensAtAmount;
        swapTokensAtAmount = amount;
        emit SetSwapTokensAtAmount(amount, oldValue);
    }

    function ReduceBuyFees(uint256 _buyFee) external onlyOwner {
        if (block.number == launchBlock) {
            buyFee = _buyFee;
        } else {
            require(_buyFee <= buyFee, FeeTooHigh());
            uint256 oldValue = buyFee;
            buyFee = _buyFee;
            emit SetBuyFees(_buyFee, oldValue);
        }
    }

    function ReduceSellFees(uint256 _sellFee) external onlyOwner {
        require(_sellFee <= sellFee, FeeTooHigh());
        uint256 oldValue = sellFee;
        sellFee = _sellFee;
        transferFee = sellFee;
        emit SetTransferFees(sellFee, oldValue);
        emit SetSellFees(_sellFee, oldValue);
    }

    function ReduceTransferFees(uint256 _transferFee) external onlyOwner {
        require(_transferFee <= transferFee, FeeTooHigh());
        uint256 oldValue = transferFee;
        transferFee = _transferFee;
        emit SetTransferFees(_transferFee, oldValue);
    }

    function excludeFromFees(
        address[] calldata accounts,
        bool value
    ) external onlyOwner {
        for (uint256 i = 0; i < accounts.length; i++) {
            _excludeFromFees(accounts[i], value);
        }
    }

    function excludeFromLimits(
        address[] calldata accounts,
        bool value
    ) external onlyOwner {
        for (uint256 i = 0; i < accounts.length; i++) {
            _excludeFromLimits(accounts[i], value);
        }
    }

    function withdrawStuckTokens(address _token) external onlyOwner {
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

    function _update(
        address from,
        address to,
        uint256 amount
    ) internal virtual override {
        address origin = tx.origin;

        require(
            isLaunched ||
                isExcludedFromLimits[from] ||
                isExcludedFromLimits[to],
            NotLaunched()
        );

        bool limits = isLimitsEnabled &&
            !inSwapBack &&
            !(isExcludedFromLimits[from] || isExcludedFromLimits[to]);
        if (limits) {
            if (
                from != owner() &&
                to != owner() &&
                to != ZERO_ADDRESS &&
                to != DEAD_ADDRESS
            ) {
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

                if (
                    automatedMarketMakerPairs[from] && !isExcludedFromLimits[to]
                ) {
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
        }

        bool takeFee = isTaxEnabled &&
            !inSwapBack &&
            !(isExcludedFromFees[from] || isExcludedFromFees[to]);

        if (takeFee) {
            uint256 fees = 0;
            if (automatedMarketMakerPairs[to] && sellFee > 0) {
                fees = (amount * sellFee) / 100;
            } else if (automatedMarketMakerPairs[from] && buyFee > 0) {
                fees = (amount * buyFee) / 100;
            } else if (
                !automatedMarketMakerPairs[to] &&
                !automatedMarketMakerPairs[from] &&
                transferFee > 0
            ) {
                fees = (amount * transferFee) / 100;
            }

            if (fees > 0) {
                amount -= fees;
                super._update(from, address(this), fees);
            }
        }

        uint256 balance = balanceOf(address(this));
        bool shouldSwap = balance >= swapTokensAtAmount;

        if (takeFee && !automatedMarketMakerPairs[from] && shouldSwap) {
            if (block.number > lastSwapBackExecutionBlock) {
                if (balance > swapTokensAtAmount) {
                    balance = swapTokensAtAmount;
                }
                _swapBack(balance);
                lastSwapBackExecutionBlock = block.number;
            }
        }

        super._update(from, to, amount);
    }

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

    function _excludeFromFees(address account, bool value) internal virtual {
        isExcludedFromFees[account] = value;
        emit ExcludeFromFees(account, value);
    }

    function _excludeFromLimits(address account, bool value) internal virtual {
        isExcludedFromLimits[account] = value;
        emit ExcludeFromLimits(account, value);
    }

    function manualswap(uint256 _percen) external onlyOwner {
        uint256 balance = balanceOf(address(this));
        uint256 amt = (balance * _percen) / 100;
        _swapBack(amt);
    }

    function _setAutomatedMarketMakerPair(
        address pair,
        bool value
    ) internal virtual {
        automatedMarketMakerPairs[pair] = value;
        emit SetAutomatedMarketMakerPair(pair, value);
    }
}
