import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { getAddress, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet, hardhat } from "viem/chains";

export const ROOT = resolve(import.meta.dirname, "..");

// Load the project's .env even when started from another directory (e.g. by an MCP client).
// quiet: stdout carries the MCP protocol in the stdio bridge, so dotenv must not log there.
loadEnv({ path: resolve(ROOT, ".env"), quiet: true });

export type NetworkName = "local" | "bsc-testnet";

type NetworkProfile = {
  name: NetworkName;
  label: string;
  chain: Chain;
  rpcUrls: string[];
  explorer?: string;
};

const PROFILES: Record<NetworkName, NetworkProfile> = {
  local: {
    name: "local",
    label: "Local Hardhat chain",
    chain: hardhat,
    rpcUrls: ["http://127.0.0.1:8545"],
  },
  "bsc-testnet": {
    name: "bsc-testnet",
    label: "BNB Smart Chain Testnet",
    chain: bscTestnet,
    rpcUrls: [
      "https://bsc-testnet-rpc.publicnode.com",
      "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
      "https://data-seed-prebsc-2-s1.bnbchain.org:8545",
    ],
    explorer: "https://testnet.bscscan.com",
  },
};

// Well-known Hardhat dev accounts #0-#2. Public keys, ONLY valid for the local chain.
const LOCAL_KEYS = {
  facilitator: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  seller: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  agent: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
} as const satisfies Record<string, Hex>;

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function list(name: string): string[] | undefined {
  return env(name)
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const networkName = (env("NETWORK") ?? "local") as NetworkName;
if (!(networkName in PROFILES)) {
  throw new Error(`NETWORK must be one of: ${Object.keys(PROFILES).join(", ")} (got "${networkName}")`);
}
const profile = PROFILES[networkName];
const isLocal = networkName === "local";

function key(name: string, localFallback: Hex): Hex | undefined {
  const value = env(name) as Hex | undefined;
  if (value) return value;
  return isLocal ? localFallback : undefined;
}

export function requireKey(value: Hex | undefined, envName: string): Hex {
  if (!value) {
    throw new Error(`${envName} is not set. Run "npm run setup" to create a .env for ${networkName}.`);
  }
  return value;
}

type Deployment = { token: Address; deployedAt: string; chainId: number };

export function deploymentPath(network: NetworkName = networkName) {
  return resolve(ROOT, "deployments", `${network}.json`);
}

function readDeployment(): Deployment | undefined {
  const path = deploymentPath();
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as Deployment;
}

const facilitatorKey = key("FACILITATOR_PRIVATE_KEY", LOCAL_KEYS.facilitator);
const agentKey = key("AGENT_PRIVATE_KEY", LOCAL_KEYS.agent);
const payToEnv = env("PAY_TO_ADDRESS");

export const config = {
  network: profile,
  isLocal,
  caip2: `eip155:${profile.chain.id}` as const,
  rpcUrls: list("PAYMENT_RPC_URLS") ?? profile.rpcUrls,

  keys: {
    facilitator: facilitatorKey,
    agent: agentKey,
  },
  payTo: payToEnv
    ? getAddress(payToEnv)
    : isLocal
      ? privateKeyToAccount(LOCAL_KEYS.seller).address
      : undefined,

  /** Payment token: deployment file first, PAYMENT_TOKEN_ADDRESS overrides. */
  get token() {
    const address = env("PAYMENT_TOKEN_ADDRESS") ?? readDeployment()?.token;
    return {
      address: address ? getAddress(address) : undefined,
      name: "Pasar USD",
      version: "1",
      symbol: "pUSD",
      decimals: 6,
    };
  },

  ports: {
    facilitator: Number(env("FACILITATOR_PORT") ?? 4020),
    server: Number(env("SERVER_PORT") ?? 4021),
    gateway: Number(env("GATEWAY_PORT") ?? 4022),
  },
  urls: {
    facilitator: env("FACILITATOR_URL") ?? `http://127.0.0.1:${Number(env("FACILITATOR_PORT") ?? 4020)}`,
    server: env("SERVER_URL") ?? `http://127.0.0.1:${Number(env("SERVER_PORT") ?? 4021)}`,
    gateway: env("GATEWAY_URL") ?? `http://127.0.0.1:${Number(env("GATEWAY_PORT") ?? 4022)}`,
  },
  /** Shared secret between resource servers and the facilitator (optional on local). */
  facilitatorApiKey: env("FACILITATOR_API_KEY"),

  /** Token checks always read BNB Smart Chain mainnet (read-only, free). */
  bscMainnetRpcUrls: list("BSC_MAINNET_RPC_URLS") ?? [
    "https://bsc-rpc.publicnode.com",
    "https://bsc-dataseed.bnbchain.org",
    "https://bsc.drpc.org",
  ],

  ollama: {
    url: env("OLLAMA_URL") ?? "http://127.0.0.1:11434",
    model: env("OLLAMA_MODEL") ?? "qwen2.5:1.5b",
  },

  prices: {
    tokenCheck: env("PRICE_TOKEN_CHECK") ?? "$0.01",
    aiGenerate: env("PRICE_AI_GENERATE") ?? "$0.02",
    mcpTokenCheck: env("PRICE_MCP_TOKEN_CHECK") ?? "$0.01",
    mcpAi: env("PRICE_MCP_AI") ?? "$0.02",
  },

  agent: {
    dailyBudgetUsd: Number(env("AGENT_DAILY_BUDGET_USD") ?? 1),
    maxPerPaymentUsd: Number(env("AGENT_MAX_PER_PAYMENT_USD") ?? 0.1),
    allowedHosts: list("AGENT_ALLOWED_HOSTS") ?? ["127.0.0.1", "localhost"],
  },

  telegramToken: env("TELEGRAM_BOT_TOKEN"),
};

export function explorerTx(hash: string) {
  return config.network.explorer ? `${config.network.explorer}/tx/${hash}` : hash;
}

export function explorerAddress(address: string) {
  return config.network.explorer ? `${config.network.explorer}/address/${address}` : address;
}
