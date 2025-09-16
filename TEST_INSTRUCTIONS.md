# Testing BonkAI on Hardhat Network

## Setup

The hardhat config is already set up to fork Base mainnet. This allows testing with real Uniswap contracts.

## Testing Steps

### 1. Start a local fork of Base

```bash
npx hardhat node --fork https://base.gateway.tenderly.co
```

Keep this terminal open. It will show a list of test accounts with 10000 ETH each.

### 2. In a new terminal, deploy the contract

```bash
npx hardhat run scripts/bonk-ai.ts --network localhost
```

This will deploy BonkAI and output the contract address. Copy this address.

### 3. Update the launch script

Edit `scripts/launch-bonkai.ts` and update line 5 with your deployed contract address:
```typescript
const BONKAI_ADDRESS = "YOUR_DEPLOYED_CONTRACT_ADDRESS";
```

### 4. Launch the token

```bash
npx hardhat run scripts/launch-bonkai.ts --network localhost
```

## Key Points

- The deployer (first test account) receives all 1 billion tokens
- The deployer has both MANAGER_ROLE and DEFAULT_ADMIN_ROLE
- The launch function creates a Uniswap V2 pair and adds liquidity
- LP tokens go to the treasury wallet

## Mainnet Deployment

For Base mainnet:

1. Deploy:
```bash
npx hardhat run scripts/bonk-ai.ts --network base
```

2. Update launch script with the deployed address

3. Launch:
```bash
npx hardhat run scripts/launch-bonkai.ts --network base
```

## Current Issue

The launch function has an approval issue that needs fixing. The contract needs to properly approve the Uniswap router to spend its tokens. The `_approve` internal function sets the allowance correctly, but there may be an issue with how the router interacts with the upgradeable contract.