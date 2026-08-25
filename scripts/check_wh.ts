import { Bot } from "grammy";
import { config } from "../src/config/env.js";

async function checkInfo() {
  const bot = new Bot(config.BOT_TOKEN);
  const me = await bot.api.getMe();
  console.log("Bot:", me);
  const wh = await bot.api.getWebhookInfo();
  console.log("Webhook Info:", wh);
}

checkInfo().catch(console.error);
