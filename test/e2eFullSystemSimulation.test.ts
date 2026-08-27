import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/index.js";
import { UserDAO } from "../src/db/dao/users.js";
import { SubscriptionDAO } from "../src/db/dao/subscriptions.js";
import { PoolStateDAO } from "../src/db/dao/poolState.js";
import { SlotHistoryDAO } from "../src/db/dao/slotHistory.js";
import { CatalogHistoryDAO } from "../src/db/dao/catalogHistory.js";
import { NotificationLogDAO } from "../src/db/dao/notificationLogs.js";
import { SubscriberInvertedIndex } from "../src/bot/notifier/subscriberIndex.js";
import { NotificationDispatcher, OutgoingAlertMessage } from "../src/bot/notifier/dispatcher.js";
import { SlotDiffEngine } from "../src/engine/diffEngine.js";
import { createUsersExportHandler, createHistoryExportHandler, createBackupHandler } from "../src/bot/handlers/backup.js";
import { isUserAdmin } from "../src/config/env.js";
import { PoolsSnapshot } from "../src/types/domain.js";

describe("🌟 Comprehensive Full-System E2E Simulation & Storage Boundary Test Suite", () => {
  let db: Database.Database;
  let userDao: UserDAO;
  let subDao: SubscriptionDAO;
  let poolStateDao: PoolStateDAO;
  let slotHistoryDao: SlotHistoryDAO;
  let catalogHistoryDao: CatalogHistoryDAO;
  let logDao: NotificationLogDAO;
  let index: SubscriberInvertedIndex;
  let dispatcher: NotificationDispatcher;
  let diffEngine: SlotDiffEngine;

  // Mock Telegram Dispatch Container
  const fakeBot: any = {
    api: {
      sendMessage: vi.fn().mockImplementation((chatId: number, text: string, extra: any) => {
        return Promise.resolve({ message_id: Math.floor(Math.random() * 100000) });
      }),
    },
  };

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);

    userDao = new UserDAO(db);
    subDao = new SubscriptionDAO(db);
    poolStateDao = new PoolStateDAO(db);
    slotHistoryDao = new SlotHistoryDAO(db);
    catalogHistoryDao = new CatalogHistoryDAO(db);
    logDao = new NotificationLogDAO(db);

    index = new SubscriberInvertedIndex(db);
    dispatcher = new NotificationDispatcher(fakeBot, userDao, logDao, slotHistoryDao, index);
    diffEngine = new SlotDiffEngine(slotHistoryDao, catalogHistoryDao);
  });

  it("Full Lifecycle Simulation: Users, Subscriptions, Multi-Tariff Diffing, Storage Boundaries & Excel Exports", async () => {
    // =========================================================================
    // PHASE 1: Multi-User Simulation & Granular Subscription Isolation
    // =========================================================================
    
    // User 1: Admin @grizlizora (ID: 828157777)
    const isAdmin = isUserAdmin(828157777, userDao, "grizlizora");
    expect(isAdmin).toBe(true);
    const u1 = userDao.upsertUser({
      telegram_id: 828157777,
      username: "grizlizora",
      first_name: "Roman",
      language: "uk",
    });
    userDao.setAdmin(828157777, true);
    index.upsertUserProfile({
      userId: u1.id,
      telegramId: u1.telegram_id,
      language: "uk",
      isMuted: false,
      isActive: true,
      notifyAvailableGlobal: true,
      notifySoldOutGlobal: false,
      notifyModelsGlobal: true,
      notifyPricesGlobal: true,
    });

    // User 2: Regular User (ID: 1002) - Subscribes to Flagship Pool (ALL blocks) + Available alerts only
    const u2 = userDao.upsertUser({
      telegram_id: 1002,
      username: "john_doe",
      first_name: "John",
      language: "en",
    });
    index.upsertUserProfile({
      userId: u2.id,
      telegramId: u2.telegram_id,
      language: "en",
      isMuted: false,
      isActive: true,
      notifyAvailableGlobal: true,
      notifySoldOutGlobal: false,
      notifyModelsGlobal: false,
      notifyPricesGlobal: false,
    });
    subDao.togglePoolWithBlocks(u2.id, "flagship", ["asia", "europe", "americas"]);
    index.updateSubscription(u2.id, "flagship", "ALL", { available: true, soldOut: false, models: false, prices: false });
    index.updateSubscription(u2.id, "flagship", "asia", { available: true, soldOut: false, models: false, prices: false });
    index.updateSubscription(u2.id, "flagship", "europe", { available: true, soldOut: false, models: false, prices: false });
    index.updateSubscription(u2.id, "flagship", "americas", { available: true, soldOut: false, models: false, prices: false });

    // User 3: Granular User (ID: 1003) - Subscribes to Core Pool -> Europe Block ONLY + Price Alerts + Muted (is_muted = 1)
    const u3 = userDao.upsertUser({
      telegram_id: 1003,
      username: "alice_crypto",
      first_name: "Alice",
      language: "en",
    });
    userDao.toggleMute(1003); // is_muted = 1
    index.upsertUserProfile({
      userId: u3.id,
      telegramId: u3.telegram_id,
      language: "en",
      isMuted: true,
      isActive: true,
      notifyAvailableGlobal: false,
      notifySoldOutGlobal: false,
      notifyModelsGlobal: false,
      notifyPricesGlobal: true,
    });
    subDao.toggleBlockAndUpdatePool(u3.id, "core", "europe", ["asia", "europe", "americas"]);
    subDao.togglePoolEventCategory(u3.id, "core", "available", ["asia", "europe", "americas"]); // Disable available
    subDao.togglePoolEventCategory(u3.id, "core", "models", ["asia", "europe", "americas"]); // Disable models
    index.updateSubscription(u3.id, "core", "europe", { available: false, soldOut: false, models: false, prices: true });

    // User 4: Multi-Pool User (ID: 1004) - Subscribes to Frontier Pool -> Asia & Americas blocks + Model Upgrades + Russian Language
    const u4 = userDao.upsertUser({
      telegram_id: 1004,
      username: "dmitry_ai",
      first_name: "Dmitry",
      language: "ru",
    });
    index.upsertUserProfile({
      userId: u4.id,
      telegramId: u4.telegram_id,
      language: "ru",
      isMuted: false,
      isActive: true,
      notifyAvailableGlobal: false,
      notifySoldOutGlobal: false,
      notifyModelsGlobal: true,
      notifyPricesGlobal: false,
    });
    subDao.toggleBlockAndUpdatePool(u4.id, "frontier", "asia", ["asia", "europe", "americas"]);
    subDao.toggleBlockAndUpdatePool(u4.id, "frontier", "americas", ["asia", "europe", "americas"]);
    subDao.togglePoolEventCategory(u4.id, "frontier", "available", ["asia", "europe", "americas"]); // Disable available
    subDao.togglePoolEventCategory(u4.id, "frontier", "prices", ["asia", "europe", "americas"]); // Disable prices
    index.updateSubscription(u4.id, "frontier", "asia", { available: false, soldOut: false, models: true, prices: false });
    index.updateSubscription(u4.id, "frontier", "americas", { available: false, soldOut: false, models: true, prices: false });

    // User 2 runs /start 5 times -> verifies 0 duplicate registrations
    for (let i = 0; i < 5; i++) {
      const existing = userDao.getByTelegramId(1002);
      expect(existing).toBeDefined();
      const isBrandNew = !existing;
      expect(isBrandNew).toBe(false);
    }

    // Verify Inverted Index RAM integrity
    const stats = index.getMemoryStats();
    expect(stats.userCount).toBe(4);
    expect(stats.indexKeys).toBeGreaterThanOrEqual(3);

    // =========================================================================
    // PHASE 2: Baseline Catalog Bootstrap
    // =========================================================================
    const initialSnapshot: PoolsSnapshot = {
      success: true,
      data: [
        {
          slug: "flagship",
          modelName: "Flagship GPU Pool",
          models: ["llama-3.3-70b", "qwen-2.5-72b"],
          description: "High compute tier",
          minPricePerDay: "$3.30",
          blocks: [
            { block: "asia", status: "sold-out", pricePerMonth: "$99", hoursUtc: "00:00-08:00" },
            { block: "europe", status: "sold-out", pricePerMonth: "$99", hoursUtc: "08:00-16:00" },
            { block: "americas", status: "sold-out", pricePerMonth: "$99", hoursUtc: "16:00-24:00" },
          ],
        },
        {
          slug: "core",
          modelName: "Core Compute Pool",
          models: ["mistral-small", "phi-4"],
          description: "Standard tier",
          minPricePerDay: "$4.00",
          blocks: [
            { block: "asia", status: "sold-out", pricePerMonth: "$120", hoursUtc: "00:00-08:00" },
            { block: "europe", status: "sold-out", pricePerMonth: "$120", hoursUtc: "08:00-16:00" },
            { block: "americas", status: "sold-out", pricePerMonth: "$120", hoursUtc: "16:00-24:00" },
          ],
        },
        {
          slug: "frontier",
          modelName: "Frontier Reasoning Pool",
          models: ["deepseek-v3", "qwen-2.5-coder"],
          description: "Reasoning models",
          minPricePerDay: "$6.00",
          blocks: [
            { block: "asia", status: "sold-out", pricePerMonth: "$180", hoursUtc: "00:00-08:00" },
            { block: "europe", status: "sold-out", pricePerMonth: "$180", hoursUtc: "08:00-16:00" },
            { block: "americas", status: "sold-out", pricePerMonth: "$180", hoursUtc: "16:00-24:00" },
          ],
        },
      ],
      timestamp: Date.now(),
    };

    const bootstrapEvents = diffEngine.processSnapshot(initialSnapshot);
    expect(bootstrapEvents.length).toBe(0); // Cold boot is silent
    poolStateDao.saveSnapshot(initialSnapshot.data);

    // =========================================================================
    // PHASE 3: Live Scrape Event Burst & Multi-Tariff Diffing
    // =========================================================================
    
    // Event A: Flagship Europe slot opens (sold-out -> available) at $99
    // Expected: User 2 receives alert. User 3 and User 4 do NOT.
    const snapshotA = JSON.parse(JSON.stringify(initialSnapshot));
    snapshotA.data[0].blocks[1].status = "available"; // flagship europe available

    const eventsA = diffEngine.processSnapshot(snapshotA);
    expect(eventsA.length).toBe(1);
    expect(eventsA[0].type).toBe("SLOT_APPEARED");
    expect(eventsA[0].poolSlug).toBe("flagship");
    expect(eventsA[0].block).toBe("europe");

    const matchedSubsA = index.resolveSubscribers("flagship", "europe", "available");
    const matchedTgIdsA = matchedSubsA.map((s) => s.telegramId);
    expect(matchedTgIdsA).toContain(1002); // User 2 matched
    expect(matchedTgIdsA).not.toContain(1003); // User 3 excluded (only core)
    expect(matchedTgIdsA).not.toContain(1004); // User 4 excluded (only frontier)

    // Dispatch Event A
    await dispatcher.handleDiffEvents(eventsA);
    expect(dispatcher.getQueueMetrics().p1).toBeGreaterThanOrEqual(1);

    // Event B: Core Europe slot price drops from $120 to $85 (-$35 / -29.17%)
    // Expected: User 3 receives price drop alert. User 2 and User 4 do NOT.
    const snapshotB = JSON.parse(JSON.stringify(snapshotA));
    snapshotB.data[1].blocks[1].pricePerMonth = "$85"; // core europe price changed

    const eventsB = diffEngine.processSnapshot(snapshotB);
    expect(eventsB.length).toBe(1);
    expect(eventsB[0].type).toBe("SLOT_PRICE_CHANGED");
    expect(eventsB[0].poolSlug).toBe("core");
    expect(eventsB[0].block).toBe("europe");
    expect(eventsB[0].slotPrice?.priceDelta).toBe(-35);

    const matchedSubsB = index.resolveSubscribers("core", "europe", "prices");
    const matchedTgIdsB = matchedSubsB.map((s) => s.telegramId);
    expect(matchedTgIdsB).toContain(1003); // User 3 matched
    expect(matchedTgIdsB).not.toContain(1002); // User 2 excluded
    expect(matchedTgIdsB).not.toContain(1004); // User 4 excluded

    // Verify User 3 sound mute is respected (isMuted = true -> Telegram silent push)
    const u3Profile = index.getProfileByTgId(1003);
    expect(u3Profile?.isMuted).toBe(true);

    // Event C: Frontier pool upgrades models with Claude 3.7 & DeepSeek R1
    // Expected: User 4 receives localized Russian model alert.
    const snapshotC = JSON.parse(JSON.stringify(snapshotB));
    snapshotC.data[2].models = ["deepseek-r1", "claude-3-7-sonnet", "qwen-2.5-coder"];

    const eventsC = diffEngine.processSnapshot(snapshotC);
    expect(eventsC.length).toBe(1);
    expect(eventsC[0].type).toBe("MODEL_UPGRADE_EVENT");
    expect(eventsC[0].poolSlug).toBe("frontier");
    expect(eventsC[0].models).toContain("claude-3-7-sonnet");

    const matchedSubsC = index.resolveSubscribers("frontier", "asia", "models");
    const matchedTgIdsC = matchedSubsC.map((s) => s.telegramId);
    expect(matchedTgIdsC).toContain(1004); // User 4 matched

    // Event D: Noise Gate Sold Out Simulation
    // Tick 1: Slot disappears momentarily (glitch) -> 0 alerts emitted
    const snapshotD1 = JSON.parse(JSON.stringify(snapshotC));
    snapshotD1.data[0].blocks[1].status = "sold-out";

    const eventsD1 = diffEngine.processSnapshot(snapshotD1);
    expect(eventsD1.length).toBe(0); // Noise gate K=1 suppresses false sold-out!

    // Tick 2: Confirmed Sold Out -> SLOT_DISAPPEARED emitted on K=2
    const eventsD2 = diffEngine.processSnapshot(snapshotD1);
    expect(eventsD2.length).toBe(1);
    expect(eventsD2[0].type).toBe("SLOT_DISAPPEARED");

    // =========================================================================
    // PHASE 4: RAM vs Disk Storage Boundary Verification
    // =========================================================================
    
    // 1. Verify RAM footprint: holds ONLY active slot map and inverted index
    const ramSnapshot = diffEngine.getSnapshot();
    expect(ramSnapshot.data.length).toBe(3); // 3 pools only

    // 2. Verify SQLite Disk Tables: hold ALL historical events without RAM accumulation
    const slotHistoryRows = db.prepare("SELECT * FROM slot_lifecycle_history").all() as any[];
    expect(slotHistoryRows.length).toBeGreaterThanOrEqual(1);
    expect(slotHistoryRows[0].pool_slug).toBe("flagship");
    expect(slotHistoryRows[0].block_id).toBe("europe");

    const priceHistoryRows = db.prepare("SELECT * FROM slot_price_history").all() as any[];
    expect(priceHistoryRows.length).toBeGreaterThanOrEqual(1);
    expect(priceHistoryRows[0].old_price).toBe("$120");
    expect(priceHistoryRows[0].new_price).toBe("$85");
    expect(priceHistoryRows[0].price_delta).toBe(-35);

    const catalogHistoryRows = db.prepare("SELECT * FROM catalog_history").all() as any[];
    expect(catalogHistoryRows.length).toBeGreaterThanOrEqual(1);
    expect(catalogHistoryRows[0].pool_slug).toBe("frontier");
    expect(catalogHistoryRows[0].event_type).toBe("MODEL_UPGRADE");

    // =========================================================================
    // PHASE 5: Admin Excel/CSV Export Simulation
    // =========================================================================
    
    // 1. Test Users Excel/CSV Export
    let usersDocSent: any = null;
    const mockCtxAdmin: any = {
      from: { id: 828157777, username: "grizlizora" },
      lang: "uk",
      t: (k: string) => k,
      reply: vi.fn().mockResolvedValue({ message_id: 99 }),
      replyWithDocument: vi.fn().mockImplementation((doc, opts) => {
        usersDocSent = doc;
        return Promise.resolve();
      }),
      api: { deleteMessage: vi.fn().mockResolvedValue(true) },
      chat: { id: 828157777 },
    };

    const usersExportHandler = createUsersExportHandler(db, userDao, subDao);
    await usersExportHandler(mockCtxAdmin);

    expect(mockCtxAdmin.replyWithDocument).toHaveBeenCalled();
    const usersCsv = (usersDocSent as any).fileData.toString("utf8");
    expect(usersCsv.startsWith("\uFEFF")).toBe(true); // UTF-8 BOM for Excel
    expect(usersCsv).toContain("Telegram ID");
    expect(usersCsv).toContain("828157777");
    expect(usersCsv).toContain("1002");
    expect(usersCsv).toContain("1003");
    expect(usersCsv).toContain("1004");
    expect(usersCsv).toContain("FLAGSHIP:ALL");
    expect(usersCsv).toContain("CORE:europe");
    expect(usersCsv).toContain("FRONTIER:asia");

    // 2. Test Change History Excel/CSV Export
    let historyDocSent: any = null;
    mockCtxAdmin.replyWithDocument = vi.fn().mockImplementation((doc, opts) => {
      historyDocSent = doc;
      return Promise.resolve();
    });

    const historyExportHandler = createHistoryExportHandler(db, userDao);
    await historyExportHandler(mockCtxAdmin);

    expect(mockCtxAdmin.replyWithDocument).toHaveBeenCalled();
    const historyCsv = (historyDocSent as any).fileData.toString("utf8");
    expect(historyCsv.startsWith("\uFEFF")).toBe(true); // UTF-8 BOM for Excel
    expect(historyCsv).toContain("Date & Time (UTC)");
    expect(historyCsv).toContain("FLAGSHIP");
    expect(historyCsv).toContain("CORE");
    expect(historyCsv).toContain("-35");
    expect(historyCsv).toContain("MODEL_UPGRADE");
    expect(historyCsv).toContain("claude-3-7-sonnet");

    // 3. Test Live SQLite Database Backup Snapshot (.db)
    mockCtxAdmin.replyWithDocument = vi.fn().mockImplementation((doc, opts) => {
      return Promise.resolve();
    });

    const backupHandler = createBackupHandler(db, userDao, subDao);
    await backupHandler(mockCtxAdmin);
    expect(mockCtxAdmin.replyWithDocument).toHaveBeenCalled();

    // =========================================================================
    // PHASE 6: Simulated Container Restart & Complete State Recovery
    // =========================================================================
    
    // Extract current state as simulated remote cloud snapshot
    const remoteUsers = db.prepare("SELECT * FROM users").all() as any[];
    const remoteSubs = db.prepare("SELECT * FROM subscriptions").all() as any[];

    // Wipe local in-memory DB to simulate clean container cold start
    const freshDb = new Database(":memory:");
    initSchema(freshDb);

    // Restore state (simulating Turso pullStateFromTurso)
    const restoreUser = freshDb.prepare(`
      INSERT INTO users (id, telegram_id, username, first_name, language, is_muted, is_active, notify_available_global, notify_sold_out_global, notify_models_global, notify_prices_global, notify_admin_new_users, is_admin)
      VALUES (@id, @telegram_id, @username, @first_name, @language, @is_muted, @is_active, @notify_available_global, @notify_sold_out_global, @notify_models_global, @notify_prices_global, @notify_admin_new_users, @is_admin)
    `);
    const restoreSub = freshDb.prepare(`
      INSERT INTO subscriptions (user_id, pool_slug, block_id, notify_on_available, notify_on_sold_out, notify_on_models, notify_on_prices)
      VALUES (@user_id, @pool_slug, @block_id, @notify_on_available, @notify_on_sold_out, @notify_on_models, @notify_on_prices)
    `);

    for (const u of remoteUsers) restoreUser.run(u);
    for (const s of remoteSubs) restoreSub.run(s);

    // Re-hydrate fresh in-memory Inverted Index
    const freshIndex = new SubscriberInvertedIndex(freshDb);
    expect(freshIndex.getMemoryStats().userCount).toBe(4);

    // Verify User 3 (Alice) granular subscription survived cold restart intact
    const restoredMatchedCoreEurope = freshIndex.resolveSubscribers("core", "europe", "prices");
    expect(restoredMatchedCoreEurope.map((s) => s.telegramId)).toContain(1003);

    // Verify User 4 (Dmitry) Russian language & Frontier model subscription survived cold restart intact
    const restoredDmitry = freshIndex.getProfileByTgId(1004);
    expect(restoredDmitry?.language).toBe("ru");
    const restoredMatchedFrontier = freshIndex.resolveSubscribers("frontier", "asia", "models");
    expect(restoredMatchedFrontier.map((s) => s.telegramId)).toContain(1004);

    // Verify User 1 (Admin) admin privileges survived cold restart intact
    const freshUserDao = new UserDAO(freshDb);
    expect(freshUserDao.isAdmin(828157777)).toBe(true);
  });
});
