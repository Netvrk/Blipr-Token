// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUniswapV2Router02 {
    address public immutable WETH;
    address public immutable factory;
    
    constructor() {
        WETH = address(new MockWETH());
        factory = address(new MockUniswapV2Factory());
    }
    
    function addLiquidityETH(
        address token,
        uint amountTokenDesired,
        uint amountTokenMin,
        uint amountETHMin,
        address to,
        uint deadline
    ) external payable returns (uint amountToken, uint amountETH, uint liquidity) {
        // Transfer tokens from sender to this contract
        IERC20(token).transferFrom(msg.sender, address(this), amountTokenDesired);
        
        // Return mock values
        return (amountTokenDesired, msg.value, amountTokenDesired);
    }
    
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external {
        // Transfer tokens from sender
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        
        // Send ETH to recipient
        if (address(this).balance >= amountOutMin) {
            payable(to).transfer(amountOutMin);
        }
    }
    
    function getAmountsOut(uint amountIn, address[] calldata path) 
        external pure returns (uint[] memory amounts) {
        amounts = new uint[](path.length);
        amounts[0] = amountIn;
        amounts[1] = amountIn / 100; // Mock exchange rate
    }
    
    receive() external payable {}
}

contract MockUniswapV2Factory {
    mapping(address => mapping(address => address)) public pairs;
    
    function createPair(address tokenA, address tokenB) external returns (address pair) {
        pair = address(new MockUniswapV2Pair());
        pairs[tokenA][tokenB] = pair;
        pairs[tokenB][tokenA] = pair;
        return pair;
    }
}

contract MockUniswapV2Pair is ERC20 {
    constructor() ERC20("LP Token", "LP") {}
    
    function getReserves() external pure returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast) {
        return (1000000, 1000000, 0);
    }
}

contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped ETH", "WETH") {}
    
    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }
    
    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        payable(msg.sender).transfer(amount);
    }
}