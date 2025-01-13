// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";

import "./interfaces/IUniswapV2Factory.sol";
import "./interfaces/IUniswapV2Pair.sol";
import "./interfaces/IUniswapV2Router01.sol";
import "./interfaces/IUniswapV2Router02.sol";

contract SillyCat is ERC20, ERC20Burnable, Ownable, Initializable {
    uint16 public swapThresholdRatio;

    uint256 private _treasuryPending;
    uint256 private _liquidityPending;

    address public treasuryAddress;
    uint16[3] public treasuryFees;

    uint16[3] public liquidityFees;

    mapping(address => bool) public isExcludedFromFees;

    uint16[3] public totalFees;
    bool private _swapping;

    IUniswapV2Router02 public routerV2;
    address public pairV2;
    mapping(address => bool) public AMMs;

    error InvalidAmountToRecover(uint256 amount, uint256 maxAmount);

    error InvalidToken(address tokenAddress);

    error CannotDepositNativeCoins(address account);

    error InvalidSwapThresholdRatio(uint16 swapThresholdRatio);

    error InvalidTaxRecipientAddress(address account);

    error CannotExceedMaxTotalFee(
        uint16 buyFee,
        uint16 sellFee,
        uint16 transferFee
    );

    error InvalidAMM(address AMM);

    event SwapThresholdUpdated(uint16 swapThresholdRatio);

    event WalletTaxAddressUpdated(uint8 indexed id, address newAddress);
    event WalletTaxFeesUpdated(
        uint8 indexed id,
        uint16 buyFee,
        uint16 sellFee,
        uint16 transferFee
    );
    event WalletTaxSent(uint8 indexed id, address recipient, uint256 amount);

    event LiquidityFeesUpdated(
        uint16 buyFee,
        uint16 sellFee,
        uint16 transferFee
    );
    event LiquidityAdded(uint amountToken, uint amountCoin, uint liquidity);
    event ForceLiquidityAdded(uint256 leftoverTokens, uint256 unaddedTokens);

    event ExcludeFromFees(address indexed account, bool isExcluded);

    event RouterV2Updated(address indexed routerV2);
    event AMMUpdated(address indexed AMM, bool isAMM);

    constructor(
        address _initialOwner,
        address _taxCollector
    ) ERC20("SillyCat", "SILLY") Ownable(_initialOwner) {
        updateSwapThreshold(50);
        treasuryAddressSetup(_taxCollector);
        treasuryFeesSetup(250, 250, 0);
        liquidityFeesSetup(0, 0, 0);
        // excludeFromFees(_initialOwner, true);
        excludeFromFees(address(this), true);
        _mint(_initialOwner, 1000000 * (10 ** decimals()));
    }

    /*
        This token is not upgradeable. Function afterConstructor finishes post-deployment setup.
    */
    function afterConstructor(address _router) external initializer {
        _updateRouterV2(_router);
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function recoverToken(uint256 amount) external onlyOwner {
        uint256 maxRecoverable = balanceOf(address(this)) - getAllPending();
        if (amount > maxRecoverable)
            revert InvalidAmountToRecover(amount, maxRecoverable);

        _update(address(this), msg.sender, amount);
    }

    function recoverForeignERC20(
        address tokenAddress,
        uint256 amount
    ) external onlyOwner {
        if (tokenAddress == address(this)) revert InvalidToken(tokenAddress);

        IERC20(tokenAddress).transfer(msg.sender, amount);
    }

    // Prevent unintended coin transfers
    receive() external payable {
        if (msg.sender != address(routerV2))
            revert CannotDepositNativeCoins(msg.sender);
    }

    function _swapTokensForCoin(uint256 tokenAmount) private {
        address[] memory path = new address[](2);
        path[0] = address(this);
        path[1] = routerV2.WETH();

        _approve(address(this), address(routerV2), tokenAmount);

        routerV2.swapExactTokensForETHSupportingFeeOnTransferTokens(
            tokenAmount,
            0,
            path,
            address(this),
            block.timestamp
        );
    }

    function updateSwapThreshold(uint16 _swapThresholdRatio) public onlyOwner {
        if (_swapThresholdRatio == 0 || _swapThresholdRatio > 500)
            revert InvalidSwapThresholdRatio(_swapThresholdRatio);

        swapThresholdRatio = _swapThresholdRatio;

        emit SwapThresholdUpdated(_swapThresholdRatio);
    }

    function getSwapThresholdAmount() public view returns (uint256) {
        return (balanceOf(pairV2) * swapThresholdRatio) / 10000;
    }

    function getAllPending() public view returns (uint256) {
        return 0 + _treasuryPending + _liquidityPending;
    }

    function treasuryAddressSetup(address _newAddress) public onlyOwner {
        if (_newAddress == address(0))
            revert InvalidTaxRecipientAddress(address(0));

        treasuryAddress = _newAddress;
        excludeFromFees(_newAddress, true);

        emit WalletTaxAddressUpdated(1, _newAddress);
    }

    function treasuryFeesSetup(
        uint16 _buyFee,
        uint16 _sellFee,
        uint16 _transferFee
    ) public onlyOwner {
        totalFees[0] = totalFees[0] - treasuryFees[0] + _buyFee;
        totalFees[1] = totalFees[1] - treasuryFees[1] + _sellFee;
        totalFees[2] = totalFees[2] - treasuryFees[2] + _transferFee;
        if (totalFees[0] > 2500 || totalFees[1] > 2500 || totalFees[2] > 2500)
            revert CannotExceedMaxTotalFee(
                totalFees[0],
                totalFees[1],
                totalFees[2]
            );

        treasuryFees = [_buyFee, _sellFee, _transferFee];

        emit WalletTaxFeesUpdated(1, _buyFee, _sellFee, _transferFee);
    }

    function _swapAndLiquify(
        uint256 tokenAmount
    ) private returns (uint256 leftover) {
        // Sub-optimal method for supplying liquidity
        uint256 halfAmount = tokenAmount / 2;
        uint256 otherHalf = tokenAmount - halfAmount;

        _swapTokensForCoin(halfAmount);

        uint256 coinBalance = address(this).balance;

        if (coinBalance > 0) {
            (uint amountToken, uint amountCoin, uint liquidity) = _addLiquidity(
                otherHalf,
                coinBalance
            );

            emit LiquidityAdded(amountToken, amountCoin, liquidity);

            return otherHalf - amountToken;
        } else {
            return otherHalf;
        }
    }

    function _addLiquidity(
        uint256 tokenAmount,
        uint256 coinAmount
    ) private returns (uint, uint, uint) {
        _approve(address(this), address(routerV2), tokenAmount);

        return
            routerV2.addLiquidityETH{value: coinAmount}(
                address(this),
                tokenAmount,
                0,
                0,
                address(0),
                block.timestamp
            );
    }

    function addLiquidityFromLeftoverTokens() external {
        uint256 leftoverTokens = balanceOf(address(this)) - getAllPending();

        uint256 unaddedTokens = _swapAndLiquify(leftoverTokens);

        emit ForceLiquidityAdded(leftoverTokens, unaddedTokens);
    }

    function liquidityFeesSetup(
        uint16 _buyFee,
        uint16 _sellFee,
        uint16 _transferFee
    ) public onlyOwner {
        totalFees[0] = totalFees[0] - liquidityFees[0] + _buyFee;
        totalFees[1] = totalFees[1] - liquidityFees[1] + _sellFee;
        totalFees[2] = totalFees[2] - liquidityFees[2] + _transferFee;
        if (totalFees[0] > 2500 || totalFees[1] > 2500 || totalFees[2] > 2500)
            revert CannotExceedMaxTotalFee(
                totalFees[0],
                totalFees[1],
                totalFees[2]
            );

        liquidityFees = [_buyFee, _sellFee, _transferFee];

        emit LiquidityFeesUpdated(_buyFee, _sellFee, _transferFee);
    }

    function excludeFromFees(
        address account,
        bool isExcluded
    ) public onlyOwner {
        isExcludedFromFees[account] = isExcluded;

        emit ExcludeFromFees(account, isExcluded);
    }

    function _updateRouterV2(address router) private {
        routerV2 = IUniswapV2Router02(router);
        pairV2 = IUniswapV2Factory(routerV2.factory()).createPair(
            address(this),
            routerV2.WETH()
        );

        _setAMM(router, true);
        _setAMM(pairV2, true);

        emit RouterV2Updated(router);
    }

    function setAMM(address AMM, bool isAMM) external onlyOwner {
        if (AMM == pairV2 || AMM == address(routerV2)) revert InvalidAMM(AMM);

        _setAMM(AMM, isAMM);
    }

    function _setAMM(address AMM, bool isAMM) private {
        AMMs[AMM] = isAMM;

        if (isAMM) {}

        emit AMMUpdated(AMM, isAMM);
    }

    function _update(
        address from,
        address to,
        uint256 amount
    ) internal override {
        _beforeTokenUpdate(from, to, amount);

        if (from != address(0) && to != address(0)) {
            if (
                !_swapping &&
                amount > 0 &&
                !isExcludedFromFees[from] &&
                !isExcludedFromFees[to]
            ) {
                uint256 fees = 0;
                uint8 txType = 3;

                if (AMMs[from] && !AMMs[to]) {
                    if (totalFees[0] > 0) txType = 0;
                } else if (AMMs[to] && !AMMs[from]) {
                    if (totalFees[1] > 0) txType = 1;
                } else if (!AMMs[from] && !AMMs[to]) {
                    if (totalFees[2] > 0) txType = 2;
                }

                if (txType < 3) {
                    fees = (amount * totalFees[txType]) / 10000;
                    amount -= fees;

                    _treasuryPending +=
                        (fees * treasuryFees[txType]) /
                        totalFees[txType];

                    _liquidityPending +=
                        (fees * liquidityFees[txType]) /
                        totalFees[txType];
                }

                if (fees > 0) {
                    super._update(from, address(this), fees);
                }
            }

            bool canSwap = getAllPending() >= getSwapThresholdAmount() &&
                balanceOf(pairV2) > 0;

            if (
                !_swapping &&
                from != pairV2 &&
                from != address(routerV2) &&
                canSwap
            ) {
                _swapping = true;

                if (false || _treasuryPending > 0) {
                    uint256 token2Swap = 0 + _treasuryPending;
                    bool success = false;

                    _swapTokensForCoin(token2Swap);
                    uint256 coinsReceived = address(this).balance;

                    uint256 treasuryPortion = (coinsReceived *
                        _treasuryPending) / token2Swap;
                    if (treasuryPortion > 0) {
                        (success, ) = payable(treasuryAddress).call{
                            value: treasuryPortion
                        }("");
                        if (success) {
                            emit WalletTaxSent(
                                1,
                                treasuryAddress,
                                treasuryPortion
                            );
                        }
                    }
                    _treasuryPending = 0;
                }

                if (_liquidityPending > 0) {
                    _swapAndLiquify(_liquidityPending);
                    _liquidityPending = 0;
                }

                _swapping = false;
            }
        }

        super._update(from, to, amount);

        _afterTokenUpdate(from, to, amount);
    }

    function _beforeTokenUpdate(
        address from,
        address to,
        uint256 amount
    ) internal view {}

    function _afterTokenUpdate(
        address from,
        address to,
        uint256 amount
    ) internal {}
}
