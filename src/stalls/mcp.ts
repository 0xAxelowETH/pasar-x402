// Stall 2 — paid MCP server. Each tool call carries an x402 payment in _meta["x402/payment"].
import type { Express } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createPaymentWrapper } from "@x402/mcp";
import type { x402ResourceServer } from "@x402/core/server";
import { z } from "zod";
import { config } from "../config.js";
import { exactPayment } from "../x402.js";
import { generate, InferenceError } from "./inference.js";
import { checkToken, TokenCheckError } from "./token-check.js";

type Paid = ReturnType<typeof createPaymentWrapper>;

function text(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function mountMcp(app: Express, resourceServer: x402ResourceServer, catalog: () => unknown) {
  let wrappers: Promise<{ tokenCheck: Paid; ai: Paid }> | undefined;

  function paidWrappers() {
    wrappers ??= (async () => {
      await resourceServer.initialize();
      const wrap = async (price: string) =>
        createPaymentWrapper(resourceServer, {
          accepts: await resourceServer.buildPaymentRequirements(exactPayment(price)),
          resource: { serviceName: "Pasar x402" },
        });
      return { tokenCheck: await wrap(config.prices.mcpTokenCheck), ai: await wrap(config.prices.mcpAi) };
    })().catch((error) => {
      wrappers = undefined;
      throw error;
    });
    return wrappers;
  }

  function buildServer(paid: { tokenCheck: Paid; ai: Paid }) {
    const server = new McpServer({ name: "pasar-x402", version: "0.1.0" });

    server.registerTool(
      "market_info",
      { description: "Free. Lists every Pasar x402 stall, its price and how to pay." },
      async () => text(catalog()),
    );

    server.registerTool(
      "token_check",
      {
        description: `Paid (${config.prices.mcpTokenCheck}). BNB Smart Chain token risk check: honeypot simulation, buy/sell tax, owner powers, proxy, liquidity.`,
        inputSchema: { address: z.string().describe("BEP-20 token address (0x...)") },
      },
      paid.tokenCheck(async (args: { address: string }) => {
        try {
          return text(await checkToken(args.address));
        } catch (error) {
          return text(error instanceof TokenCheckError ? error.message : "Token check failed", true);
        }
      }) as never,
    );

    server.registerTool(
      "ask_ai",
      {
        description: `Paid (${config.prices.mcpAi}). Ask the stall's local LLM a question.`,
        inputSchema: { prompt: z.string().min(1).max(4000) },
      },
      paid.ai(async (args: { prompt: string }) => {
        try {
          const answer = await generate(args.prompt);
          return text(answer.response);
        } catch (error) {
          const message = error instanceof InferenceError ? `${error.message} ${error.hint ?? ""}`.trim() : "AI failed";
          return text(message, true);
        }
      }) as never,
    );

    return server;
  }

  // Stateless Streamable HTTP: a fresh server + transport per request.
  app.post("/mcp", async (req, res) => {
    try {
      const server = buildServer(await paidWrappers());
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[mcp]", error);
      if (!res.headersSent) {
        res.status(503).json({ jsonrpc: "2.0", error: { code: -32603, message: "Payments unavailable: is the facilitator running?" }, id: null });
      }
    }
  });

  app.all("/mcp", (_req, res) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Use POST" }, id: null });
  });
}
