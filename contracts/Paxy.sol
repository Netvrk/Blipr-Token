// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "./interfaces/IUniswapV2Router02.sol";
import "./interfaces/IUniswapV2Factory.sol";

contract Paxy is ERC20, ERC20Burnable, Ownable {
    uint256 public buyTaxRate;
    uint256 public sellTaxRate;
    address public taxCollector;
    uint256 public _maxTxAmount;
    uint256 public _maxWalletSize;

    bool public isLaunched;
    bool public taxEnabled;

    IUniswapV2Router02 public uniswapV2Router;
    uint256 private constant TAX_DENOMINATOR = 10000;
    uint256 private constant MAX_TAX = 2500;
    bool private inSwap = false;
    mapping(address => bool) public automatedMarketMakerPairs;
    mapping(address => bool) public excludedFromLimits;

    event Launch();
    event SetAutomatedMarketMakerPair(address indexed pair, bool indexed value);
    event ExcludeFromLimits(address indexed account, bool isExcluded);

    constructor(
        address _initialOwner,
        address _taxCollector
    ) ERC20("Paxy", "PAXY") Ownable(_initialOwner) {
        _mint(_initialOwner, 1000000 * (10 ** decimals()));
        taxCollector = _taxCollector;

        uint256 totalSupply = totalSupply();
        _maxTxAmount = totalSupply / 100; // 1% of total supply
        _maxWalletSize = totalSupply / 50; // 2% of total supply

        taxEnabled = true;
        buyTaxRate = 1000; // 10%
        sellTaxRate = 1000; // 10%
    }

    function setTaxRates(
        uint256 _buyTaxRate,
        uint256 _sellTaxRate
    ) external onlyOwner {
        require(_buyTaxRate <= MAX_TAX, "Buy tax rate exceeds maximum");
        require(_sellTaxRate <= MAX_TAX, "Sell tax rate exceeds maximum");
        taxEnabled = false;
        buyTaxRate = _buyTaxRate;
        sellTaxRate = _sellTaxRate;
    }

    function setAutomatedMarketMaker(
        address pair,
        bool value
    ) public onlyOwner {
        require(pair != address(0), "Pair is the zero address");
        automatedMarketMakerPairs[pair] = value;
        emit SetAutomatedMarketMakerPair(pair, value);
    }

    function setTaxCollector(address _taxCollector) external onlyOwner {
        taxCollector = _taxCollector;
    }

    function launch() external onlyOwner {
        require(!isLaunched, "Already launched");

        uniswapV2Router = IUniswapV2Router02(
            0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24
        );
        address uniswapV2Pair = IUniswapV2Factory(uniswapV2Router.factory())
            .createPair(address(this), uniswapV2Router.WETH());

        setAutomatedMarketMaker(uniswapV2Pair, true);
        isLaunched = true;
        emit Launch();
    }

    function excludeFromLimits(address account, bool value) external onlyOwner {
        excludedFromLimits[account] = value;
        emit ExcludeFromLimits(account, value);
    }

    function _update(
        address from,
        address to,
        uint256 amount
    ) internal override {
        uint256 taxAmount = 0;

        // Apply tax
        if (automatedMarketMakerPairs[from] && to != address(uniswapV2Router)) {
            // Buy transaction
            require(amount <= _maxTxAmount, "Exceeds the _maxTxAmount.");
            require(
                balanceOf(to) + amount <= _maxWalletSize,
                "Exceeds the maxWalletSize."
            );
            if (taxEnabled) {
                taxAmount = (amount * buyTaxRate) / TAX_DENOMINATOR;
            }
        }

        if (automatedMarketMakerPairs[to] && from != address(this)) {
            // Sell transaction
            require(amount <= _maxTxAmount, "Exceeds the _maxTxAmount.");
            if (taxEnabled) {
                taxAmount = (amount * sellTaxRate) / TAX_DENOMINATOR;
            }
        }

        if (taxAmount > 0) {
            super._update(from, taxCollector, taxAmount);
            amount -= taxAmount;
        }

        super._update(from, to, amount);
    }

    function recoverERC20(
        address tokenAddress,
        uint256 amount
    ) external onlyOwner {
        IERC20(tokenAddress).transfer(msg.sender, amount);
    }

    function recoverETH(uint256 amount) external onlyOwner {
        payable(msg.sender).transfer(amount);
    }
}
