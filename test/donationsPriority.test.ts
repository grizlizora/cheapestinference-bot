import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { DonationDAO } from "../src/db/dao/donations.js";
import { UserDAO } from "../src/db/dao/users.js";
import { SubscriberInvertedIndex } from "../src/bot/notifier/subscriberIndex.js";

describe("Donation System & Priority Notification Invariants", () => {
  let db: Database.Database;
  let userDao: UserDAO;
  let donationDao: DonationDAO;

  beforeEach(() => {
    db = new Database(":memory:");
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
        is_admin INTEGER NOT NULL DEFAULT 0,
        total_donated_stars INTEGER NOT NULL DEFAULT 0,
        last_active_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE donations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        telegram_id INTEGER NOT NULL,
        amount_stars INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'XTR',
        telegram_payment_charge_id TEXT NOT NULL UNIQUE,
        provider_payment_charge_id TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    userDao = new UserDAO(db);
    donationDao = new DonationDAO(db);
  });

  it("should record confirmed donations idempotently and update user total stars", () => {
    const user = userDao.upsertUser({
      telegram_id: 111,
      username: "donor_one",
      first_name: "Donor",
      language: "uk",
    });

    // Initial state: 0 stars
    expect(donationDao.getUserTotalDonated(user.id)).toBe(0);

    // 1. First donation: 50 Stars
    const don1 = donationDao.recordDonation(user.id, 111, 50, "charge_001_abc");
    expect(don1.amount_stars).toBe(50);
    expect(donationDao.getUserTotalDonated(user.id)).toBe(50);

    // Verify user table total_donated_stars column
    const updatedUser = userDao.getByTelegramId(111);
    expect(updatedUser?.total_donated_stars).toBe(50);

    // 2. Duplicate webhook protection (Idempotency): Same charge ID should not double-count
    const donDuplicate = donationDao.recordDonation(user.id, 111, 50, "charge_001_abc");
    expect(donDuplicate.id).toBe(don1.id);
    expect(donationDao.getUserTotalDonated(user.id)).toBe(50);
    expect(userDao.getByTelegramId(111)?.total_donated_stars).toBe(50);

    // 3. Second real donation: 250 Stars
    donationDao.recordDonation(user.id, 111, 250, "charge_002_xyz");
    expect(donationDao.getUserTotalDonated(user.id)).toBe(300);
    expect(userDao.getByTelegramId(111)?.total_donated_stars).toBe(300);
    expect(donationDao.getGlobalTotalDonated()).toBe(300);
  });

  it("should accurately rank top donators across multiple users", () => {
    const u1 = userDao.upsertUser({ telegram_id: 201, username: "alice", first_name: "Alice", language: "en" });
    const u2 = userDao.upsertUser({ telegram_id: 202, username: "bob", first_name: "Bob", language: "uk" });
    const u3 = userDao.upsertUser({ telegram_id: 203, username: "charlie", first_name: "Charlie", language: "ru" });

    donationDao.recordDonation(u1.id, 201, 15, "ch_1");
    donationDao.recordDonation(u2.id, 202, 500, "ch_2");
    donationDao.recordDonation(u3.id, 203, 100, "ch_3");

    const top = donationDao.getTopDonators(10);
    expect(top).toHaveLength(3);
    expect(top[0].username).toBe("bob");
    expect(top[0].total_stars).toBe(500);

    expect(top[1].username).toBe("charlie");
    expect(top[1].total_stars).toBe(100);

    expect(top[2].username).toBe("alice");
    expect(top[2].total_stars).toBe(15);
  });

  it("should dynamically elevate user notification priority in SubscriberInvertedIndex upon payment", () => {
    // Register 2 users subscribed to Flagship Asia
    const freeUser = userDao.upsertUser({ telegram_id: 301, username: "free_guy", first_name: "Free", language: "uk" });
    const donorUser = userDao.upsertUser({ telegram_id: 302, username: "donor_guy", first_name: "Donor", language: "uk" });

    db.exec(`INSERT INTO subscriptions (user_id, pool_slug, block_id) VALUES (${freeUser.id}, 'flagship', 'asia')`);
    db.exec(`INSERT INTO subscriptions (user_id, pool_slug, block_id) VALUES (${donorUser.id}, 'flagship', 'asia')`);

    const invertedIndex = new SubscriberInvertedIndex(db);

    // Initial state: Both have 0 stars, freeUser was touched more recently
    invertedIndex.updateUserPreferences(301, { lastActiveAt: Date.now() });
    invertedIndex.updateUserPreferences(302, { lastActiveAt: Date.now() - 10000 });

    let resolved = invertedIndex.resolveSubscribers("flagship", "asia", "available");
    expect(resolved[0].telegramId).toBe(301);
    expect(resolved[1].telegramId).toBe(302);

    // Now donorUser donates 50 Stars via Telegram Stars
    donationDao.recordDonation(donorUser.id, 302, 50, "charge_stars_live");
    invertedIndex.addDonationStars(302, 50);

    // Resolve again: donorUser MUST jump to 1st place!
    resolved = invertedIndex.resolveSubscribers("flagship", "asia", "available");
    expect(resolved[0].telegramId).toBe(302);
    expect(resolved[0].totalDonatedStars).toBe(50);
    expect(resolved[1].telegramId).toBe(301);
  });
});
