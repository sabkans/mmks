const { ethers } = require('ethers');
const readline = require('readline');
require('dotenv').config();

// Configuration
const PRIVATE_KEYS = process.env.PRIVATE_KEYS ? 
                     process.env.PRIVATE_KEYS.split(',').map(key => key.trim()) : 
                     [];
const RPC_URL = 'https://rpc.soniclabs.com';
const VAULT_ADDRESS = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000; // 5 seconds

// Token configuration
const TOKENS = {
  WS: {
    address: '0x039e2fb66102314ce7b64ce5ce3e5183bc94ad38',
    decimals: 18
  },
  INTERMEDIATE1: {
    address: '0xd3dce716f3ef535c5ff8d041c1a41c3bd89b97ae',
    decimals: 18
  },
  INTERMEDIATE2: {
    address: '0x3419966bc74fa8f951108d15b053bed233974d3d',
    decimals: 18
  },
  STAKED_SONIC: {
    address: '0xe5da20f15420ad15de0fa650600afc998bbe3955',
    decimals: 18
  }
};

// Pool IDs
const POOL_IDS = [
  '0x203180225ebd6dbf1dc0ad41b1fe7deaf51031bf000200000000000000000078',
  '0x429685017af12b0c24e982ad66f71031f02bd4af0002000000000000000000ca',
  '0xf633a43e5ccf858a27dd1d74a23be15ea5aa28f30002000000000000000000c2'
];

// ABIs
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

const VAULT_ABI = [
  {
    "inputs": [
      {"name":"kind","type":"uint8"},
      {"name":"swaps","type":"tuple[]","components":[
        {"name":"poolId","type":"bytes32"},
        {"name":"assetInIndex","type":"uint256"},
        {"name":"assetOutIndex","type":"uint256"},
        {"name":"amount","type":"uint256"},
        {"name":"userData","type":"bytes"}
      ]},
      {"name":"assets","type":"address[]"},
      {"name":"funds","type":"tuple","components":[
        {"name":"sender","type":"address"},
        {"name":"fromInternalBalance","type":"bool"},
        {"name":"recipient","type":"address"},
        {"name":"toInternalBalance","type":"bool"}
      ]},
      {"name":"limits","type":"int256[]"},
      {"name":"deadline","type":"uint256"}
    ],
    "name":"batchSwap",
    "outputs":[{"name":"assetDeltas","type":"int256[]"}],
    "stateMutability":"payable",
    "type":"function"
  }
];

// Helper functions
async function getTokenDecimals(tokenAddress, provider) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  try {
    return await token.decimals();
  } catch {
    return TOKENS[Object.keys(TOKENS).find(key => TOKENS[key].address === tokenAddress)]?.decimals || 18;
  }
}

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans);
  }));
}

