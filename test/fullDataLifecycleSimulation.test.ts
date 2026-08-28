/**
 * test/fullDataLifecycleSimulation.test.ts
 * Complete End-to-End Simulation of All SQLite Data Fields & User Lifecycle
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/index.js";
import { UserDAO } from "../src/db/dao/users.js";
import { SubscriptionDAO } from "../src/db/dao/subscriptions.js";
import { DonationDAO } from "../src/db/dao/donations.js";
import { PoolStateDAO } from "../src/db/dao/poolState.js";
import { SlotHistoryDAO } from "../src/db/dao/slotHistory.js";
import { CatalogHistoryDAO } from "../src/db/dao/catalogHistory.js";
import { NotificationLogDAO } from "../src/db/dao/notificationLogs.js";
import { ActiveDashboardDAO } from "../src/db/dao/activeDashboards.js";
import { SubscriberInvertedIndex } from "../src/bot/notifier/subscriberIndex.js";
import { NotificationDispatcher } from "../src/bot/notifier/dispatcher.js";
import { NotificationRateLimiter } from "../src/bot/notifier/rateLimiter.js";
import { isUserAdmin } from "../src/config/env.js";

describe("📊 Complete SQLite Data Lifecycle & User Simulation", () => {
  let db: Database.Database;
  let userDao: UserDAO;
  let subDao: SubscriptionDAO;
  let donationDao: DonationDAO;
  let poolStateDao: PoolStateDAO;
  let slotHistoryDao: SlotHistoryDAO;
  let catalogHistoryDao: CatalogHistoryDAO;
  let logDao: NotificationLogDAO;
  let activeDashboardDao: ActiveDashboardDAO;
  let index: SubscriberInvertedIndex;
  let dispatcher: NotificationDispatcher;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);

    userDao = new UserDAO(db);
    subDao = new SubscriptionDAO(db);
    donationDao = new DonationDAO(db);
    poolStateDao = new PoolStateDAO(db);
    slotHistoryDao = new SlotHistoryDAO(db);
    catalogHistoryDao = new CatalogHistoryDAO(db);
    logDao = new NotificationLogDAO(db);
    activeDashboardDao = new ActiveDashboardDAO(db);

    index = new SubscriberInvertedIndex(db);
    const rateLimiter = new NotificationRateLimiter({ targetRatePerSec: 50, maxBurstTokens: 50, userDispatchGapMs: 10 });
    const fakeBot: any = {
      api: {
        sendMessage: async () => ({ message_id: 999 }),
        editMessageText: async () => true,
      },
    };
    dispatcher = new NotificationDispatcher(fakeBot, userDao, logDao, slotHistoryDao, index, rateLimiter);
  });

  it("Simulates complete user journey from first /start to VIP donation, custom subscriptions, and DB restart", async () => {
    const adminTgId = 828157777;
    const donorTgId = 99887766;
    const freeTgId = 11223344;

    // =========================================================================
    // STEP 1: User Registration, Identification, Language & Admin Status
    // =========================================================================
    // 1.1 Admin user registers
    expect(isUserAdmin(adminTgId, userDao, "grizlizora")).toBe(true);
    const adminUser = userDao.upsertUser({
      telegram_id: adminTgId,
      username: "grizlizora",
      first_name: "Роман",
      language: "uk",
    });
    userDao.setAdmin(adminTgId, true);
    userDao.setLanguage(adminTgId, "uk");

    expect(adminUser.telegram_id).toBe(adminTgId);
    expect(adminUser.username).toBe("grizlizora");
    expect(adminUser.first_name).toBe("Роман");
    expect(userDao.isAdmin(adminTgId)).toBe(true);
    expect(userDao.getByTelegramId(adminTgId)?.language).toBe("uk");

    // 1.2 Donor user registers in English
    const donorUser = userDao.upsertUser({
      telegram_id: donorTgId,
      username: "vip_donor",
      first_name: "Victor",
      language: "en",
    });
    userDao.setLanguage(donorTgId, "en");

    // 1.3 Free user registers in Russian
    const freeUser = userDao.upsertUser({
      telegram_id: freeTgId,
      username: "free_user",
      first_name: "Dmitry",
      language: "ru",
    });
    userDao.setLanguage(freeTgId, "ru");

    // =========================================================================
    // STEP 2: Telegram Stars (XTR) Donations & Financial Persistence
    // =========================================================================
    // Donor donates 77 Stars
    const tx1 = donationDao.recordDonation(
      donorUser.id,
      donorTgId,
      77,
      "tg_charge_77_abc",
      "prov_77_xyz"
    );
    expect(tx1.amount_stars).toBe(77);
    expect(donationDao.getUserTotalDonated(donorUser.id)).toBe(77);

    // Donor donates another 500 Stars
    const tx2 = donationDao.recordDonation(
      donorUser.id,
      donorTgId,
      500,
      "tg_charge_500_def",
      "prov_500_xyz"
    );
    expect(tx2.amount_stars).toBe(500);
    expect(donationDao.getUserTotalDonated(donorUser.id)).toBe(577);

    // Verify database accumulation
    const donorInDb = userDao.getByTelegramId(donorTgId);
    expect(donorInDb?.total_donated_stars).toBe(577);

    const recentDonations = donationDao.getRecentDonations(10);
    expect(recentDonations.length).toBe(2);
    const amounts = recentDonations.map((d) => d.amount_stars);
    expect(amounts).toContain(77);
    expect(amounts).toContain(500);

    // =========================================================================
    // STEP 3: Granular Subscriptions & Per-Block / Per-Event Filtering
    // =========================================================================
    // Admin subscribes to Flagship Europe only (Drops + Prices)
    subDao.toggleBlockAndUpdatePool(adminUser.id, "flagship", "europe", ["asia", "europe", "americas"]);
    subDao.togglePoolEventCategory(adminUser.id, "flagship", "models"); // toggle OFF models
    index.updateSubscription(adminUser.id, "flagship", "europe", {
      available: true,
      soldOut: false,
      models: false,
      prices: true,
    });

    // Donor subscribes to ALL pools and ALL blocks (All 4 categories)
    subDao.toggleGlobalWithAllPools(donorUser.id, [
      { slug: "flagship", blocks: ["asia", "europe", "americas"] },
      { slug: "core", blocks: ["asia", "europe", "americas"] },
    ]);
    subDao.togglePoolEventCategory(donorUser.id, "ALL", "sold_out"); // toggle ON sold_out
    index.updateSubscription(donorUser.id, "ALL", "ALL", {
      available: true,
      soldOut: true,
      models: true,
      prices: true,
    });

    // Free user subscribes to Core Asia only (Models only)
    subDao.toggleBlockAndUpdatePool(freeUser.id, "core", "asia", ["asia", "europe", "americas"]);
    subDao.togglePoolEventCategory(freeUser.id, "core", "available"); // toggle OFF available
    index.updateSubscription(freeUser.id, "core", "asia", {
      available: false,
      soldOut: false,
      models: true,
      prices: false,
    });

    // Verify database flags
    const adminFlags = subDao.getPoolFlags(adminUser.id, "flagship");
    expect(adminFlags.available).toBe(true);
    expect(adminFlags.soldOut).toBe(false);
    expect(adminFlags.prices).toBe(true);

    const donorFlags = subDao.getPoolFlags(donorUser.id, "ALL");
    expect(donorFlags.soldOut).toBe(true);
    expect(donorFlags.models).toBe(true);

    // =========================================================================
    // STEP 4: Live Cluster State Snapshots (Compute Pools & Tariffs)
    // =========================================================================
    poolStateDao.saveSnapshot({
      success: true,
      timestamp: Date.now(),
      data: [
        {
          slug: "flagship",
          modelName: "Flagship Supercluster",
          models: ["deepseek-v3", "qwen-2.5-72b", "glm-4-plus", "kimi-k1.5"],
          blocks: [
            { block: "asia", status: "sold-out", pricePerMonth: "99.00", hoursUtc: "00:00 – 08:00 UTC" },
            { block: "europe", status: "available", pricePerMonth: "89.00", hoursUtc: "08:00 – 16:00 UTC" },
            { block: "americas", status: "limited", pricePerMonth: "99.00", hoursUtc: "16:00 – 24:00 UTC" },
          ],
          minPricePerDay: "2.97",
          annualDiscount: 0.20,
          description: "Ultra fast NVLink cluster",
          infraSpec: "8x H100 SXM5",
          manualProvisioning: false,
        },
        {
          slug: "core",
          modelName: "Core Compute",
          models: ["mistral-large", "mimo-v2.5", "minimax-m3"],
          blocks: [
            { block: "asia", status: "available", pricePerMonth: "49.00", hoursUtc: "00:00 – 08:00 UTC" },
          ],
          minPricePerDay: "1.63",
          annualDiscount: 0.15,
          description: "Budget compute",
          infraSpec: "4x A100 80GB",
          manualProvisioning: false,
        },
      ],
    });

    const flagshipBlocks = poolStateDao.getPoolBlocks("flagship");
    expect(flagshipBlocks.length).toBe(3);
    expect(flagshipBlocks[1].status).toBe("available");
    expect(flagshipBlocks[1].price_month).toBe("89.00");
    expect(JSON.parse(flagshipBlocks[0].models_json)).toContain("deepseek-v3");

    // =========================================================================
    // STEP 5: Active LiveSync Dashboard Session Persistence
    // =========================================================================
    activeDashboardDao.upsert({
      chat_id: adminTgId,
      message_id: 7001,
      user_id: adminUser.id,
      view_type: "dashboard",
      pool_slug: undefined,
      language: "uk",
      last_rendered_text: "Dashboard content",
      last_rendered_hash: 123456,
    });

    const sessions = activeDashboardDao.getHydrationCandidates();
    expect(sessions.length).toBe(1);
    expect(sessions[0].message_id).toBe(7001);
    expect(sessions[0].language).toBe("uk");
    expect(sessions[0].view_type).toBe("dashboard");

    // =========================================================================
    // STEP 6: Notification Routing, Prioritization & Log Recording
    // =========================================================================
    // Sync RAM Inverted Index from SQLite
    index.hydrateFromDatabase();

    // Route a Flagship Europe slot drop event
    const matchedUsers = index.resolveSubscribers("flagship", "europe", "available");
    expect(matchedUsers.length).toBe(2); // Admin + Donor (577 Stars)

    // Verify Priority Order: Admin (P0) -> VIP Donor (P1, 577 stars)
    expect(matchedUsers[0].telegramId).toBe(adminTgId);
    expect(matchedUsers[1].telegramId).toBe(donorTgId);
    expect(matchedUsers[1].totalDonatedStars).toBe(577);

    // Record notification log
    logDao.logNotification(adminUser.id, "flagship", "europe", "SLOT_APPEARED");
    logDao.flush();

    expect(logDao.getRecentHourCount()).toBe(1);

    // =========================================================================
    // STEP 7: Cold Restart Invariant (Drop all RAM, re-hydrate from SQLite)
    // =========================================================================
    const freshIndex = new SubscriberInvertedIndex(db);
    const freshStats = freshIndex.getMemoryStats();

    expect(freshStats.userCount).toBe(3);
    expect(freshStats.indexKeys).toBeGreaterThanOrEqual(1);

    const rehydratedDonor = userDao.getByTelegramId(donorTgId);
    expect(rehydratedDonor?.total_donated_stars).toBe(577);
    expect(rehydratedDonor?.language).toBe("en");

    const rehydratedAdmin = userDao.getByTelegramId(adminTgId);
    expect(rehydratedAdmin?.is_admin).toBe(1);
    expect(rehydratedAdmin?.language).toBe("uk");

    const rehydratedFree = userDao.getByTelegramId(freeTgId);
    expect(rehydratedFree?.language).toBe("ru");
    expect(rehydratedFree?.total_donated_stars).toBe(0);
  });
});
