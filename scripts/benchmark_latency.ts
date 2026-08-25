import Database from "better-sqlite3";
import { Bot } from "grammy";
import { UserDAO } from "../src/db/dao/users.js";
import { SubscriptionDAO } from "../src/db/dao/subscriptions.js";
import { NotificationLogDAO } from "../src/db/dao/notificationLogs.js";
import { SlotHistoryDAO } from "../src/db/dao/slotHistory.js";
import { SubscriberInvertedIndex } from "../src/bot/notifier/subscriberIndex.js";
import { NotificationDispatcher } from "../src/bot/notifier/dispatcher.js";
import { DiffEvent } from "../src/types/domain.js";

async function runBenchmark() {
  console.log("⚡ ===========================================================");
  console.log("⚡ RUNNING HIGH-PRECISION PIPELINE & LATENCY BENCHMARK");
  console.log("⚡ ===========================================================\n");

  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL UNIQUE,
      username TEXT,
      first_name TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'en',
      is_muted INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      notify_available_global INTEGER NOT NULL DEFAULT 1,
      notify_sold_out_global INTEGER NOT NULL DEFAULT 0,
      notify_models_global INTEGER NOT NULL DEFAULT 1,
      notify_prices_global INTEGER NOT NULL DEFAULT 1,
      notify_admin_new_users INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      pool_slug TEXT NOT NULL,
      block_id TEXT NOT NULL,
      notify_on_available INTEGER NOT NULL DEFAULT 1,
      notify_on_sold_out INTEGER NOT NULL DEFAULT 0,
      notify_on_models INTEGER NOT NULL DEFAULT 1,
      notify_on_prices INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, pool_slug, block_id)
    );
    CREATE TABLE notification_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      pool_slug TEXT NOT NULL,
      block_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE slot_lifecycle_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_slug TEXT NOT NULL,
      block_id TEXT NOT NULL,
      opened_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at DATETIME,
      duration_seconds INTEGER,
      initial_status TEXT NOT NULL,
      price_month TEXT NOT NULL
    );
  `);

  const userDao = new UserDAO(db);
  const subDao = new SubscriptionDAO(db);
  const logDao = new NotificationLogDAO(db);
  const historyDao = new SlotHistoryDAO(db);

  // 1. Simulate 5,000 active subscribers
  console.log("👥 Seeding 5,000 active subscribers with diverse subscription tiers in SQLite...");
  const insertUser = db.prepare("INSERT INTO users (telegram_id, first_name, language) VALUES (?, ?, ?)");
  const insertSub = db.prepare("INSERT INTO subscriptions (user_id, pool_slug, block_id, notify_on_available, notify_on_sold_out, notify_on_models, notify_on_prices) VALUES (?, ?, ?, 1, 1, 1, 1)");

  db.transaction(() => {
    for (let i = 1; i <= 5000; i++) {
      const lang = i % 3 === 0 ? "uk" : i % 3 === 1 ? "en" : "ru";
      insertUser.run(100000 + i, `User_${i}`, lang);
      if (i % 2 === 0) insertSub.run(i, "ALL", "ALL");
      if (i % 3 === 0) insertSub.run(i, "flagship", "europe");
      if (i % 5 === 0) insertSub.run(i, "frontier", "asia");
    }
  })();

  const index = new SubscriberInvertedIndex(db);

  // Mock bot to measure pure internal dispatch latency without network jitter
  let dispatchedCount = 0;
  const mockBot: any = {
    api: {
      sendMessage: async () => {
        dispatchedCount++;
        return { message_id: 1 };
      },
    },
  };

  const dispatcher = new NotificationDispatcher(mockBot, userDao, logDao, historyDao, index);

  const testEvents: DiffEvent[] = [
    {
      id: crypto.randomUUID(),
      type: "SLOT_APPEARED",
      poolSlug: "flagship",
      poolName: "Flagship Pool",
      block: "europe",
      models: ["Kimi K3", "Qwen3.8 Max"],
      hoursUtc: "08:00 – 16:00 UTC",
      previousStatus: "sold-out",
      newStatus: "available",
      newPrice: "149.00",
      timestamp: Date.now(),
    },
    {
      id: crypto.randomUUID(),
      type: "MODEL_UPGRADE_EVENT",
      poolSlug: "frontier",
      poolName: "Frontier Pool",
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
    {
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
    {
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
    {
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
  ];

  console.log("⏱ Benchmarking In-Memory Index Resolution & Queue Enqueueing for 5,000 subscribers...");
  const t0 = performance.now();

  for (const event of testEvents) {
    const eStart = performance.now();
    await dispatcher.handleDiffEvents([event]);
    const eElapsed = (performance.now() - eStart).toFixed(2);
    console.log(`   • [${event.type}] matched & enqueued in ${eElapsed} ms`);
  }

  const totalEnqueueTime = (performance.now() - t0).toFixed(2);
  const queueStats = dispatcher.getQueueMetrics();

  console.log(`\n📊 Enqueueing Results:`);
  console.log(`   • Total Enqueue Latency for all 5 events: ${totalEnqueueTime} ms`);
  console.log(`   • P0 (Interactive): ${queueStats.p0} items`);
  console.log(`   • P1 (Slot Drops): ${queueStats.p1} items`);
  console.log(`   • P2 (Models/Prices): ${queueStats.p2} items`);
  console.log(`   • P3 (Sold Out): ${queueStats.p3} items`);
  console.log(`   • Total Queued Messages: ${queueStats.total}`);
}

runBenchmark().catch(console.error);
