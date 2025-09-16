# Silk AI Token Contract

### Testing the contract deployments

- Wrapcast Deployed to 0xaE9A1816846697a57E9955860c758338a022C6B6
- SillyCat Deployed to 0x80AC1528732458AB3AdF64BB9a0F6628049EA6da
- CatAI Deployed to 0xdA76001020138b78938185393AAFd9a68d6656C7
- Cipher Deployed to 0x454b08ee179039462F6A377e6B1C434673EBFb12
- Cipher Deployed to 0xC34dbb7735d574ABf98f38fB0F20134092e89df0
- Center Fruit deployed to 0x6251fD098A719c6b69b3DFdC95bfA9f0FA2F4A05
- Kala deployed to 0x881881aD498AFE7700d8C005d12A156c0680d993
- Kala AI deployed to 0x8cF3C2E38B17Cd90D9b6F6127803BC3f4c878550

### Token Price Calculations

```txt
- Token Total supply: 100,000,000
- Added Liquidity:
  Token: 100,000
  WETH: 0.01
- WETH in USD: 3445;
- Price = 0.0003442

Calculate the Price of One Token
Value of WETH in USD = Amount of WETH * Price of WETH
Value of WETH in USD = 0.01 WETH * $3445/WETH = $34.45

Price of One Token = Value of WETH in USD / Tokens Added to Liquidity
Price of One Token = $34.45 / 100,000 tokens = $0.0003445 per token
```

### Deploying BonkAI Contract

#### Prerequisites
- Node.js and npm installed
- Hardhat configured in the project
- Private key for deployment wallet
- ETH/Base native token for gas fees
- RPC endpoints for target network

#### Network Configuration

1. **Configure environment variables** (create `.env` file):
```bash
# Deployment wallet private key
PRIVATE_KEY=your_private_key_here

# RPC Endpoints
ETHEREUM_RPC_URL=https://mainnet.infura.io/v3/your_infura_key
BASE_RPC_URL=https://base.gateway.tenderly.co

# Etherscan/Basescan API keys for verification
ETHERSCAN_API_KEY=your_etherscan_api_key
BASESCAN_API_KEY=your_basescan_api_key
```

2. **Update hardhat.config.ts** with network configurations:
```typescript
networks: {
  ethereum: {
    url: process.env.ETHEREUM_RPC_URL,
    accounts: [process.env.PRIVATE_KEY],
    chainId: 1
  },
  base: {
    url: process.env.BASE_RPC_URL,
    accounts: [process.env.PRIVATE_KEY],
    chainId: 8453
  }
}
```

#### Deployment Steps

1. **Compile the contracts**:
```bash
npx hardhat compile
```

2. **Deploy to Base network**:
```bash
npx hardhat run scripts/deploy-bonkai.ts --network base
```

3. **Deploy to Ethereum mainnet**:
```bash
npx hardhat run scripts/deploy-bonkai.ts --network ethereum
```

4. **Verify the contract** (after deployment):
```bash
# For Base
npx hardhat verify --network base <PROXY_ADDRESS>

# For Ethereum
npx hardhat verify --network ethereum <PROXY_ADDRESS>
```

#### Important Deployment Parameters

The BonkAI contract requires the following parameters during initialization:
- **Router Address**: Uniswap V2 Router
  - Ethereum: `0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D`
  - Base: `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24`
- **Treasury Address**: Wallet to receive LP tokens
- **Manager Address**: Wallet with manager role
- **Initial Supply**: Total token supply (100,000,000 * 10^18)

#### Post-Deployment Configuration

1. **Set tax rates** (if needed):
```bash
# Configure buy/sell/transfer taxes via manager role
```

2. **Configure limits**:
```bash
# Set transaction and wallet limits for anti-bot protection
```

3. **Add liquidity**:
```bash
# Approve tokens and add initial liquidity to DEX
```

#### Gas Considerations
- Deployment gas: ~3-4M gas units
- Use current gas prices:
  - Ethereum: Check https://etherscan.io/gastracker
  - Base: Check https://basescan.org/gastracker

#### Security Notes
- Always deploy to testnet first (Sepolia for Ethereum, Base Sepolia for Base)
- Audit the contract before mainnet deployment
- Use a hardware wallet or secure key management for production
- Implement multi-sig for admin/manager roles
- Test all functions thoroughly before adding liquidity
