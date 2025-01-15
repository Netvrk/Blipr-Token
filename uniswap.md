# Pool vs. Pair

## Uniswap V2:

There’s a simple pair address for each token pair (e.g., TOKEN - WETH). Your contract can store that address and say, “If from or to is uniswapV2Pair, we apply tax logic.”

## Uniswap V3:

Each pool is also a single address, but there can be multiple pools for the same pair of tokens with different fee tiers (e.g., 0.05%, 0.3%, 1%). Each pool is an ERC20-like contract behind the scenes, but the liquidity is represented as NFT positions instead of fungible LP tokens.

Hence, you can’t rely on a single “pair” address the same way you do in V2. You might have to:

Identify the specific pool address used for your desired fee tier (e.g., 0.3%).
Mark that pool address in your token as “automated market maker pair” (or equivalent).
