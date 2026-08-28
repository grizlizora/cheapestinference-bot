import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/index.js";
import { UserDAO } from "../src/db/dao/users.js";
import { SubscriptionDAO } from "../src/db/dao/subscriptions.js";
import { SlotHistoryDAO } from "../src/db/dao/slotHistory.js";
import { CatalogHistoryDAO } from "../src/db/dao/catalogHistory.js";
import { SubscriberInvertedIndex } from "../src/bot/notifier/subscriberIndex.js";

describe("Strict Verification: 3-Tier Priority Queue, Granular Event Isolation & Event History Storage", () => {
  let db: Database.Database;
  let userDao: UserDAO;
  let subDao: SubscriptionDAO;
  let slotHistoryDao: SlotHistoryDAO;
  let catalogHistoryDao: CatalogHistoryDAO;
  let index: SubscriberInvertedIndex;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);

    userDao = new UserDAO(db);
    subDao = new SubscriptionDAO(db);
    slotHistoryDao = new SlotHistoryDAO(db);
    catalogHistoryDao = new CatalogHistoryDAO(db);
    index = new SubscriberInvertedIndex(db);
  });

  it("1. Strictly enforces 3-Tier Priority Ordering (P0 Admin -> P1 Top Donors DESC -> P2 Free Users by activity)", () => {
    // Setup 5 test users
    // 1. Admin (P0)
    const admin = userDao.upsertUser({ telegram_id: 828157777, username: "admin_roman", first_name: "Roman" });
    userDao.setAdmin(828157777, true);

    // 2. Big Donor 500 Stars (P1)
    const bigDonor = userDao.upsertUser({ telegram_id: 10001, username: "big_donor", first_name: "Whale" });
    db.prepare("UPDATE users SET total_donated_stars = 500 WHERE id = ?").run(bigDonor.id);

    // 3. Small Donor 50 Stars (P1)
    const smallDonor = userDao.upsertUser({ telegram_id: 10002, username: "small_donor", first_name: "Supporter" });
    db.prepare("UPDATE users SET total_donated_stars = 50 WHERE id = ?").run(smallDonor.id);

    // 4. Recently Active Free User (P2)
    const activeFree = userDao.upsertUser({ telegram_id: 10003, username: "active_free", first_name: "Active" });
    db.prepare("UPDATE users SET last_active_at = datetime('now', '-5 minutes') WHERE id = ?").run(activeFree.id);

    // 5. Inactive Free User (P2)
    const inactiveFree = userDao.upsertUser({ telegram_id: 10004, username: "inactive_free", first_name: "Inactive" });
    db.prepare("UPDATE users SET last_active_at = datetime('now', '-2 days') WHERE id = ?").run(inactiveFree.id);

    // All 5 users subscribe to flagship europe available
    for (const u of [admin, bigDonor, smallDonor, activeFree, inactiveFree]) {
      subDao.toggleBlockAndUpdatePool(u.id, "flagship", "europe", ["asia", "europe", "americas"]);
    }

    // Hydrate index
    index.hydrateFromDatabase();

    // Resolve subscribers for slot appearance
    const queue = index.resolveSubscribers("flagship", "europe", "available");

    expect(queue.length).toBe(5);

    // Exact mathematical ordering verified:
    expect(queue[0].telegramId).toBe(828157777); // P0: Admin (0ms first)
    expect(queue[1].telegramId).toBe(10001);     // P1: Big Donor (500 Stars)
    expect(queue[2].telegramId).toBe(10002);     // P1: Small Donor (50 Stars)
    expect(queue[3].telegramId).toBe(10003);     // P2: Active Free User (5m ago)
    expect(queue[4].telegramId).toBe(10004);     // P2: Inactive Free User (2d ago)
  });

  it("2. Strictly isolates granular event categories (Available vs SoldOut vs Models vs Prices)", () => {
    const u1 = userDao.upsertUser({ telegram_id: 201, username: "user_avail", first_name: "AvailOnly" });
    const u2 = userDao.upsertUser({ telegram_id: 202, username: "user_price", first_name: "PriceOnly" });
    const u3 = userDao.upsertUser({ telegram_id: 203, username: "user_models", first_name: "ModelsOnly" });
    const u4 = userDao.upsertUser({ telegram_id: 204, username: "user_core_asia", first_name: "CoreAsiaOnly" });

    // User 1: Flagship Europe -> ONLY Available
    subDao.toggleBlockAndUpdatePool(u1.id, "flagship", "europe", ["asia", "europe", "americas"]);
    subDao.togglePoolEventCategory(u1.id, "flagship", "models"); // turn off models
    subDao.togglePoolEventCategory(u1.id, "flagship", "prices"); // turn off prices

    // User 2: Flagship Europe -> ONLY Prices
    subDao.toggleBlockAndUpdatePool(u2.id, "flagship", "europe", ["asia", "europe", "americas"]);
    subDao.togglePoolEventCategory(u2.id, "flagship", "available"); // turn off avail
    subDao.togglePoolEventCategory(u2.id, "flagship", "models"); // turn off models

    // User 3: Flagship ALL blocks -> ONLY Models
    subDao.togglePoolWithBlocks(u3.id, "flagship", ["asia", "europe", "americas"]);
    subDao.togglePoolEventCategory(u3.id, "flagship", "available"); // turn off avail
    subDao.togglePoolEventCategory(u3.id, "flagship", "prices"); // turn off prices

    // User 4: Core Asia -> ONLY Available
    subDao.toggleBlockAndUpdatePool(u4.id, "core", "asia", ["asia", "europe", "americas"]);

    index.hydrateFromDatabase();

    // Test A: Slot appears on Flagship Europe -> ONLY User 1 receives it!
    const availSubs = index.resolveSubscribers("flagship", "europe", "available");
    expect(availSubs.map((u) => u.telegramId)).toEqual([201]);

    // Test B: Price changes on Flagship Europe -> ONLY User 2 receives it!
    const priceSubs = index.resolveSubscribers("flagship", "europe", "prices");
    expect(priceSubs.map((u) => u.telegramId)).toEqual([202]);

    // Test C: Models updated on Flagship -> ONLY User 3 receives it!
    const modelSubs = index.resolveSubscribers("flagship", "ALL", "models");
    expect(modelSubs.map((u) => u.telegramId)).toEqual([203]);

    // Test D: Slot appears on Core Asia -> ONLY User 4 receives it!
    const coreSubs = index.resolveSubscribers("core", "asia", "available");
    expect(coreSubs.map((u) => u.telegramId)).toEqual([204]);
  });

  it("3. Accurately records slot and catalog lifecycle history in SQLite for predictive duration & ATL analytics", () => {
    // 1. Simulate slot opening and closing
    slotHistoryDao.recordSlotOpened("flagship", "europe", "available", "$89");
    const active = slotHistoryDao.getActiveSlot("flagship", "europe");
    expect(active).toBeDefined();
    expect(active?.initial_status).toBe("available");
    expect(active?.price_month).toBe("$89");

    // Close slot after 12 minutes (720 seconds)
    db.prepare(`
      UPDATE slot_lifecycle_history 
      SET opened_at = datetime('now', '-720 seconds') 
      WHERE pool_slug = 'flagship' AND block_id = 'europe'
    `).run();
    slotHistoryDao.recordSlotClosed("flagship", "europe");

    const analytics = slotHistoryDao.getSlotAnalytics("flagship", "europe");
    expect(analytics.totalOpenings).toBe(1);
    expect(analytics.demandCategory).toBe("hot"); // <= 1800s is classified as HOT slot!
    expect(analytics.avgDurationFormatted).toContain("12 min");

    // 2. Simulate historical price drops
    catalogHistoryDao.recordSlotPriceChange("flagship", "europe", "$99", "$89", -10, -10.1);
    catalogHistoryDao.recordSlotPriceChange("flagship", "europe", "$89", "$79", -10, -11.2);
    catalogHistoryDao.recordSlotPriceChange("flagship", "europe", "$79", "$69", -10, -12.6);

    const priceAnalytics = catalogHistoryDao.getPriceAnalytics("flagship", "europe", 69);
    expect(priceAnalytics.sampleCount).toBe(3);
    expect(priceAnalytics.minPrice).toBe(69);
    expect(priceAnalytics.rating).toBe("all_time_low"); // Correctly evaluated as historical minimum ATL!
  });
});