async function withRetry(fn, retries = MAX_RETRIES, delay = RETRY_DELAY) {
  try {
    return await fn();
  } catch (error) {
    if (retries > 0) {
      console.log(`Retrying... (${retries} attempts left)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return await withRetry(fn, retries - 1, delay);
    }
    throw error;
  }
}

async function performSwap(wallet, vault, wsToken, stakedSonic, wsDecimals, stakedSonicDecimals, swapAmount, swapCount) {
  const amountInWei = ethers.utils.parseUnits(swapAmount.toString(), wsDecimals);
  
  console.log(`\n[${wallet.address}] Starting swap of ${swapAmount} wS via ${swapCount} hop(s)`);

  // 1. Check balance
  const balance = await wsToken.balanceOf(wallet.address);
  if (balance.lt(amountInWei)) {
    throw new Error(`Insufficient balance. Needed: ${swapAmount}, Has: ${ethers.utils.formatUnits(balance, wsDecimals)}`);
  }

  // 2. Check and set allowance
  const allowance = await wsToken.allowance(wallet.address, VAULT_ADDRESS);
  if (allowance.lt(amountInWei)) {
    console.log(`[${wallet.address}] Approving ${swapAmount} wS...`);
    const approveTx = await withRetry(() => 
      wsToken.approve(VAULT_ADDRESS, amountInWei, {
        gasLimit: 200000,
        maxPriorityFeePerGas: ethers.utils.parseUnits('50', 'gwei'),
        maxFeePerGas: ethers.utils.parseUnits('100', 'gwei')
      })
    );
    await approveTx.wait();
    console.log(`[${wallet.address}] Approval confirmed: ${approveTx.hash}`);
  }

  // 3. Prepare swap
  const assets = Object.values(TOKENS).map(t => t.address);
  const swaps = POOL_IDS.slice(0, swapCount).map((poolId, i) => ({
    poolId,
    assetInIndex: i,
    assetOutIndex: i + 1,
    amount: i === 0 ? amountInWei.toString() : '0',
    userData: '0x'
  }));

  const funds = {
    sender: wallet.address,
    fromInternalBalance: false,
    recipient: wallet.address, // Changed to send back to the sender's wallet
    toInternalBalance: false
  };

  const limits = assets.map((_, i) => i === 0 ? amountInWei.toString() : '0');
  const deadline = Math.floor(Date.now() / 1000) + 1800; // 30 minutes

  // 4. Execute swap
  console.log(`[${wallet.address}] Executing swap...`);
  const swapTx = await withRetry(() =>
    vault.batchSwap(
      0, // GIVEN_IN
      swaps,
      assets,
      funds,
      limits,
      deadline,
      {
        gasLimit: 3000000,
        maxPriorityFeePerGas: ethers.utils.parseUnits('50', 'gwei'),
        maxFeePerGas: ethers.utils.parseUnits('100', 'gwei')
      }
    )
  );

  console.log(`[${wallet.address}] Tx submitted: ${swapTx.hash}`);
  const receipt = await swapTx.wait();

  if (receipt.status === 0) {
    throw new Error('Transaction failed');
  }

  console.log(`[${wallet.address}] Swap successful in block ${receipt.blockNumber}`);
  return true;
}

async function processWallet(wallet, provider, totalIterations, intervalMinutes, swapAmount, swapCount) {
  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);
  const wsToken = new ethers.Contract(TOKENS.WS.address, ERC20_ABI, wallet);
  const stakedSonic = new ethers.Contract(TOKENS.STAKED_SONIC.address, ERC20_ABI, wallet);

  const [wsDecimals, stakedDecimals] = await Promise.all([
    getTokenDecimals(TOKENS.WS.address, provider),
    getTokenDecimals(TOKENS.STAKED_SONIC.address, provider)
  ]);

  for (let i = 1; i <= totalIterations; i++) {
    console.log(`\n[${wallet.address}] Iteration ${i}/${totalIterations}`);
    
    try {
      await performSwap(
        wallet, vault, wsToken, stakedSonic,
        wsDecimals, stakedDecimals,
        swapAmount, swapCount
      );
    } catch (error) {
      console.error(`[${wallet.address}] Error:`, error.message);
      if (error.transactionHash) {
        console.log(`Transaction hash: ${error.transactionHash}`);
      }
      if (error.receipt) {
        console.log(`Gas used: ${error.receipt.gasUsed.toString()}`);
      }
    }

    if (i < totalIterations) {
      console.log(`[${wallet.address}] Waiting ${intervalMinutes} minute(s)...`);
      await new Promise(resolve => setTimeout(resolve, intervalMinutes * 60 * 1000));
    }
  }
}

async function main() {
  try {
    // Validate private keys
    if (PRIVATE_KEYS.length === 0) {
      throw new Error("Please set PRIVATE_KEYS in .env file (comma separated)");
    }

    // Get user inputs
    const iterations = Math.max(parseInt(await askQuestion("Iterations per wallet? [default: 5] ") || 5), 1);
    const interval = Math.max(parseInt(await askQuestion("Interval in minutes? [default: 5] ") || 5), 1);
    const amount = Math.max(parseFloat(await askQuestion("wS Token amount per swap? [default: 0.0001] ") || 0.0001), 0);
    const hops = Math.min(Math.max(parseInt(await askQuestion("Number of swaps (1-3)? [default: 3] ") || 3), 1), 3);

    // Initialize provider and wallets
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL, {
      name: 'sonic',
      chainId: 146
    });

    const wallets = PRIVATE_KEYS
      .map(key => {
        try {
          return new ethers.Wallet(key, provider);
        } catch {
          console.warn(`Invalid private key: ${key.slice(0, 10)}...`);
          return null;
        }
      })
      .filter(wallet => wallet !== null);

    if (wallets.length === 0) {
      throw new Error("No valid wallets initialized");
    }

    console.log(`\nStarting swap process with ${wallets.length} wallets`);
    console.log(`Each wallet will perform ${iterations} swaps`);
    console.log(`Swap amount: ${amount} wS Token`);
    console.log(`Swap hops: ${hops}`);
    console.log(`Interval: ${interval} minutes\n`);

    // Process wallets sequentially
    for (const wallet of wallets) {
      await processWallet(
        wallet,
        provider,
        iterations,
        interval,
        amount,
        hops
      );
    }

    console.log("\nAll swaps completed successfully!");
  } catch (error) {
    console.error("Fatal error:", error.message);
    process.exit(1);
  }
}

main().catch(console.error);
