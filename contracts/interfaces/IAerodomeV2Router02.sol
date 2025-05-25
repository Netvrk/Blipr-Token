// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.6.2;

import "./IAerodomeV2Router01.sol";

interface IAerodomeV2Router02 is IAerodomeV2Router01 {
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external;
}
