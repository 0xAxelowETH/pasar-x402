// Shopping agent (Telegram). Needs TELEGRAM_BOT_TOKEN from @BotFather.
// The bot pays the stalls from the agent wallet; whoever can message it spends that budget,
// so set TELEGRAM_ALLOWED_USERS to your own Telegram user id(s).
import { Bot } from "grammy";
import { config } from "../config.js";
import { handle, HELP } from "./actions.js";
import { createAgent } from "./wallet.js";

if (!config.telegramToken) {
  console.error("TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather and add the token to .env.");
  process.exit(1);
}

const allowed = (process.env.TELEGRAM_ALLOWED_USERS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const agent = createAgent();
const bot = new Bot(config.telegramToken);

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id?.toString();
  if (allowed.length && (!userId || !allowed.includes(userId))) {
    await ctx.reply(`This bot is private. Your Telegram user id: ${userId ?? "?"}`);
    return;
  }
  await next();
});

bot.command(["start", "help"], (ctx) =>
  ctx.reply(`Hi! I'm the Pasar x402 shopping agent on ${config.network.label}.\n\n${HELP}`),
);

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.replace(/^\/(\w+)(@\w+)?/, "$1");
  await ctx.replyWithChatAction("typing");
  try {
    const answer = await handle(agent, text);
    await ctx.reply(answer.slice(0, 4000), { link_preview_options: { is_disabled: true } });
  } catch (error) {
    await ctx.reply(`✖ ${error instanceof Error ? error.message : error}`);
  }
});

bot.catch((error) => console.error("[bot]", error.message));

if (!allowed.length) console.warn("[bot] TELEGRAM_ALLOWED_USERS is empty: anyone can spend the agent budget");
console.log(`[bot] agent ${agent.address} — starting long polling`);
await bot.start();
