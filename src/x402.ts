import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { formatUnits, parseUnits, type Address } from "viem";
import { config } from "./config.js";

export function requireToken() {
  const token = config.token;
  if (!token.address) {
    throw new Error(
      `Payment token is not deployed on ${config.network.name}. Run "npm run deploy" (or set PAYMENT_TOKEN_ADDRESS).`,
    );
  }
  return { ...token, address: token.address };
}

export function requirePayTo(): Address {
  if (!config.payTo) {
    throw new Error('PAY_TO_ADDRESS is not set. Run "npm run setup".');
  }
  return config.payTo;
}

export function createFacilitatorClient() {
  const apiKey = config.facilitatorApiKey;
  return new HTTPFacilitatorClient({
    url: config.urls.facilitator,
    createAuthHeaders: apiKey
      ? async () => {
          const headers = { Authorization: `Bearer ${apiKey}` };
          return { verify: headers, settle: headers, supported: headers };
        }
      : undefined,
  });
}

/**
 * Resource server that prices "$0.01"-style amounts in Pasar USD.
 * x402 only knows default stablecoins for some chains; BSC testnet is not one of
 * them, so the money parser maps dollar prices onto our EIP-3009 test token.
 */
export function createResourceServer() {
  const token = requireToken();
  const scheme = new ExactEvmScheme().registerMoneyParser(async (amount, network) => {
    if (network !== config.caip2) return null;
    return {
      amount: parseUnits(String(amount), token.decimals).toString(),
      asset: token.address,
      extra: { name: token.name, version: token.version },
    };
  });
  return new x402ResourceServer(createFacilitatorClient()).register(config.caip2, scheme);
}

/** Single "exact" payment option on the configured network, paid to the seller. */
export function exactPayment(price: string) {
  return {
    scheme: "exact",
    network: config.caip2,
    payTo: requirePayTo(),
    price,
    maxTimeoutSeconds: 120,
  } as const;
}

export function formatPusd(atomic: bigint | string) {
  return `${formatUnits(BigInt(atomic), config.token.decimals)} pUSD`;
}

export function usdToAtomic(usd: number) {
  return parseUnits(usd.toFixed(config.token.decimals), config.token.decimals);
}
