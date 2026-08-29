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

  it("2. Proportional Star Retention & Admin Immunity: Star donors get +1 day per Star, Admins get infinite immunity", () => {
    const now = Date.now();

    // 1. Admin inactive for 100 days -> Always immune (P0)
    const adminUser = userDao.upsertUser({
      telegram_id: 2001,
      username: "admin_inactive",
      first_name: "Admin",
      language: "uk",
    });
    userDao.setAdmin(2001, true);
    db.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`).run(new Date(now - 100 * 86400 * 1000).toISOString(), adminUser.id);

    // 2. Donor A: 1 Star (Cutoff: 14 + 1 = 15 days) -> Inactive 14.5 days -> INCLUDED
    const donor1StarActive = userDao.upsertUser({
      telegram_id: 2002,
      username: "donor_1_star_active",
      first_name: "Donor1",
      language: "en",
    });
    donationDao.recordDonation(donor1StarActive.id, 2002, 1, "ch_star_1_ok");
    db.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`).run(new Date(now - 14.5 * 86400 * 1000).toISOString(), donor1StarActive.id);

    // 3. Donor B: 1 Star (Cutoff: 14 + 1 = 15 days) -> Inactive 16 days -> EXCLUDED
    const donor1StarExpired = userDao.upsertUser({
      telegram_id: 2003,
      username: "donor_1_star_expired",
      first_name: "Donor1Exp",
      language: "en",
    });
    donationDao.recordDonation(donor1StarExpired.id, 2003, 1, "ch_star_1_exp");
    db.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`).run(new Date(now - 16 * 86400 * 1000).toISOString(), donor1StarExpired.id);

    // 4. Donor C: 50 Stars (Cutoff: 14 + 50 = 64 days) -> Inactive 50 days -> INCLUDED
    const donor50Stars = userDao.upsertUser({
      telegram_id: 2004,
      username: "donor_50_stars",
      first_name: "Donor50",
      language: "uk",
    });
    donationDao.recordDonation(donor50Stars.id, 2004, 50, "ch_star_50_ok");
    db.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`).run(new Date(now - 50 * 86400 * 1000).toISOString(), donor50Stars.id);

    // 5. Free user inactive for 15 days -> EXCLUDED
    const freeUser = userDao.upsertUser({
      telegram_id: 2005,
      username: "free_inactive",
      first_name: "Free",
      language: "uk",
    });
    db.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`).run(new Date(now - 15 * 86400 * 1000).toISOString(), freeUser.id);

    // All 5 subscribe to Frontier Americas
    for (const u of [adminUser, donor1StarActive, donor1StarExpired, donor50Stars, freeUser]) {
      db.exec(`INSERT INTO subscriptions (user_id, pool_slug, block_id, notify_on_available) VALUES (${u.id}, 'frontier', 'americas', 1)`);
    }

    const index = new SubscriberInvertedIndex(db);
    const resolved = index.resolveSubscribers("frontier", "americas", "available");

    // Invariant:
    // [0] Admin (P0) -> tgId: 2001
    // [1] Donor 50 Stars (P1) -> tgId: 2004
    // [2] Donor 1 Star (P1) -> tgId: 2002
    // Excluded: Donor 1 Star expired (2003) and Free user (2005)
    expect(resolved).toHaveLength(3);
    expect(resolved[0].telegramId).toBe(2001); // Admin (P0)
    expect(resolved[0].isAdmin).toBe(true);
    expect(resolved[1].telegramId).toBe(2004); // 50 Stars (P1)
    expect(resolved[1].totalDonatedStars).toBe(50);
    expect(resolved[2].telegramId).toBe(2002); // 1 Star (P1)
    expect(resolved[2].totalDonatedStars).toBe(1);
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
