// Shopping agent (CLI). Usage: npm run agent -- <command>   e.g. npm run agent -- 0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82
import { createInterface } from "node:readline/promises";
import { handle, HELP } from "./actions.js";
import { createAgent } from "./wallet.js";

const agent = createAgent();
const input = process.argv.slice(2).join(" ").trim();

async function run(line: string) {
  try {
    console.log(await handle(agent, line));
  } catch (error) {
    console.error(`✖ ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

if (input && input !== "help") {
  await run(input);
} else if (input === "help") {
  console.log(HELP);
} else {
  console.log(`${HELP}\n\nAgent ${agent.address}. Type a command, or "exit".`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    const line = (await rl.question("agent> ")).trim();
    if (!line) continue;
    if (["exit", "quit"].includes(line)) break;
    await run(line);
  }
  rl.close();
}
