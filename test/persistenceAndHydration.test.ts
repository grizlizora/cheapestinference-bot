import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initDatabase } from "../src/db/index.js";
import { UserDAO } from "../src/db/dao/users.js";
import { SubscriptionDAO } from "../src/db/dao/subscriptions.js";
import { SubscriberInvertedIndex } from "../src/bot/notifier/subscriberIndex.js";

describe("Subscription Persistence, Default Onboarding & Cold-Boot Hydration", () => {
  let db: Database.Database;
  let userDao: UserDAO;
  let subDao: SubscriptionDAO;

  beforeEach(() => {
    db = new Database(":memory:");
    initDatabase(db);
    userDao = new UserDAO(db);
    subDao = new SubscriptionDAO(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates default subscriptions and hydrates them on cold reboot", () => {
    // 1. User registers
    const user = userDao.upsertUser({
      telegram_id: 111222333,
      username: "testuser",
      first_name: "Test",
      language: "uk",
    });

    subDao.createDefaultSubscriptions(user.id);

    const subs = subDao.getUserSubscriptions(user.id);
    expect(subs.length).toBeGreaterThan(5); // ALL:ALL + 3 pools + 9 blocks

    const flagshipSub = subDao.getSubscription(user.id, "flagship", "ALL");
    expect(flagshipSub?.notify_on_available).toBe(1);
    expect(flagshipSub?.notify_on_sold_out).toBe(0); // Sold out is 0 by default
    expect(flagshipSub?.notify_on_models).toBe(1);
    expect(flagshipSub?.notify_on_prices).toBe(1);

    // 2. Hydrate InvertedIndex from DB (simulating cold bot start)
    const invertedIndex = new SubscriberInvertedIndex(db);
    invertedIndex.hydrateFromDatabase();

    // 3. Verify user matches slot available drop for Flagship Asia
    const matched = invertedIndex.resolveSubscribers("flagship", "asia", "available");
    expect(matched.some((p) => p.telegramId === 111222333)).toBe(true);

    // Verify user does NOT receive sold_out notification by default
    const matchedSoldOut = invertedIndex.resolveSubscribers("flagship", "asia", "sold_out");
    expect(matchedSoldOut.some((p) => p.telegramId === 111222333)).toBe(false);
  });

  it("persists granular per-pool event filter updates across restart", () => {
    const user = userDao.upsertUser({
      telegram_id: 444555666,
      username: "filteruser",
      first_name: "Filter",
      language: "en",
    });

    subDao.createDefaultSubscriptions(user.id);

    // User explicitly turns ON sold_out notifications for Flagship
    subDao.togglePoolEventCategory(user.id, "flagship", "sold_out");

    const updatedFlags = subDao.getPoolFlags(user.id, "flagship");
    expect(updatedFlags.soldOut).toBe(true);

    // Simulate bot restart & rehydration
    const newIndex = new SubscriberInvertedIndex(db);
    newIndex.hydrateFromDatabase();

    const matchedSoldOut = newIndex.resolveSubscribers("flagship", "europe", "sold_out");
    expect(matchedSoldOut.some((p) => p.telegramId === 444555666)).toBe(true);
  });
});
