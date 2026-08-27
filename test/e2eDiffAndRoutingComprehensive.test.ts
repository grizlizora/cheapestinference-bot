import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SlotDiffEngine } from "../src/engine/diffEngine.js";
import { ModelSemanticMatcher } from "../src/engine/modelSemanticMatcher.js";
import { SubscriberInvertedIndex } from "../src/bot/notifier/subscriberIndex.js";
import { NotificationDispatcher, OutgoingAlertMessage } from "../src/bot/notifier/dispatcher.js";
import { UserDAO } from "../src/db/dao/users.js";
import { SubscriptionDAO } from "../src/db/dao/subscriptions.js";
import { NotificationLogDAO } from "../src/db/dao/notificationLogs.js";
import { SlotHistoryDAO } from "../src/db/dao/slotHistory.js";
import { PoolsSnapshot, DiffEvent } from "../src/types/domain.js";

describe("Comprehensive E2E DiffEngine, Model Matching & Granular Event Routing Invariants", () => {
  let db: Database.Database;
  let userDao: UserDAO;
  let subDao: SubscriptionDAO;
  let logDao: NotificationLogDAO;
  let historyDao: SlotHistoryDAO;
  let index: SubscriberInvertedIndex;
  let diffEngine: SlotDiffEngine;
  let enqueuedMessages: OutgoingAlertMessage[];

  // Baseline Multi-Pool Production Catalog
  const baseCatalog: PoolsSnapshot = {
    success: true,
    data: [
      {
        id: "flagship",
        slug: "flagship",
        modelId: "flagship",
        modelName: "Flagship Pool — Kimi K3, Qwen3.8 Max",
        models: ["kimi-k3", "qwen3.8-max", "claude-3-haiku", "mistral-large-2407"],
        description: "Flagship compute tier",
        status: "active",
        minPricePerDay: "149.00",
        annualDiscount: 0.15,
        infraSpec: "8x H100 SXM5",
        manualProvisioning: false,
        blocks: [
          { block: "asia", hoursUtc: "00:00-08:00 UTC", pricePerMonth: "155.00", status: "sold-out" },
          { block: "europe", hoursUtc: "08:00-16:00 UTC", pricePerMonth: "165.00", status: "sold-out" },
          { block: "americas", hoursUtc: "16:00-24:00 UTC", pricePerMonth: "149.00", status: "sold-out" },
        ],
      },
      {
        id: "frontier",
        slug: "frontier",
        modelId: "frontier",
        modelName: "Frontier Pool — GLM 5.2, MiniMax M3",
        models: ["glm-5.2", "minimax-m3", "qwen-2.5-coder-32b", "deepseek-v3"],
        description: "Frontier experimental tier",
        status: "active",
        minPricePerDay: "49.00",
        annualDiscount: 0.10,
        infraSpec: "4x A100 80GB",
        manualProvisioning: false,
        blocks: [
          { block: "asia", hoursUtc: "00:00-08:00 UTC", pricePerMonth: "49.00", status: "sold-out" },
          { block: "europe", hoursUtc: "08:00-16:00 UTC", pricePerMonth: "59.00", status: "sold-out" },
          { block: "americas", hoursUtc: "16:00-24:00 UTC", pricePerMonth: "49.00", status: "sold-out" },
        ],
      },
    ],
  };

  beforeEach(() => {
    enqueuedMessages = [];
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL UNIQUE,
        username TEXT,
        first_name TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT 'uk',
        is_muted INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        notify_available_global INTEGER NOT NULL DEFAULT 1,
        notify_sold_out_global INTEGER NOT NULL DEFAULT 1,
        notify_models_global INTEGER NOT NULL DEFAULT 1,
        notify_prices_global INTEGER NOT NULL DEFAULT 1,
        notify_admin_new_users INTEGER NOT NULL DEFAULT 1,
        is_admin INTEGER NOT NULL DEFAULT 0,
        last_active_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
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

    userDao = new UserDAO(db);
    subDao = new SubscriptionDAO(db);
    logDao = new NotificationLogDAO(db);
    historyDao = new SlotHistoryDAO(db);
    diffEngine = new SlotDiffEngine();

    // 10 Realistic Diverse User Profiles
    // User 1: Global Master Subscriber (All pools, all blocks, all events)
    userDao.upsertUser({ telegram_id: 101, first_name: "U1_GlobalMaster", language: "uk" });
    subDao.setSubscription(1, "ALL", "ALL", true);

    // User 2: Flagship Pool Master (Available + Prices only)
    userDao.upsertUser({ telegram_id: 102, first_name: "U2_FlagshipMaster", language: "en" });
    subDao.setSubscription(2, "flagship", "ALL", true);
    subDao.togglePoolEventCategory(2, "flagship", "models"); // Models disabled

    // User 3: Flagship Europe Block Only (Available only)
    userDao.upsertUser({ telegram_id: 103, first_name: "U3_FlagshipEurope", language: "uk" });
    subDao.setSubscription(3, "flagship", "europe", true);
    subDao.togglePoolEventCategory(3, "flagship", "prices"); // Prices disabled
    subDao.togglePoolEventCategory(3, "flagship", "models"); // Models disabled

    // User 4: Frontier Asia Block Only (Sold-out + Prices only)
    userDao.upsertUser({ telegram_id: 104, first_name: "U4_FrontierAsia", language: "ru" });
    subDao.setSubscription(4, "frontier", "asia", true);
    subDao.togglePoolEventCategory(4, "frontier", "sold_out"); // Sold out enabled
    subDao.togglePoolEventCategory(4, "frontier", "available"); // Available disabled

    // User 5: Multi-Block Cross Pool (Flagship Americas + Frontier Europe)
    userDao.upsertUser({ telegram_id: 105, first_name: "U5_MultiRegional", language: "en" });
    subDao.setSubscription(5, "flagship", "americas", true);
    subDao.setSubscription(5, "frontier", "europe", true);

    // User 6: Global Category Switch Disabled (notifySoldOutGlobal = false)
    userDao.upsertUser({ telegram_id: 106, first_name: "U6_NoSoldOutMaster", language: "uk" });
    subDao.setSubscription(6, "ALL", "ALL", true);
    db.exec("UPDATE users SET notify_sold_out_global = 0 WHERE id = 6");

    // User 7: Muted Trader
    userDao.upsertUser({ telegram_id: 107, first_name: "U7_MutedUser", language: "uk" });
    subDao.setSubscription(7, "flagship", "europe", true);
    db.exec("UPDATE users SET is_muted = 1 WHERE id = 7");

    // User 8: Deactivated / Blocked User (isActive = false)
    userDao.upsertUser({ telegram_id: 108, first_name: "U8_DeactivatedUser", language: "en" });
    subDao.setSubscription(8, "ALL", "ALL", true);
    db.exec("UPDATE users SET is_active = 0 WHERE id = 8");

    // User 9: Frontier Pool Master (Available + Models)
    userDao.upsertUser({ telegram_id: 109, first_name: "U9_FrontierMaster", language: "uk" });
    subDao.setSubscription(9, "frontier", "ALL", true);

    // User 10: Highly Engaged Recent Trader
    userDao.upsertUser({ telegram_id: 110, first_name: "U10_ActiveTrader", language: "uk" });
    subDao.setSubscription(10, "flagship", "europe", true);
    db.exec("UPDATE users SET last_active_at = datetime('now', '+1 hour') WHERE id = 10");

    index = new SubscriberInvertedIndex(db);
  });

  const createDispatcher = () => {
    const mockBot: any = {
      api: {
        sendMessage: async () => ({ message_id: 1 }),
      },
    };
    const dispatcher = new NotificationDispatcher(mockBot, userDao, logDao, historyDao, index);
    dispatcher.enqueue = (msg) => {
      enqueuedMessages.push(msg);
    };
    return dispatcher;
  };

  it("1. Zero Missed / Zero False Alert: K=1 Instant Drop vs K=2 Noise Gate Confirmation", async () => {
    const dispatcher = createDispatcher();
    // Cold start bootstrap
    diffEngine.processSnapshot(baseCatalog);

    // STEP A: Flagship Europe becomes AVAILABLE (Instant K=1 Drop)
    const tick1Snapshot: PoolsSnapshot = JSON.parse(JSON.stringify(baseCatalog));
    tick1Snapshot.data[0].blocks[1].status = "available";

    const tick1Events = diffEngine.processSnapshot(tick1Snapshot);
    expect(tick1Events).toHaveLength(1);
    expect(tick1Events[0].type).toBe("SLOT_APPEARED");
    expect(tick1Events[0].poolSlug).toBe("flagship");
    expect(tick1Events[0].block).toBe("europe");

    await dispatcher.handleDiffEvents(tick1Events);
    // Recipients: U1 (Global), U2 (Flagship All), U3 (Flagship Europe), U7 (Muted), U10 (Flagship Europe)
    // U8 is deactivated (filtered), U5 only has Americas (filtered)
    const tick1TgIds = enqueuedMessages.map((m) => m.telegramId);
    expect(tick1TgIds).toContain(101);
    expect(tick1TgIds).toContain(102);
    expect(tick1TgIds).toContain(103);
    expect(tick1TgIds).toContain(107);
    expect(tick1TgIds).toContain(110);
    expect(tick1TgIds).not.toContain(108); // Deactivated
    expect(tick1TgIds).not.toContain(105); // Other block
    enqueuedMessages = [];

    // STEP B: Transient Glitch: Slot shows sold-out for 1 tick, then recovers (K=1 Noise Gate)
    const glitchSnapshot: PoolsSnapshot = JSON.parse(JSON.stringify(baseCatalog)); // sold-out
    const glitchEvents = diffEngine.processSnapshot(glitchSnapshot);
    expect(glitchEvents).toHaveLength(0); // Noise Gate K=1 Suppressed!

    // Recovered to available
    const recoveredSnapshot: PoolsSnapshot = JSON.parse(JSON.stringify(tick1Snapshot));
    const recoveredEvents = diffEngine.processSnapshot(recoveredSnapshot);
    expect(recoveredEvents).toHaveLength(0); // Still available, zero spurious alerts!

    // STEP C: Confirmed Sold Out (K=2 Consecutive ticks)
    diffEngine.processSnapshot(glitchSnapshot); // Scan 1 of sold-out
    const confirmedSoldOutEvents = diffEngine.processSnapshot(glitchSnapshot); // Scan 2 of sold-out
    expect(confirmedSoldOutEvents).toHaveLength(1);
    expect(confirmedSoldOutEvents[0].type).toBe("SLOT_DISAPPEARED");
    expect(confirmedSoldOutEvents[0].block).toBe("europe");

    await dispatcher.handleDiffEvents(confirmedSoldOutEvents);
    // U6 has notifySoldOutGlobal = 0, so U6 must be excluded
    const soldOutTgIds = enqueuedMessages.map((m) => m.telegramId);
    expect(soldOutTgIds).not.toContain(106);
  });

  it("2. Pricing Decoupling: Regional Slot Change vs Uniform Base Price Change", async () => {
    const dispatcher = createDispatcher();
    diffEngine.processSnapshot(baseCatalog);

    // Scenario A: Single regional block drop (Flagship Europe: 165 -> 145)
    const regionalDrop: PoolsSnapshot = JSON.parse(JSON.stringify(baseCatalog));
    regionalDrop.data[0].minPricePerDay = "145.00";
    regionalDrop.data[0].blocks[1].pricePerMonth = "145.00";

    const regionalEvents = diffEngine.processSnapshot(regionalDrop);
    expect(regionalEvents).toHaveLength(1);
    expect(regionalEvents[0].type).toBe("SLOT_PRICE_CHANGED");
    expect(regionalEvents[0].block).toBe("europe");
    expect(regionalEvents[0].slotPrice?.priceDelta).toBe(-20.00);
    expect(regionalEvents.some((e) => e.type === "POOL_BASE_PRICE_CHANGED")).toBe(false); // Suppressed!

    enqueuedMessages = [];
    await dispatcher.handleDiffEvents(regionalEvents);
    // U3 disabled prices for Flagship Europe -> must NOT receive!
    const regTgIds = enqueuedMessages.map((m) => m.telegramId);
    expect(regTgIds).toContain(101); // Global
    expect(regTgIds).toContain(102); // Flagship Master (Prices enabled)
    expect(regTgIds).not.toContain(103); // Flagship Europe (Prices disabled!)

    // Scenario B: Uniform Price Drop across ALL blocks (Flagship: all blocks -> 120.00)
    enqueuedMessages = [];
    const uniformDrop: PoolsSnapshot = JSON.parse(JSON.stringify(regionalDrop));
    uniformDrop.data[0].minPricePerDay = "120.00";
    for (const b of uniformDrop.data[0].blocks) {
      b.pricePerMonth = "120.00";
    }

    const uniformEvents = diffEngine.processSnapshot(uniformDrop);
    expect(uniformEvents).toHaveLength(1);
    expect(uniformEvents[0].type).toBe("POOL_BASE_PRICE_CHANGED");
    expect(uniformEvents[0].block).toBe("ALL");
    expect(uniformEvents.some((e) => e.type === "SLOT_PRICE_CHANGED")).toBe(false); // Individual suppressed!
  });

  it("3. Model Semantic Matcher: Expanded Family Upgrade Matrix", () => {
    const prevModels = [
      "glm-5.2",
      "qwen-2.5-coder-32b",
      "mistral-large-2407",
      "deepseek-v3",
      "gemma-2-27b",
      "phi-3.5-mini",
      "yi-1.5-34b",
      "command-r7b",
      "kimi-k3",
    ];

    const newModels = [
      "glm-5.3",                  // Upgraded from glm-5.2
      "qwen-3.0-coder-32b",       // Upgraded from qwen-2.5-coder-32b
      "mistral-large-2411",       // Upgraded from mistral-large-2407
      "deepseek-v4-flash",        // Upgraded from deepseek-v3
      "gemma-3-12b",              // Upgraded from gemma-2-27b
      "phi-4",                    // Upgraded from phi-3.5-mini
      "yi-lightning",             // Upgraded from yi-1.5-34b
      "command-r-plus",           // Upgraded from command-r7b
      "kimi-k3",                  // Unchanged
      "gpt-5-preview",            // Added
    ];

    const diff = ModelSemanticMatcher.diffModelLists("frontier", "Frontier Pool", prevModels, newModels);
    expect(diff.hasChanges).toBe(true);
    expect(diff.upgraded).toHaveLength(8);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].modelName).toBe("gpt-5-preview");
    expect(diff.removed).toHaveLength(0);

    // Verify upgrade change notes
    const glmUpgrade = diff.upgraded.find((u) => u.family === "glm");
    expect(glmUpgrade?.previousModelName).toBe("glm-5.2");
    expect(glmUpgrade?.modelName).toBe("glm-5.3");
  });

  it("4. High-Concurrency Multi-Event Burst Coalescing & Rate-Limit Invariants", async () => {
    const dispatcher = createDispatcher();

    // Generate burst of 12 distinct simultaneous slot events across pools and blocks
    const burstEvents: DiffEvent[] = [];
    for (let i = 0; i < 12; i++) {
      burstEvents.push({
        id: `burst_unique_${i}`,
        type: "SLOT_APPEARED",
        poolSlug: i % 2 === 0 ? "flagship" : "frontier",
        poolName: i % 2 === 0 ? "Flagship Pool" : "Frontier Pool",
        block: `region_${i}`,
        models: [`model_family_${i}`],
        hoursUtc: "08:00 – 16:00 UTC",
        newPrice: String(100 + i),
        newStatus: "available",
        timestamp: Date.now(),
      });
    }

    await dispatcher.handleDiffEvents(burstEvents);

    // User 1 (Global Master) matched all 12 distinct events.
    // Must be chunked into bundles of max 8 events -> 2 messages for U1 (8 + 4)
    const u1Messages = enqueuedMessages.filter((m) => m.telegramId === 101);
    expect(u1Messages).toHaveLength(2);
    expect(u1Messages[0].text.length).toBeLessThan(3900);
    expect(u1Messages[1].text.length).toBeLessThan(3900);
    expect(u1Messages[0].text).toContain("Оновлення слотів");
  });
});
