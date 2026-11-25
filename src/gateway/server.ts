// Stall 4 — x402 Gateway: an x402 paywall in front of any existing HTTP API, driven by gateway.config.json.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express, { type Request, type Response } from "express";
import { paymentMiddleware } from "@x402/express";
import type { RoutesConfig } from "@x402/core/http";
import { config, ROOT } from "../config.js";
import { createResourceServer, exactPayment } from "../x402.js";

type GatewayRoute = { method: string; path: string; upstream: string; price: string; description?: string };

const configPath = resolve(ROOT, process.env.GATEWAY_CONFIG ?? "gateway.config.json");
const gatewayRoutes = (JSON.parse(readFileSync(configPath, "utf8")) as { routes: GatewayRoute[] }).routes;

for (const route of gatewayRoutes) {
  if (!route.path.endsWith("/*")) throw new Error(`gateway route "${route.path}" must end with /*`);
  new URL(route.upstream); // throws on an invalid upstream
}

const routes: RoutesConfig = Object.fromEntries(
  gatewayRoutes.map((route) => [
    `${route.method.toUpperCase()} ${route.path}`,
    {
      accepts: exactPayment(route.price),
      description: route.description ?? `Proxied ${route.upstream}`,
      mimeType: "application/json",
      serviceName: "x402 Gateway",
    },
  ]),
);

// Headers that must not be forwarded: hop-by-hop, payment proofs, and ones fetch recomputes.
const DROP_REQUEST_HEADERS = new Set(["host", "connection", "content-length", "payment-signature", "x-payment", "accept-encoding"]);
const DROP_RESPONSE_HEADERS = new Set(["connection", "content-length", "content-encoding", "transfer-encoding", "keep-alive"]);

function proxyTo(route: GatewayRoute) {
  return async (req: Request, res: Response) => {
    if (route.method !== "*" && req.method !== route.method.toUpperCase()) {
      return void res.status(405).json({ error: `Use ${route.method}` });
    }
    const target = `${route.upstream.replace(/\/+$/, "")}${req.url}`;
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (!DROP_REQUEST_HEADERS.has(name) && typeof value === "string") headers.set(name, value);
    }
    headers.set("x-forwarded-for", req.ip ?? "");
    headers.set("x-forwarded-by", "pasar-x402-gateway");

    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: !["GET", "HEAD"].includes(req.method) && Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      res.status(upstream.status);
      upstream.headers.forEach((value, name) => {
        if (!DROP_RESPONSE_HEADERS.has(name)) res.setHeader(name, value);
      });
      // A >= 400 upstream status makes the x402 middleware skip settlement: no charge for failures.
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      res.status(502).json({ error: "Upstream unavailable" });
    }
  };
}

const app = express();
app.disable("x-powered-by");
app.use(express.raw({ type: "*/*", limit: "1mb" }));

app.get("/", (_req, res) => {
  res.json({
    name: "x402 Gateway",
    network: config.caip2,
    routes: gatewayRoutes.map(({ method, path, price, description }) => ({ method, path, price, description })),
  });
});

app.use(paymentMiddleware(routes, createResourceServer(), { appName: "x402 Gateway", testnet: true }));

for (const route of gatewayRoutes) {
  app.use(route.path.slice(0, -2), proxyTo(route));
}

app.listen(config.ports.gateway, () => {
  console.log(`[gateway] ${gatewayRoutes.length} paid route(s) on http://127.0.0.1:${config.ports.gateway}`);
  for (const route of gatewayRoutes) console.log(`[gateway]   ${route.method} ${route.path} -> ${route.upstream} (${route.price})`);
});
