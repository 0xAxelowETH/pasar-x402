// MCP bridge (stdio): lets any MCP client — Claude Desktop, Claude Code, Cursor — shop at
// Pasar x402 with the agent wallet. The budget limits in .env apply to every call.
// Logs go to stderr because stdout carries the MCP protocol.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { askAi, catalog, checkTokenPaid, describeReceipt, formatReport, readContent } from "./actions.js";
import { createAgent } from "./wallet.js";

const agent = createAgent();
const server = new McpServer({ name: "pasar-x402-agent", version: "0.1.0" });

async function reply(work: () => Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await work() }] };
  } catch (error) {
    return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
}

server.registerTool(
  "market_catalog",
  { description: "Free. List Pasar x402 stalls, prices and content items." },
  () => reply(async () => JSON.stringify(await catalog(), null, 2)),
);

server.registerTool(
  "market_token_check",
  {
    description: "Pays ~0.01 pUSD from the agent wallet to run a BNB Smart Chain token risk check (honeypot, tax, owner powers, liquidity).",
    inputSchema: { address: z.string().describe("BEP-20 token address") },
  },
  ({ address }) =>
    reply(async () => {
      const { data, receipt } = await checkTokenPaid(agent, address);
      return `${formatReport(data)}\n\n${describeReceipt(receipt)}`;
    }),
);

server.registerTool(
  "market_ask_ai",
  { description: "Pays ~0.02 pUSD to ask the stall's local LLM.", inputSchema: { prompt: z.string() } },
  ({ prompt }) =>
    reply(async () => {
      const { data, receipt } = await askAi(agent, prompt);
      return `${data.response}\n\n${describeReceipt(receipt)}`;
    }),
);

server.registerTool(
  "market_read_content",
  { description: "Buys one content item by id (see market_catalog for prices).", inputSchema: { id: z.string() } },
  ({ id }) =>
    reply(async () => {
      const { data, receipt } = await readContent(agent, id);
      return `${data.title}\n\n${data.body}\n\n${describeReceipt(receipt)}`;
    }),
);

server.registerTool(
  "market_wallet",
  { description: "Free. Agent wallet balance, today's budget and recent purchases." },
  () =>
    reply(async () =>
      JSON.stringify({ address: agent.address, ...(await agent.balances()), budget: agent.budget(), recent: agent.history().slice(-5) }, null, 2),
    ),
);

await server.connect(new StdioServerTransport());
console.error(`[mcp-bridge] agent ${agent.address} ready on stdio`);
