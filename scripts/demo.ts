// Walks the shopping agent through every stall and shows what each payment cost. Needs "npm run dev".
import { erc20Abi, formatUnits } from "viem";
import { paymentClient } from "../src/chain.js";
import { config } from "../src/config.js";
import { requirePayTo, requireToken } from "../src/x402.js";
import {
  askAi,
  checkTokenPaid,
  checkTokenViaMcp,
  describeReceipt,
  formatReport,
  readContent,
  viaGateway,
} from "../src/agent/actions.js";
import { createAgent } from "../src/agent/wallet.js";

const CAKE = "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82";
const token = requireToken();
const seller = requirePayTo();
const agent = createAgent();

const balanceOf = async (address: `0x${string}`) =>
  formatUnits(
    await paymentClient.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    token.decimals,
  );

function step(title: string) {
  console.log(`\n\x1b[1m▸ ${title}\x1b[0m`);
}

async function attempt(title: string, work: () => Promise<string>) {
  step(title);
  try {
    console.log(await work());
  } catch (error) {
    console.log(`  ${error instanceof Error ? error.message : error}`);
  }
}

const before = { agent: await balanceOf(agent.address), seller: await balanceOf(seller) };
console.log(`Pasar x402 demo on ${config.network.label}`);
console.log(`Agent ${agent.address}: ${before.agent} pUSD | Seller ${seller}: ${before.seller} pUSD`);

step("1. Request without paying → HTTP 402");
const unpaid = await fetch(`${config.urls.server}/api/token-check/${CAKE}`);
const required = JSON.parse(Buffer.from(unpaid.headers.get("PAYMENT-REQUIRED") ?? "", "base64").toString("utf8"));
const offer = required.accepts[0];
console.log(`  ${unpaid.status} Payment Required: ${formatUnits(BigInt(offer.amount), token.decimals)} pUSD on ${offer.network} to ${offer.payTo}`);

await attempt("2. Token Check (HTTP, live BSC mainnet data)", async () => {
  const { data, receipt } = await checkTokenPaid(agent, CAKE);
  return `${formatReport(data)}\n${describeReceipt(receipt)}`;
});

await attempt("3. Pay-per-item content", async () => {
  const { data, receipt } = await readContent(agent, "bsc-token-checklist");
  return `  ${data.title} (${data.body.length} chars)\n${describeReceipt(receipt)}`;
});

await attempt("4. Laptop AI (Ollama)", async () => {
  const { data, receipt } = await askAi(agent, "Explain x402 in one sentence.");
  return `  ${data.response}\n${describeReceipt(receipt)}`;
});

await attempt("5. Paid MCP (token_check tool)", async () => {
  const { data, receipt } = await checkTokenViaMcp(agent, CAKE);
  return `  ${data.token?.symbol}: risk ${data.risk.level} (${data.risk.score}/100)\n${describeReceipt(receipt)}`;
});

await attempt("6. x402 Gateway (reverse proxy)", async () => {
  const { data, receipt } = await viaGateway(agent, "/bsc/gas");
  return `  ${JSON.stringify(data)}\n${describeReceipt(receipt)}`;
});

const after = { agent: await balanceOf(agent.address), seller: await balanceOf(seller) };
step("Result");
console.log(`  Agent spent   ${(Number(before.agent) - Number(after.agent)).toFixed(6)} pUSD (now ${after.agent})`);
console.log(`  Seller earned ${(Number(after.seller) - Number(before.seller)).toFixed(6)} pUSD (now ${after.seller})`);
console.log(`  Budget today  ${JSON.stringify(agent.budget())}`);
