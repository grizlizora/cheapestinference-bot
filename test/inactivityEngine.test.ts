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

  it("2. Progressive Tiered Star Booster & Recency Decay Invariants", () => {
    const now = Date.now();

    // 1. Admin inactive for 500 days -> Infinite Immunity (P0)
    const adminUser = userDao.upsertUser({
      telegram_id: 2001,
      username: "admin_inactive",
      first_name: "Admin",
      language: "uk",
    });
    userDao.setAdmin(2001, true);
    db.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`).run(new Date(now - 500 * 86400 * 1000).toISOString(), adminUser.id);

    // 2. Micro-donor (5 Stars, donated 5 days ago):
    // Raw bonus: 5 * 2.0 = 10 days. Recency <= 30d -> factor 1.0. Total: 14 + 10 = 24 days.
    // Inactive 20 days -> INCLUDED (20 <= 24)
    const donorMicro = userDao.upsertUser({
      telegram_id: 2002,
      username: "donor_micro",
      first_name: "MicroDonor",
      language: "en",
    });
    donationDao.recordDonation(donorMicro.id, 2002, 5, "ch_star_micro");
    db.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`).run(new Date(now - 20 * 86400 * 1000).toISOString(), donorMicro.id);

    // 3. Coffee donor (15 Stars, donated 20 days ago):
    // Raw bonus: 15 * 2.0 = 30 days. Recency <= 30d -> factor 1.0. Total: 14 + 30 = 44 days.
    // Inactive 40 days -> INCLUDED (40 <= 44)
    const donorCoffee = userDao.upsertUser({
      telegram_id: 2003,
      username: "donor_coffee",
      first_name: "Coffee",
      language: "en",
    });
    donationDao.recordDonation(donorCoffee.id, 2003, 15, "ch_star_coffee");
    db.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`).run(new Date(now - 40 * 86400 * 1000).toISOString(), donorCoffee.id);

    // 4. Large Donor 500 Stars (donated 200 days ago -> 180-360d range, factor 0.50):
    // Raw bonus: 452.5 days. With factor 0.50 -> 226.25 days. Total: 14 + 226.25 = 240.25 days.
    // Inactive 210 days -> INCLUDED (210 <= 240.25)
    const donor500Recent = userDao.upsertUser({
      telegram_id: 2004,
      username: "donor_500_half_year",
      first_name: "Donor500Recent",
      language: "uk",
    });
    donationDao.recordDonation(donor500Recent.id, 2004, 500, "ch_star_500_rec");
    db.prepare(`UPDATE donations SET created_at = ? WHERE user_id = ?`).run(new Date(now - 200 * 86400 * 1000).toISOString(), donor500Recent.id);
    db.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`).run(new Date(now - 210 * 86400 * 1000).toISOString(), donor500Recent.id);

    // 5. Very Old 500 Stars Donor (donated 800 days ago -> >2 years / 730d, factor 0.20):
    // Raw bonus: 452.5 days * 0.20 = 90.5 days. Total: 14 + 90.5 = 104.5 days.
    // Inactive 120 days -> EXCLUDED (120 > 104.5)
    const donor500Ancient = userDao.upsertUser({
      telegram_id: 2005,
      username: "donor_500_ancient",
      first_name: "Donor500Ancient",
      language: "uk",
    });
    donationDao.recordDonation(donor500Ancient.id, 2005, 500, "ch_star_500_anc");
    db.prepare(`UPDATE donations SET created_at = ? WHERE user_id = ?`).run(new Date(now - 800 * 86400 * 1000).toISOString(), donor500Ancient.id);
    db.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`).run(new Date(now - 120 * 86400 * 1000).toISOString(), donor500Ancient.id);

    // 6. Free user inactive for 16 days -> EXCLUDED (16 > 14)
    const freeUser = userDao.upsertUser({
      telegram_id: 2006,
      username: "free_inactive",
      first_name: "Free",
      language: "uk",
    });
    db.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`).run(new Date(now - 16 * 86400 * 1000).toISOString(), freeUser.id);

    // All 6 subscribe to Frontier Americas
    for (const u of [adminUser, donorMicro, donorCoffee, donor500Recent, donor500Ancient, freeUser]) {
      db.exec(`INSERT INTO subscriptions (user_id, pool_slug, block_id, notify_on_available) VALUES (${u.id}, 'frontier', 'americas', 1)`);
    }

    const index = new SubscriberInvertedIndex(db);
    const resolved = index.resolveSubscribers("frontier", "americas", "available");

    // Invariant:
    // [0] Admin (P0) -> tgId: 2001
    // [1] Donor 500 Stars (P1) -> tgId: 2004
    // [2] Donor 15 Stars (P1) -> tgId: 2003
    // [3] Donor 5 Stars (P1) -> tgId: 2002
    // Excluded: Donor 500 ancient expired (2005) and Free user (2006)
    expect(resolved).toHaveLength(4);
    expect(resolved[0].telegramId).toBe(2001); // Admin (P0)
    expect(resolved[0].isAdmin).toBe(true);
    expect(resolved[1].telegramId).toBe(2004); // 500 Stars
    expect(resolved[1].totalDonatedStars).toBe(500);
    expect(resolved[2].telegramId).toBe(2003); // 15 Stars
    expect(resolved[2].totalDonatedStars).toBe(15);
    expect(resolved[3].telegramId).toBe(2002); // 5 Stars
    expect(resolved[3].totalDonatedStars).toBe(5);
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
