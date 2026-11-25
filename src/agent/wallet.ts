// Stall 3 — the shopping agent's wallet: x402 payments with a daily budget, a per-payment cap,
// a host allowlist and a local spending ledger.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { x402Client } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { createx402MCPClient } from "@x402/mcp";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { erc20Abi, formatEther, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { paymentClient } from "../chain.js";
import { config, explorerTx, requireKey, ROOT } from "../config.js";
import { requireToken, usdToAtomic } from "../x402.js";

export type Purchase = { at: string; url: string; amount: string; transaction: string; network: string };

const LEDGER_PATH = resolve(ROOT, ".data", `agent-ledger-${config.network.name}.json`);

function readLedger(): Purchase[] {
  if (!existsSync(LEDGER_PATH)) return [];
  return JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as Purchase[];
}

function appendLedger(purchase: Purchase) {
  const ledger = readLedger();
  ledger.push(purchase);
  mkdirSync(dirname(LEDGER_PATH), { recursive: true });
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

function spentToday(): bigint {
  const today = new Date().toISOString().slice(0, 10);
  return readLedger()
    .filter((p) => p.at.startsWith(today))
    .reduce((sum, p) => sum + BigInt(p.amount), 0n);
}

function hostOf(url: string | undefined) {
  try {
    return url ? new URL(url).hostname : undefined;
  } catch {
    return undefined;
  }
}

export class BudgetError extends Error {}

export function createAgent() {
  const account = privateKeyToAccount(requireKey(config.keys.agent, "AGENT_PRIVATE_KEY"));
  const token = requireToken();
  const dailyBudget = usdToAtomic(config.agent.dailyBudgetUsd);
  const maxPerPayment = usdToAtomic(config.agent.maxPerPaymentUsd);

  /** Shared guard for HTTP and MCP purchases. Throws BudgetError to refuse a payment. */
  function approve(paymentRequired: PaymentRequired, amount: string, url: string | undefined) {
    const host = hostOf(url ?? paymentRequired.resource?.url);
    if (host && !host.startsWith("mcp") && !config.agent.allowedHosts.includes(host)) {
      throw new BudgetError(`host ${host} is not in AGENT_ALLOWED_HOSTS`);
    }
    const value = BigInt(amount);
    if (value > maxPerPayment) {
      throw new BudgetError(`price ${formatUnits(value, token.decimals)} pUSD is above the per-payment cap`);
    }
    if (spentToday() + value > dailyBudget) {
      throw new BudgetError(`daily budget of ${config.agent.dailyBudgetUsd} pUSD would be exceeded`);
    }
  }

  const spendControls = {
    allowedAssets: [{ network: config.caip2, asset: token.address, maxAmountPerPayment: maxPerPayment.toString() }],
  };
  const scheme = new ExactEvmScheme(account);

  // "exact" settlements do not echo the amount, so remember what was authorized.
  // The agent buys one thing at a time, which keeps this single slot unambiguous.
  let lastAuthorized: string | undefined;

  const client = x402Client.fromConfig({ schemes: [{ network: config.caip2, client: scheme }], spendControls });
  client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements }) => {
    try {
      approve(paymentRequired, selectedRequirements.amount, paymentRequired.resource?.url);
    } catch (error) {
      return { abort: true, reason: (error as Error).message };
    }
  });
  client.onAfterPaymentCreation(async ({ selectedRequirements }) => {
    lastAuthorized = selectedRequirements.amount;
  });

  const payingFetch = wrapFetchWithPayment(fetch, client);

  /** fetch() that pays x402 stalls automatically and records every settled payment. */
  async function buy(url: string, init?: RequestInit) {
    lastAuthorized = undefined;
    const response = await payingFetch(url, init);
    const header = response.headers.get("PAYMENT-RESPONSE");
    let receipt: { transaction: string; amount: string } | undefined;
    if (header) {
      const settle = decodePaymentResponseHeader(header);
      if (settle.success) {
        const amount = settle.amount ?? lastAuthorized ?? "0";
        appendLedger({ at: new Date().toISOString(), url, amount, transaction: settle.transaction, network: settle.network });
        receipt = { transaction: settle.transaction, amount };
      }
    }
    return { response, receipt };
  }

  async function mcp(url = `${config.urls.server}/mcp`) {
    const mcpClient = createx402MCPClient({
      name: "pasar-agent",
      version: "0.1.0",
      schemes: [{ network: config.caip2, client: scheme }],
      spendControls,
      autoPayment: true,
      onPaymentRequested: async ({ paymentRequired }) => {
        const amount = paymentRequired.accepts[0]?.amount ?? "0";
        try {
          approve(paymentRequired, amount, url);
          lastAuthorized = amount;
          return true;
        } catch (error) {
          console.warn(`[agent] refused MCP payment: ${(error as Error).message}`);
          return false;
        }
      },
    });
    await mcpClient.connect(new StreamableHTTPClientTransport(new URL(url)));

    async function callTool(name: string, args: Record<string, unknown> = {}) {
      lastAuthorized = undefined;
      const result = await mcpClient.callTool(name, args);
      let receipt: { transaction: string; amount: string } | undefined;
      if (result.paymentMade && result.paymentResponse?.success) {
        const amount = result.paymentResponse.amount ?? lastAuthorized ?? "0";
        appendLedger({
          at: new Date().toISOString(),
          url: `mcp://${name}`,
          amount,
          transaction: result.paymentResponse.transaction,
          network: result.paymentResponse.network,
        });
        receipt = { transaction: result.paymentResponse.transaction, amount };
      }
      return { ...result, receipt };
    }
    return { callTool, close: () => mcpClient.close() };
  }

  async function balances() {
    const [pusd, bnb] = await Promise.all([
      paymentClient.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
      paymentClient.getBalance({ address: account.address }),
    ]);
    return { pusd: formatUnits(pusd, token.decimals), bnb: formatEther(bnb) };
  }

  function budget() {
    const spent = spentToday();
    return {
      dailyBudget: config.agent.dailyBudgetUsd,
      maxPerPayment: config.agent.maxPerPaymentUsd,
      spentToday: Number(formatUnits(spent, token.decimals)),
      remainingToday: Number(formatUnits(dailyBudget > spent ? dailyBudget - spent : 0n, token.decimals)),
      allowedHosts: config.agent.allowedHosts,
    };
  }

  return { address: account.address, buy, mcp, balances, budget, history: readLedger, explorerTx };
}

export type Agent = ReturnType<typeof createAgent>;
