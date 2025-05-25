// SPDX-License-Identifier: MIT

pragma solidity 0.8.28;

interface IAerodomeV2Factory {
    function createPool(
        address tokenA,
        address tokenB,
        bool stable
    ) external returns (address pool);
}
