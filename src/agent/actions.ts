// What the shopping agent can buy. Shared by the CLI, the Telegram bot and the MCP bridge.
import { isAddress } from "viem";
import { config } from "../config.js";
import { formatPusd } from "../x402.js";
import type { Agent } from "./wallet.js";

export type Receipt = { transaction: string; amount: string } | undefined;
export type Purchase<T> = { data: T; receipt: Receipt };

async function readJson(response: Response) {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: text.slice(0, 200) };
  }
}

async function buyJson<T>(agent: Agent, url: string, init?: RequestInit): Promise<Purchase<T>> {
  let result;
  try {
    result = await agent.buy(url, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = /maxAmountPerPayment|above the per-payment cap/.test(message)
      ? `price is above the per-payment cap (AGENT_MAX_PER_PAYMENT_USD=${config.agent.maxPerPaymentUsd})`
      : message;
    throw new Error(`Payment refused: ${reason}`);
  }
  const body = await readJson(result.response);
  if (!result.response.ok) {
    const reason = body.error ?? `HTTP ${result.response.status}`;
    const hint = body.hint ? ` (${body.hint})` : "";
    throw new Error(`${reason}${hint} — you were not charged.`);
  }
  return { data: body as T, receipt: result.receipt };
}

export function describeReceipt(receipt: Receipt) {
  if (!receipt) return "Free (no payment).";
  const tx = config.network.explorer ? `${config.network.explorer}/tx/${receipt.transaction}` : receipt.transaction;
  return `Paid ${formatPusd(receipt.amount)} · tx ${tx}`;
}

export async function catalog() {
  const response = await fetch(`${config.urls.server}/api/catalog`);
  return (await response.json()) as {
    stalls: { name: string; price: string; endpoint: string }[];
    content: { id: string; title: string; price: string; excerpt: string }[];
  };
}

export type TokenReport = {
  token: { name: string | null; symbol: string | null } | null;
  risk: { score: number; level: string; flags: { severity: string; message: string }[] };
  simulation: { buyTaxPct?: number | null; sellTaxPct?: number | null; ran?: boolean } | null;
  liquidity: { totalUsd: number } | null;
};

export function checkTokenPaid(agent: Agent, address: string) {
  return buyJson<TokenReport>(agent, `${config.urls.server}/api/token-check/${address}`);
}

export function askAi(agent: Agent, prompt: string) {
  return buyJson<{ model: string; response: string }>(agent, `${config.urls.server}/api/ai/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
}

export function readContent(agent: Agent, id: string) {
  return buyJson<{ id: string; title: string; body: string }>(agent, `${config.urls.server}/api/content/${encodeURIComponent(id)}`);
}

export function viaGateway(agent: Agent, path: string) {
  return buyJson<Record<string, unknown>>(agent, `${config.urls.gateway}${path.startsWith("/") ? path : `/${path}`}`);
}

export async function checkTokenViaMcp(agent: Agent, address: string) {
  const session = await agent.mcp();
  try {
    const result = await session.callTool("token_check", { address });
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    if (result.isError) throw new Error(`${text} — you were not charged.`);
    return { data: JSON.parse(text) as TokenReport, receipt: result.receipt };
  } finally {
    await session.close();
  }
}

const ICON: Record<string, string> = { info: "ℹ️", warn: "⚠️", danger: "⛔" };

export function formatReport(report: TokenReport) {
  const name = report.token ? `${report.token.name ?? "?"} (${report.token.symbol ?? "?"})` : "Not a token";
  const lines = [name, `Risk: ${report.risk.level.toUpperCase()} (${report.risk.score}/100)`];
  if (report.liquidity) lines.push(`Liquidity: ~$${report.liquidity.totalUsd.toLocaleString("en-US")}`);
  if (report.simulation?.ran) {
    lines.push(`Buy/sell tax: ${report.simulation.buyTaxPct ?? "-"}% / ${report.simulation.sellTaxPct ?? "-"}%`);
  }
  for (const flag of report.risk.flags) lines.push(`${ICON[flag.severity] ?? "•"} ${flag.message}`);
  return lines.join("\n");
}

/** Tiny intent router so the agent understands plain requests. */
export async function handle(agent: Agent, input: string): Promise<string> {
  const text = input.trim();
  const address = text.match(/0x[a-fA-F0-9]{40}/)?.[0];
  const [command, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (command.toLowerCase()) {
    case "balance": {
      const b = await agent.balances();
      return `Agent wallet ${agent.address}\n${b.pusd} pUSD · ${b.bnb} BNB (the agent never spends gas)`;
    }
    case "budget": {
      const b = agent.budget();
      return `Daily budget ${b.dailyBudget} pUSD · spent ${b.spentToday} · left ${b.remainingToday}\nMax per payment ${b.maxPerPayment} pUSD`;
    }
    case "history": {
      const items = agent.history().slice(-10);
      if (!items.length) return "No purchases yet.";
      return items.map((p) => `${p.at.slice(0, 19)} ${formatPusd(p.amount)} ${p.url}`).join("\n");
    }
    case "catalog": {
      const c = await catalog();
      return [
        "Stalls:",
        ...c.stalls.map((s) => `• ${s.name} — ${s.price}`),
        "",
        "Content (read <id>):",
        ...c.content.map((i) => `• ${i.id} — ${i.title} (${i.price})`),
      ].join("\n");
    }
    case "read": {
      if (!arg) return "Usage: read <id>. Type 'catalog' to see the list.";
      const { data, receipt } = await readContent(agent, arg);
      return `${data.title}\n\n${data.body}\n\n${describeReceipt(receipt)}`;
    }
    case "gateway": {
      const { data, receipt } = await viaGateway(agent, arg || "/bsc/gas");
      return `${JSON.stringify(data, null, 2)}\n\n${describeReceipt(receipt)}`;
    }
    case "mcp": {
      if (!address || !isAddress(address)) return "Usage: mcp 0xTokenAddress";
      const { data, receipt } = await checkTokenViaMcp(agent, address);
      return `${formatReport(data)}\n\n(via MCP) ${describeReceipt(receipt)}`;
    }
    case "ask": {
      if (!arg) return "Usage: ask <question>";
      const { data, receipt } = await askAi(agent, arg);
      return `${data.response}\n\n${describeReceipt(receipt)}`;
    }
  }

  if (address) {
    const { data, receipt } = await checkTokenPaid(agent, address);
    return `${formatReport(data)}\n\n${describeReceipt(receipt)}`;
  }

  // Anything else is a question for the paid AI stall.
  const { data, receipt } = await askAi(agent, text);
  return `${data.response}\n\n${describeReceipt(receipt)}`;
}

export const HELP = `Pasar x402 shopping agent:
  0xTokenAddress     BSC token risk check (paid per check)
  mcp 0xAddress      token check through the paid MCP server
  ask <text>         ask the local AI (paid per answer)
  catalog            list stalls and content
  read <id>          buy and read one content item
  gateway [/path]    buy data through the x402 Gateway (default /bsc/gas)
  balance | budget | history`;
