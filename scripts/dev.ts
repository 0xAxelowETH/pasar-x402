// One command for the whole market. On NETWORK=local it also starts a Hardhat chain and deploys pUSD.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { config, deploymentPath, ROOT } from "../src/config.js";

const TSX = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");
const HARDHAT = resolve(ROOT, "node_modules/hardhat/dist/src/cli.js");
const children: ChildProcess[] = [];

const COLORS = ["\x1b[33m", "\x1b[36m", "\x1b[35m", "\x1b[32m"];

function start(name: string, args: string[], color: string, quiet = false) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = `${color}${name.padEnd(11)}\x1b[0m│ `;
  const forward = (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim() && !(quiet && /eth_|Contract call|From:|To:|Value:|Gas used|Block #|Transaction:|Account #|Private Key|Accounts$|=====|publicly known private keys/.test(line))) {
        process.stdout.write(`${prefix}${line}\n`);
      }
    }
  };
  child.stdout?.on("data", forward);
  child.stderr?.on("data", forward);
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`${prefix}exited with code ${code}`);
      shutdown(1);
    }
  });
  children.push(child);
  return child;
}

async function waitFor(name: string, check: () => Promise<boolean>, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${name} did not become ready in ${timeoutMs / 1000}s`);
}

const httpOk = (url: string) => async () => (await fetch(url)).ok;

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.pid === undefined || child.exitCode !== null) continue;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

try {
  if (config.isLocal) {
    start("chain", [HARDHAT, "node"], COLORS[0], true);
    await waitFor("Hardhat chain", async () => {
      const res = await fetch("http://127.0.0.1:8545", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      return res.ok;
    });
    const deploy = spawnSync(process.execPath, [TSX, "scripts/deploy.ts"], { cwd: ROOT, env: process.env, stdio: "inherit" });
    if (deploy.status !== 0) throw new Error("deploy failed");
    // A fresh chain means fresh balances, so the agent's local spending log starts over too.
    rmSync(resolve(ROOT, ".data/agent-ledger-local.json"), { force: true });
  } else if (!existsSync(deploymentPath()) && !process.env.PAYMENT_TOKEN_ADDRESS) {
    throw new Error(`No pUSD deployment for ${config.network.name}. Run "npm run deploy" first.`);
  }

  start("facilitator", [TSX, "src/facilitator/server.ts"], COLORS[1]);
  await waitFor("facilitator", httpOk(`${config.urls.facilitator}/health`));
  start("market", [TSX, "src/stalls/server.ts"], COLORS[2]);
  await waitFor("market", httpOk(`${config.urls.server}/api/health`));
  start("gateway", [TSX, "src/gateway/server.ts"], COLORS[3]);
  await waitFor("gateway", httpOk(`${config.urls.gateway}/`));

  console.log(`
\x1b[1mPasar x402 is open on ${config.network.label}\x1b[0m
  Website      ${config.urls.server}
  Catalog      ${config.urls.server}/api/catalog
  MCP          ${config.urls.server}/mcp
  Gateway      ${config.urls.gateway}
  Facilitator  ${config.urls.facilitator}

Try in another terminal:
  npm run demo
  npm run agent -- 0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82
Press Ctrl+C to stop everything.
`);
} catch (error) {
  console.error(`\n✖ ${error instanceof Error ? error.message : error}`);
  shutdown(1);
}
