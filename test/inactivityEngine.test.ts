import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { UserDAO } from "../src/db/dao/users.js";
import { DonationDAO } from "../src/db/dao/donations.js";
import { SubscriberInvertedIndex, FREE_USER_INACTIVITY_LIMIT_MS } from "../src/bot/notifier/subscriberIndex.js";
import { initSchema } from "../src/db/index.js";

describe("14-Day Inactivity Engine & Dormant User Alert Filtering Invariants", () => {
  let db: Database.Database;
  let userDao: UserDAO;
  let donationDao: DonationDAO;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    userDao = new UserDAO(db);
    donationDao = new DonationDAO(db);
  });

  it("1. Free User Dormancy: Omits free users inactive for > 14 days and includes users active within 14 days", () => {
    const now = Date.now();
    const active13DaysAgo = new Date(now - 13 * 86400 * 1000).toISOString();
    const inactive15DaysAgo = new Date(now - 15 * 86400 * 1000).toISOString();

    const activeUser = userDao.upsertUser({
      telegram_id: 1001,
      username: "active_user",
      first_name: "Active",
      language: "uk",
    });
    db.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`).run(active13DaysAgo, activeUser.id);

    const dormantUser = userDao.upsertUser({
      telegram_id: 1002,
      username: "dormant_user",
      first_name: "Dormant",
      language: "en",
    });
    db.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`).run(inactive15DaysAgo, dormantUser.id);

    // Both subscribe to Flagship Europe available
    db.exec(`INSERT INTO subscriptions (user_id, pool_slug, block_id, notify_on_available) VALUES (${activeUser.id}, 'flagship', 'europe', 1)`);
    db.exec(`INSERT INTO subscriptions (user_id, pool_slug, block_id, notify_on_available) VALUES (${dormantUser.id}, 'flagship', 'europe', 1)`);

    const index = new SubscriberInvertedIndex(db);
    const resolved = index.resolveSubscribers("flagship", "europe", "available");

    // Invariant: Only active user (13 days ago) is returned; dormant (15 days ago) is filtered out
    expect(resolved).toHaveLength(1);
    expect(resolved[0].telegramId).toBe(1001);
  });

  it("2. Admin & Donor Immunity: Admins and VIP Donors are NOT filtered by the 14-day rule", () => {
    const now = Date.now();
    const inactive40DaysAgo = new Date(now - 40 * 86400 * 1000).toISOString();

    // Admin inactive for 40 days
    const adminUser = userDao.upsertUser({
      telegram_id: 2001,
      username: "admin_inactive",
      first_name: "Admin",
      language: "uk",
    });
    userDao.setAdmin(2001, true);
    db.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`).run(inactive40DaysAgo, adminUser.id);

    // Donor (50 Stars) inactive for 40 days
    const donorUser = userDao.upsertUser({
      telegram_id: 2002,
      username: "donor_inactive",
      first_name: "Donor",
      language: "en",
    });
    donationDao.recordDonation(donorUser.id, 2002, 50, "ch_star_immunity_50");
    db.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`).run(inactive40DaysAgo, donorUser.id);

    // Free user inactive for 40 days
    const freeUser = userDao.upsertUser({
      telegram_id: 2003,
      username: "free_inactive",
      first_name: "Free",
      language: "uk",
    });
    db.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`).run(inactive40DaysAgo, freeUser.id);

    // All 3 subscribe to Frontier Americas
    for (const u of [adminUser, donorUser, freeUser]) {
      db.exec(`INSERT INTO subscriptions (user_id, pool_slug, block_id, notify_on_available) VALUES (${u.id}, 'frontier', 'americas', 1)`);
    }

    const index = new SubscriberInvertedIndex(db);
    const resolved = index.resolveSubscribers("frontier", "americas", "available");

    // Invariant: Admin (P0) and Donor (P1) are present, Free user is filtered out
    expect(resolved).toHaveLength(2);
    expect(resolved[0].telegramId).toBe(2001); // Admin
    expect(resolved[0].isAdmin).toBe(true);
    expect(resolved[1].telegramId).toBe(2002); // Donor
    expect(resolved[1].totalDonatedStars).toBe(50);
  });

  it("3. Instant Zero-Loss Revival: Interacting with bot resets lastActiveAt and immediately restores dispatch", () => {
    const now = Date.now();
    const inactive20DaysAgo = new Date(now - 20 * 86400 * 1000).toISOString();

    const dormantUser = userDao.upsertUser({
      telegram_id: 3001,
      username: "revived_user",
      first_name: "Revived",
      language: "uk",
    });
    db.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`).run(inactive20DaysAgo, dormantUser.id);
    db.exec(`INSERT INTO subscriptions (user_id, pool_slug, block_id, notify_on_available) VALUES (${dormantUser.id}, 'core', 'asia', 1)`);

    const index = new SubscriberInvertedIndex(db);

    // Phase 1: Dormant -> 0 results
    expect(index.resolveSubscribers("core", "asia", "available")).toHaveLength(0);

    // Phase 2: User taps /start or opens menu -> InvertedIndex updates in RAM
    index.updateUserPreferences(3001, {
      lastActiveAt: Date.now(),
      isActive: true,
    });

    // Phase 3: Instant Revival -> 1 result with all subscription filters preserved
    const revivedResolved = index.resolveSubscribers("core", "asia", "available");
    expect(revivedResolved).toHaveLength(1);
    expect(revivedResolved[0].telegramId).toBe(3001);
  });
});
