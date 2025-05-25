// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.6.2;

interface IAerodomeV2Router01 {
    function defaultFactory() external pure returns (address);

    function weth() external pure returns (address);

    function addLiquidityETH(
        address token,
        bool stable,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    )
        external
        payable
        returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
}
