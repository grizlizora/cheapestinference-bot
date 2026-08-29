/**
 * test/realWorldInactivityAndDonorImmunityLifecycle.test.ts
 * 100% Realistic End-to-End Simulation:
 * - 14-Day Inactivity Rule for Free Users
 * - Progressive Multi-Tier Star Donation Retention (1-15x2.0, 16-50x1.5, 51-100x1.0, 101-500x0.8, >500x0.5)
 * - Recency Decay Freshness Factors (<=30d 1.0, 31-90d 0.85, 91-180d 0.70, 181-360d 0.50, 361-730d 0.35, >730d 0.20)
 * - Infinite Admin Lifetime Immunity
 * - 3-Tier Priority Queue Ordering (Admins -> Top Donors -> Free Active Users)
 * - Instant Zero-Loss Revival on User Touch
 * - Dynamic Any-User Context Resolution
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/index.js";
import { UserDAO } from "../src/db/dao/users.js";
import { SubscriptionDAO } from "../src/db/dao/subscriptions.js";
import { DonationDAO } from "../src/db/dao/donations.js";
import {
  SubscriberInvertedIndex,
  calculateStarBonusDays,
  calculateRecencyDecayFactor,
  computeAdaptiveInactivityLimitMs,
  ONE_DAY_MS,
} from "../src/bot/notifier/subscriberIndex.js";

describe("🌟 Real-World Inactivity, Star Donation Formula & Admin Immunity Simulation", () => {
  let db: Database.Database;
  let userDao: UserDAO;
  let subDao: SubscriptionDAO;
  let donDao: DonationDAO;
  let invertedIndex: SubscriberInvertedIndex;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    userDao = new UserDAO(db);
    subDao = new SubscriptionDAO(db);
    donDao = new DonationDAO(db);
  });

  it("1. Mathematical Verification: Progressive Star Booster & Recency Decay Factors", () => {
    // Tier 1: 1-15 Stars (x2.0)
    expect(calculateStarBonusDays(1)).toBe(2);
    expect(calculateStarBonusDays(15)).toBe(30);

    // Tier 2: 16-50 Stars (15*2.0 + 35*1.5 = 30 + 52.5 = 82.5 days)
    expect(calculateStarBonusDays(50)).toBe(82.5);

    // Tier 3: 51-100 Stars (82.5 + 50*1.0 = 132.5 days)
    expect(calculateStarBonusDays(100)).toBe(132.5);

    // Tier 4: 101-500 Stars (132.5 + 400*0.8 = 452.5 days)
    expect(calculateStarBonusDays(500)).toBe(452.5);

    // Tier 5: >500 Stars (452.5 + 500*0.5 = 702.5 days)
    expect(calculateStarBonusDays(1000)).toBe(702.5);

    // Recency Decay Factors
    expect(calculateRecencyDecayFactor(10)).toBe(1.0);     // <= 30 days
    expect(calculateRecencyDecayFactor(60)).toBe(0.85);    // 31 - 90 days
    expect(calculateRecencyDecayFactor(120)).toBe(0.70);   // 91 - 180 days
    expect(calculateRecencyDecayFactor(250)).toBe(0.50);   // 181 - 360 days (1 year)
    expect(calculateRecencyDecayFactor(500)).toBe(0.35);   // 361 - 730 days (1 - 2 years)
    expect(calculateRecencyDecayFactor(800)).toBe(0.20);   // > 730 days (2+ years)
  });

  it("2. Complete End-to-End User Dispatch Lifecycle with 7 Realistic Arbitrary Users", () => {
    const now = Date.now();

    // Helper to format SQLite datetime strings in deterministic UTC
    const toSqliteUtc = (ts: number) => new Date(ts).toISOString().replace("T", " ").substring(0, 19);

    // User A: Admin with 0 stars, inactive for 300 days -> IMMUNITY (P0)
    const adminUser = userDao.upsertUser({
      telegram_id: 100001,
      first_name: "SuperAdmin",
      username: "admin_user",
      language: "uk",
    });
    userDao.setAdmin(adminUser.telegram_id, true);
    db.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").run(
      toSqliteUtc(now - 300 * ONE_DAY_MS),
      adminUser.id
    );

    // User B: Active Free User (active 5 days ago <= 14 days) -> INCLUDED (P2)
    const activeFreeUser = userDao.upsertUser({
      telegram_id: 200002,
      first_name: "Alice",
      username: "alice_active",
      language: "en",
    });
    db.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").run(
      toSqliteUtc(now - 5 * ONE_DAY_MS),
      activeFreeUser.id
    );

    // User C: Dormant Free User (active 18 days ago > 14 days) -> SUSPENDED (EXCLUDED)
    const dormantFreeUser = userDao.upsertUser({
      telegram_id: 300003,
      first_name: "Bob",
      username: "bob_dormant",
      language: "ru",
    });
    db.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").run(
      toSqliteUtc(now - 18 * ONE_DAY_MS),
      dormantFreeUser.id
    );

    // User D: Micro Donor (15 Stars donated 10 days ago, active 35 days ago)
    // Limit = 14 + 15*2.0*1.0 = 44 days. Active 35d <= 44d -> INCLUDED (P1)
    const microDonor = userDao.upsertUser({
      telegram_id: 400004,
      first_name: "Charlie",
      username: "charlie_donor",
      language: "uk",
    });
    donDao.recordDonation(microDonor.id, microDonor.telegram_id, 15, "chg_micro_15", null, "XTR");
    db.prepare("UPDATE donations SET created_at = ? WHERE user_id = ?").run(
      toSqliteUtc(now - 10 * ONE_DAY_MS),
      microDonor.id
    );
    db.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").run(
      toSqliteUtc(now - 35 * ONE_DAY_MS),
      microDonor.id
    );

    // User E: Coffee Donor (50 Stars donated 60 days ago, active 80 days ago)
    // Bonus = 82.5d * 0.85 = 70.125d. Limit = 14 + 70.125 = 84.125 days. Active 80d <= 84.125d -> INCLUDED (P1)
    const coffeeDonor = userDao.upsertUser({
      telegram_id: 500005,
      first_name: "Diana",
      username: "diana_coffee",
      language: "en",
    });
    donDao.recordDonation(coffeeDonor.id, coffeeDonor.telegram_id, 50, "chg_coffee_50", null, "XTR");
    db.prepare("UPDATE donations SET created_at = ? WHERE user_id = ?").run(
      toSqliteUtc(now - 60 * ONE_DAY_MS),
      coffeeDonor.id
    );
    db.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").run(
      toSqliteUtc(now - 80 * ONE_DAY_MS),
      coffeeDonor.id
    );

    // User F: Veteran Patron (500 Stars donated 800 days ago > 2 years, active 95 days ago)
    // Bonus = 452.5d * 0.20 = 90.5d. Limit = 14 + 90.5 = 104.5 days. Active 95d <= 104.5d -> INCLUDED (P1)
    const veteranDonor = userDao.upsertUser({
      telegram_id: 600006,
      first_name: "Edward",
      username: "edward_patron",
      language: "uk",
    });
    donDao.recordDonation(veteranDonor.id, veteranDonor.telegram_id, 500, "chg_patron_500", null, "XTR");
    db.prepare("UPDATE donations SET created_at = ? WHERE user_id = ?").run(
      toSqliteUtc(now - 800 * ONE_DAY_MS),
      veteranDonor.id
    );
    db.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").run(
      toSqliteUtc(now - 95 * ONE_DAY_MS),
      veteranDonor.id
    );

    // User G: Expired Micro Donor (5 Stars donated 500 days ago, active 30 days ago)
    // Bonus = 10d * 0.35 = 3.5d. Limit = 14 + 3.5 = 17.5 days. Active 30d > 17.5d -> SUSPENDED (EXCLUDED)
    const expiredDonor = userDao.upsertUser({
      telegram_id: 700007,
      first_name: "Fiona",
      username: "fiona_expired",
      language: "en",
    });
    donDao.recordDonation(expiredDonor.id, expiredDonor.telegram_id, 5, "chg_expired_5", null, "XTR");
    db.prepare("UPDATE donations SET created_at = ? WHERE user_id = ?").run(
      toSqliteUtc(now - 500 * ONE_DAY_MS),
      expiredDonor.id
    );
    db.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").run(
      toSqliteUtc(now - 30 * ONE_DAY_MS),
      expiredDonor.id
    );

    // Subscribe all 7 users to flagship:asia:available
    subDao.toggleSubscription(adminUser.id, "flagship", "asia");
    subDao.toggleSubscription(activeFreeUser.id, "flagship", "asia");
    subDao.toggleSubscription(dormantFreeUser.id, "flagship", "asia");
    subDao.toggleSubscription(microDonor.id, "flagship", "asia");
    subDao.toggleSubscription(coffeeDonor.id, "flagship", "asia");
    subDao.toggleSubscription(veteranDonor.id, "flagship", "asia");
    subDao.toggleSubscription(expiredDonor.id, "flagship", "asia");

    // Hydrate Inverted Index from SQLite
    invertedIndex = new SubscriberInvertedIndex(db, userDao, subDao);

    // Match subscribers for live slot availability alert
    const matched = invertedIndex.resolveSubscribers("flagship", "asia", "available");

    // Verified Invariant 1: Exactly 5 eligible users returned; 2 dormant users excluded
    expect(matched).toHaveLength(5);
    const matchedIds = matched.map((m) => m.telegramId);

    // Excluded check: Bob (dormant free 18d) and Fiona (expired 5-star donor 30d) are excluded
    expect(matchedIds).not.toContain(300003);
    expect(matchedIds).not.toContain(700007);

    // Verified Invariant 2: Strict 3-Tier Priority Order:
    // [0] Admin (100001)
    // [1] Veteran Donor 500 Stars (600006)
    // [2] Coffee Donor 50 Stars (500005)
    // [3] Micro Donor 15 Stars (400004)
    // [4] Active Free User (200002)
    expect(matched[0].telegramId).toBe(100001); // Admin P0
    expect(matched[1].telegramId).toBe(600006); // 500 Stars P1
    expect(matched[2].telegramId).toBe(500005); // 50 Stars P1
    expect(matched[3].telegramId).toBe(400004); // 15 Stars P1
    expect(matched[4].telegramId).toBe(200002); // Free User P2

    // =========================================================================
    // 3. ZERO-LOSS INSTANT REVIVAL: Dormant user Bob touches the bot
    // =========================================================================
    // Bob sends /start or clicks a button
    invertedIndex.touchLastActive(dormantFreeUser.telegram_id);

    // Re-query dispatch candidates
    const revivedMatched = invertedIndex.resolveSubscribers("flagship", "asia", "available");
    expect(revivedMatched).toHaveLength(6);

    // Bob is immediately back in the delivery queue at the head of the free tier!
    const revivedIds = revivedMatched.map((m) => m.telegramId);
    expect(revivedIds).toContain(300003);
    expect(revivedMatched[4].telegramId).toBe(300003); // Bob was active just now, placed before Alice
    expect(revivedMatched[5].telegramId).toBe(200002); // Alice was active 5 days ago
  });
});
