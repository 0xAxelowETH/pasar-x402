import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  publicActions,
  type Hex,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { config } from "./config.js";

function transport(urls: string[]): Transport {
  return urls.length === 1 ? http(urls[0]) : fallback(urls.map((url) => http(url)));
}

/** Reads on the chain where payments settle (local or BSC testnet). */
export const paymentClient = createPublicClient({
  chain: config.network.chain,
  transport: transport(config.rpcUrls),
});

/** Read-only access to BNB Smart Chain mainnet for token checks. */
export const bscMainnetClients = config.bscMainnetRpcUrls.map((url) =>
  createPublicClient({ chain: bsc, transport: http(url, { timeout: 15_000 }) }),
);

export const bscMainnetClient = createPublicClient({
  chain: bsc,
  transport: transport(config.bscMainnetRpcUrls),
  batch: { multicall: true },
});

export function walletFor(privateKey: Hex) {
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: config.network.chain,
    transport: transport(config.rpcUrls),
  }).extend(publicActions);
}
