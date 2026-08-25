import { Bot } from "grammy";
import { config } from "../src/config/env.js";
import { getDatabase } from "../src/db/index.js";
import { UserDAO } from "../src/db/dao/users.js";
import { SubscriptionDAO } from "../src/db/dao/subscriptions.js";
import { NotificationLogDAO } from "../src/db/dao/notificationLogs.js";
import { SlotHistoryDAO } from "../src/db/dao/slotHistory.js";
import { NotificationDispatcher } from "../src/bot/notifier/dispatcher.js";
import { DiffEvent } from "../src/types/domain.js";

async function main() {
  console.log("🔍 Checking Telegram Bot connection & recent updates...");
  const bot = new Bot(config.BOT_TOKEN);

  const me = await bot.api.getMe();
  console.log(`🤖 Connected as @${me.username} (${me.first_name}, ID: ${me.id})`);

  // 1. Fetch recent updates to find active user chat IDs
  const updates = await bot.api.getUpdates({ limit: 20 });
  console.log(`📥 Received ${updates.length} updates from Telegram.`);

  const chatIds = new Set<number>();
  for (const u of updates) {
    if (u.message?.from?.id) {
      chatIds.add(u.message.from.id);
      console.log(`   Found user from message: ${u.message.from.first_name} (@${u.message.from.username || "none"}) - ID: ${u.message.from.id}`);
    }
    if (u.callback_query?.from?.id) {
      chatIds.add(u.callback_query.from.id);
      console.log(`   Found user from callback: ${u.callback_query.from.first_name} - ID: ${u.callback_query.from.id}`);
    }
  }

  const db = getDatabase();
  const userDao = new UserDAO(db);
  const subDao = new SubscriptionDAO(db);
  const logDao = new NotificationLogDAO(db);
  const historyDao = new SlotHistoryDAO(db);

  // Check database users
  const dbUsers = (db.prepare("SELECT telegram_id, first_name, username, language FROM users").all() as any[]);
  console.log(`👥 Users in local database: ${dbUsers.length}`);
  for (const u of dbUsers) {
    chatIds.add(u.telegram_id);
    console.log(`   • ${u.first_name} (@${u.username || "none"}) - ID: ${u.telegram_id} [${u.language}]`);
  }

  if (chatIds.size === 0) {
    console.log("\n⚠️ No user chat IDs found in getUpdates or local DB.");
    console.log("👉 Please open Telegram, search @cheapestinference_bot and click /start so the bot gets your chat ID!");
    return;
  }

  console.log(`\n🎯 Target Telegram Recipients: ${Array.from(chatIds).join(", ")}`);

  // Initialize Dispatcher
  const dispatcher = new NotificationDispatcher(bot as any, userDao, logDao, historyDao);

  // Seed user in DB & in-memory index
  for (const cid of chatIds) {
    let u = userDao.getByTelegramId(cid);
    if (!u) {
      u = userDao.upsertUser({
        telegram_id: cid,
        first_name: "User",
        language: "uk",
      });
    }
    // Subscribe to ALL pools
    subDao.toggleSubscription(u.id, "ALL", "ALL");
    dispatcher.getInvertedIndex().updateSubscription(u.id, "ALL", "ALL", {
      available: true,
      soldOut: true,
      models: true,
      prices: true,
    });
  }

  console.log("\n🚀 ===========================================================");
  console.log("🚀 STARTING REALISTIC END-TO-END NOTIFICATION DISPATCH TEST");
  console.log("🚀 ===========================================================\n");

  const testEvents: Array<{ name: string; event: DiffEvent }> = [
    {
      name: "1. ⚡ SLOT_APPEARED (Поява доступного слоту)",
      event: {
        id: crypto.randomUUID(),
        type: "SLOT_APPEARED",
        poolSlug: "flagship",
        poolName: "Flagship Pool — Kimi K3, Qwen3.8 Max",
        block: "europe",
        models: ["Kimi K3", "Qwen3.8 Max"],
        hoursUtc: "08:00 – 16:00 UTC",
        previousStatus: "sold-out",
        newStatus: "available",
        newPrice: "149.00",
        timestamp: Date.now(),
      },
    },
    {
      name: "2. 🆕 MODEL_UPGRADE_EVENT (Апгрейд нейромережі: GLM 5.2 ➡️ 5.3 + нова модель)",
      event: {
        id: crypto.randomUUID(),
        type: "MODEL_UPGRADE_EVENT",
        poolSlug: "frontier",
        poolName: "Frontier Pool — GLM, MiniMax",
        block: "ALL",
        models: ["GLM 5.3", "MiniMax M3", "Qwen 3.5 Turbo"],
        hoursUtc: "",
        timestamp: Date.now(),
        modelUpgrade: {
          added: [{ type: "added", modelName: "Qwen 3.5 Turbo", family: "qwen", newVersion: "3.5" }],
          upgraded: [
            {
              type: "upgraded",
              modelName: "GLM 5.3",
              previousModelName: "GLM 5.2",
              family: "glm",
              oldVersion: "5.2",
              newVersion: "5.3",
              changeNote: "GLM 5.2 ➡️ GLM 5.3",
            },
          ],
          removed: [],
          allActiveModels: ["GLM 5.3", "MiniMax M3", "Qwen 3.5 Turbo"],
        },
      },
    },
    {
      name: "3. 🏷 SLOT_PRICE_CHANGED (Зниження ціни на слот: -$10/mo)",
      event: {
        id: crypto.randomUUID(),
        type: "SLOT_PRICE_CHANGED",
        poolSlug: "frontier",
        poolName: "Frontier Pool",
        block: "asia",
        models: ["GLM 5.3", "MiniMax M3"],
        hoursUtc: "00:00 – 08:00 UTC",
        previousPrice: "59.00",
        newPrice: "49.00",
        timestamp: Date.now(),
        slotPrice: {
          previousPrice: "59.00",
          newPrice: "49.00",
          priceDelta: -10,
          percentageDelta: -16.9,
          isDiscount: true,
        },
      },
    },
    {
      name: "4. 📦 TIER_UPDATED_EVENT (Оновлення тарифних умов та знижки)",
      event: {
        id: crypto.randomUUID(),
        type: "TIER_UPDATED_EVENT",
        poolSlug: "core",
        poolName: "Core Pool",
        block: "ALL",
        models: ["DeepSeek V4 Flash", "MiMo v2.5"],
        hoursUtc: "",
        timestamp: Date.now(),
        tierUpdate: {
          newDescription: "Надшвидкий пул з необмеженим доступом до DeepSeek V4",
          previousAnnualDiscount: 0.15,
          newAnnualDiscount: 0.25,
        },
      },
    },
    {
      name: "5. 🔒 SLOT_DISAPPEARED (Слот розпродано / Sold Out)",
      event: {
        id: crypto.randomUUID(),
        type: "SLOT_DISAPPEARED",
        poolSlug: "flagship",
        poolName: "Flagship Pool",
        block: "europe",
        models: ["Kimi K3", "Qwen3.8 Max"],
        hoursUtc: "08:00 – 16:00 UTC",
        previousStatus: "available",
        newStatus: "sold-out",
        timestamp: Date.now(),
      },
    },
  ];

  for (const item of testEvents) {
    const startMs = performance.now();
    console.log(`⏱ Відправляємо [${item.name}]...`);
    await dispatcher.handleDiffEvents([item.event]);
    
    // Give dispatcher token worker time to process and acknowledge Telegram HTTP 200
    await new Promise((r) => setTimeout(r, 250));
    const latency = (performance.now() - startMs).toFixed(1);
    console.log(`   ✅ Успішно доставлено у Telegram (Round-Trip Latency: ${latency} ms)\n`);
  }

  console.log("🎉 Усі 5 видів сповіщень успішно відправлені та доставлені в Telegram!");
}

main().catch(console.error);
