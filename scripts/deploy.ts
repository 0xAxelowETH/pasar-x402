// Deploys Pasar USD (pUSD) to the configured network and funds the agent wallet.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { formatEther, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { walletFor } from "../src/chain.js";
import { config, deploymentPath, explorerAddress, explorerTx, requireKey } from "../src/config.js";
import { PasarUSDAbi, PasarUSDBytecode } from "../src/generated/contracts.js";

const wallet = walletFor(requireKey(config.keys.facilitator, "FACILITATOR_PRIVATE_KEY"));
const deployer = wallet.account.address;

const balance = await wallet.getBalance({ address: deployer });
console.log(`Network:  ${config.network.label} (${config.caip2})`);
console.log(`Deployer: ${deployer} (${formatEther(balance)} BNB)`);
if (balance === 0n) {
  console.error(`\nThe deployer has no gas. Get free test BNB at https://www.bnbchain.org/en/testnet-faucet for ${deployer}`);
  process.exit(1);
}

const hash = await wallet.deployContract({ abi: PasarUSDAbi, bytecode: PasarUSDBytecode, args: [deployer] });
const receipt = await wallet.waitForTransactionReceipt({ hash });
if (!receipt.contractAddress) throw new Error(`Deployment failed: ${explorerTx(hash)}`);
const token = receipt.contractAddress;
console.log(`Pasar USD deployed at ${explorerAddress(token)}`);

if (config.keys.agent) {
  const agent = privateKeyToAccount(config.keys.agent).address;
  const mintHash = await wallet.writeContract({
    address: token,
    abi: PasarUSDAbi,
    functionName: "mint",
    args: [agent, parseUnits("1000", 6)],
  });
  await wallet.waitForTransactionReceipt({ hash: mintHash });
  console.log(`Minted 1,000 pUSD to the agent ${agent}`);
}

const path = deploymentPath();
mkdirSync(dirname(path), { recursive: true });
writeFileSync(
  path,
  JSON.stringify({ token, chainId: config.network.chain.id, deployedAt: new Date().toISOString(), tx: hash }, null, 2),
);
console.log(`Saved ${path}`);
