// Pasar x402 main server: website, free catalog, and the paid HTTP + MCP stalls.
import { resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { paymentMiddleware, type x402ResourceServer } from "@x402/express";
import type { RoutesConfig } from "@x402/core/http";
import { formatGwei } from "viem";
import { bscMainnetClient } from "../chain.js";
import { config, ROOT } from "../config.js";
import { createResourceServer, exactPayment, requirePayTo, requireToken } from "../x402.js";
import { contentIdFromPath, contentItems, publicListing } from "./content.js";
import { generate, InferenceError } from "./inference.js";
import { mountMcp } from "./mcp.js";
import { bnbPriceUsd, checkToken, TokenCheckError } from "./token-check.js";

const token = requireToken();
const payTo = requirePayTo();

const STALLS = [
  {
    id: "token-check",
    name: "Token Check",
    method: "GET",
    endpoint: "/api/token-check/{address}",
    price: config.prices.tokenCheck,
    description: "Honeypot simulation, buy/sell tax, owner powers, proxy and PancakeSwap liquidity for any BEP-20 token.",
  },
  {
    id: "mcp",
    name: "Paid MCP",
    method: "POST",
    endpoint: "/mcp",
    price: `${config.prices.mcpTokenCheck} – ${config.prices.mcpAi} per tool call`,
    description: "Streamable-HTTP MCP server. Tools: market_info (free), token_check, ask_ai.",
  },
  {
    id: "agent",
    name: "Shopping Agent",
    method: "CLI · Telegram · MCP",
    endpoint: "npm run agent | npm run bot | npm run mcp:bridge",
    price: "budget-limited buyer",
    description: "An agent wallet with a daily budget and host allowlist that pays x402 stalls by itself.",
  },
  {
    id: "gateway",
    name: "x402 Gateway",
    method: "ANY",
    endpoint: `${config.urls.gateway}/…`,
    price: "set per route in gateway.config.json",
    description: "Reverse proxy that puts an x402 paywall in front of any existing API, configured from JSON.",
  },
  {
    id: "ai",
    name: "Laptop AI",
    method: "POST",
    endpoint: "/api/ai/generate",
    price: config.prices.aiGenerate,
    description: `Local LLM inference via Ollama (${config.ollama.model}). Not charged when the model is offline.`,
  },
  {
    id: "content",
    name: "Pay-per-Item Content",
    method: "GET",
    endpoint: "/api/content/{id}",
    price: "per item",
    description: "Articles and files sold one by one. The unpaid 402 response includes a preview.",
  },
];

function catalog() {
  return {
    name: "Pasar x402",
    network: { name: config.network.label, caip2: config.caip2, chainId: config.network.chain.id },
    token: { address: token.address, symbol: token.symbol, decimals: token.decimals, eip712: { name: token.name, version: token.version } },
    payTo,
    stalls: STALLS,
    content: publicListing(),
  };
}

const routes: RoutesConfig = {
  "GET /api/token-check/*": {
    accepts: exactPayment(config.prices.tokenCheck),
    description: "BSC token risk check: honeypot simulation, taxes, owner powers, liquidity",
    mimeType: "application/json",
    serviceName: "Pasar x402",
  },
  "POST /api/ai/generate": {
    accepts: exactPayment(config.prices.aiGenerate),
    description: `Local LLM inference (${config.ollama.model})`,
    mimeType: "application/json",
    serviceName: "Pasar x402",
  },
  "GET /api/content/*": {
    accepts: {
      ...exactPayment("$0.01"),
      price: (context) => contentItems().get(contentIdFromPath(context.path))?.price ?? "$0.01",
    },
    description: "Pay-per-item content",
    mimeType: "application/json",
    serviceName: "Pasar x402",
    unpaidResponseBody: (context) => {
      const item = contentItems().get(contentIdFromPath(context.path));
      return {
        contentType: "application/json",
        body: item
          ? { preview: { id: item.id, title: item.title, excerpt: item.excerpt, price: item.price } }
          : { error: "Unknown content id" },
      };
    },
  },
};

const app = express();
app.disable("x-powered-by");

// Browsers on other origins (e.g. the site on GitHub Pages) need the x402 headers exposed.
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT, Mcp-Session-Id, Mcp-Protocol-Version");
  res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE, Mcp-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return void res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "32kb" }));

// Free ----------------------------------------------------------------------
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/catalog", (_req, res) => res.json(catalog()));

/** Free upstream examples that the gateway resells; any existing API works the same way. */
app.get("/api/public/gas", async (_req, res) => {
  try {
    const [blockNumber, gasPrice] = await Promise.all([bscMainnetClient.getBlockNumber(), bscMainnetClient.getGasPrice()]);
    res.json({ chain: "bsc", blockNumber: blockNumber.toString(), gasPriceGwei: formatGwei(gasPrice), at: new Date().toISOString() });
  } catch {
    res.status(503).json({ error: "BSC RPC unavailable" });
  }
});
app.get("/api/public/bnb-price", async (_req, res) => {
  try {
    res.json({ symbol: "BNB", usd: Math.round((await bnbPriceUsd()) * 100) / 100, source: "PancakeSwap v2 WBNB/USDT reserves" });
  } catch {
    res.status(503).json({ error: "BSC RPC unavailable" });
  }
});

mountMcp(app, createResourceServer(), catalog);

// Paid ----------------------------------------------------------------------
app.use(
  paymentMiddleware(routes, createResourceServer() as x402ResourceServer, {
    appName: "Pasar x402",
    appLogo: "/assets/logo-mark.svg",
    testnet: true,
  }),
);

app.get("/api/token-check/:address", async (req, res) => {
  try {
    res.json(await checkToken(req.params.address));
  } catch (error) {
    const status = error instanceof TokenCheckError ? error.status : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : "Token check failed" });
  }
});

app.post("/api/ai/generate", async (req, res) => {
  try {
    res.json(await generate(req.body?.prompt, req.body?.system));
  } catch (error) {
    if (error instanceof InferenceError) return void res.status(error.status).json({ error: error.message, hint: error.hint });
    res.status(500).json({ error: "AI failed" });
  }
});

app.get("/api/content/:id", (req, res) => {
  const item = contentItems().get(req.params.id);
  if (!item) return void res.status(404).json({ error: "Unknown content id" });
  res.json(item);
});

// Website ---------------------------------------------------------------------
app.use(express.static(resolve(ROOT, "web"), { extensions: ["html"] }));

app.listen(config.ports.server, () => {
  console.log(`[pasar] ${config.network.label} (${config.caip2})`);
  console.log(`[pasar] website + stalls on http://127.0.0.1:${config.ports.server}`);
  console.log(`[pasar] payments in ${token.symbol} ${token.address} -> ${payTo}`);
  console.log(`[pasar] MCP endpoint http://127.0.0.1:${config.ports.server}/mcp`);
});
