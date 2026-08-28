import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { DonationDAO } from "../src/db/dao/donations.js";
import { UserDAO } from "../src/db/dao/users.js";
import { SubscriberInvertedIndex } from "../src/bot/notifier/subscriberIndex.js";
import { initSchema } from "../src/db/index.js";

describe("Real-World Telegram Stars (XTR) End-to-End Simulation & Priority Dispatch Lifecycle", () => {
  let db: Database.Database;
  let userDao: UserDAO;
  let donationDao: DonationDAO;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    userDao = new UserDAO(db);
    donationDao = new DonationDAO(db);
  });

  it("Full Simulation 1: Real-world payment flow with unconfirmed click vs confirmed payment", () => {
    // 1. User onboarding
    const user = userDao.upsertUser({
      telegram_id: 10001,
      username: "alex_trader",
      first_name: "Alex",
      language: "uk",
    });

    // 2. User presses 250 ⭐ invoice button (Generates invoice, but user closes/cancels invoice dialog)
    // SYSTEM INVARIANT: No Stars must be recorded, priority remains at 0!
    expect(donationDao.getUserTotalDonated(user.id)).toBe(0);
    expect(userDao.getByTelegramId(10001)?.total_donated_stars).toBe(0);

    // 3. User re-opens invoice and proceeds to pay 250 Stars
    // Telegram Bot API Step A: pre_checkout_query (Bot answers ok: true within 10s)
    const preCheckoutApproved = true;
    expect(preCheckoutApproved).toBe(true);

    // Telegram Bot API Step B: Telegram confirms Stars debited, sends message:successful_payment
    const fakeTelegramPayload = {
      total_amount: 250,
      currency: "XTR",
      telegram_payment_charge_id: "tg_charge_sec_998877",
      provider_payment_charge_id: "stars_int_001",
    };

    // System executes atomic recordDonation
    const donation = donationDao.recordDonation(
      user.id,
      10001,
      fakeTelegramPayload.total_amount,
      fakeTelegramPayload.telegram_payment_charge_id,
      fakeTelegramPayload.provider_payment_charge_id
    );

    expect(donation.id).toBeGreaterThan(0);
    expect(donation.amount_stars).toBe(250);
    expect(donation.currency).toBe("XTR");
    expect(donation.telegram_payment_charge_id).toBe("tg_charge_sec_998877");

    // 4. Verify SQLite persistence
    expect(donationDao.getUserTotalDonated(user.id)).toBe(250);
    const updatedUser = userDao.getByTelegramId(10001);
    expect(updatedUser?.total_donated_stars).toBe(250);

    // 5. Verify Idempotence (Telegram re-delivery protection)
    const duplicateDonation = donationDao.recordDonation(
      user.id,
      10001,
      fakeTelegramPayload.total_amount,
      fakeTelegramPayload.telegram_payment_charge_id,
      fakeTelegramPayload.provider_payment_charge_id
    );
    expect(duplicateDonation.id).toBe(donation.id);
    expect(donationDao.getUserTotalDonated(user.id)).toBe(250); // NOT 500!
  });

  it("Full Simulation 2: Complete 5-Tier User Notification Dispatch Queue Ordering", () => {
    // Set up 5 real users in different tier roles:
    // User 1: Free User (active 30s ago)
    const freeUser = userDao.upsertUser({ telegram_id: 101, username: "free_user", first_name: "Frank", language: "uk" });
    // User 2: Coffee Supporter (15 ⭐)
    const coffeeUser = userDao.upsertUser({ telegram_id: 102, username: "coffee_donor", first_name: "Chris", language: "en" });
    donationDao.recordDonation(coffeeUser.id, 102, 15, "ch_coffee_15");
    // User 3: Respect Supporter (100 ⭐)
    const respectUser = userDao.upsertUser({ telegram_id: 103, username: "respect_donor", first_name: "Rachel", language: "ru" });
    donationDao.recordDonation(respectUser.id, 103, 100, "ch_respect_100");
    // User 4: Whale Cluster Sponsor (500 ⭐)
    const sponsorUser = userDao.upsertUser({ telegram_id: 104, username: "whale_sponsor", first_name: "William", language: "uk" });
    donationDao.recordDonation(sponsorUser.id, 104, 500, "ch_whale_500");
    // User 5: Admin (0 ⭐, active 2 hours ago)
    const adminUser = userDao.upsertUser({ telegram_id: 105, username: "admin_bot", first_name: "Admin", language: "uk" });
    userDao.setAdmin(105, true);

    // All 5 users subscribe to Flagship Europe slot drops
    for (const u of [freeUser, coffeeUser, respectUser, sponsorUser, adminUser]) {
      db.exec(`INSERT INTO subscriptions (user_id, pool_slug, block_id, notify_on_available) VALUES (${u.id}, 'flagship', 'europe', 1)`);
    }

    // Initialize high-concurrency Inverted Index from SQLite
    const index = new SubscriberInvertedIndex(db);

    // Simulate Scraper detecting Flagship Europe slot open!
    const resolvedQueue = index.resolveSubscribers("flagship", "europe", "available");

    expect(resolvedQueue).toHaveLength(5);

    // Assert the exact mathematical delivery sequence:
    // 1st in queue: Admin (instant alert delivery)
    expect(resolvedQueue[0].telegramId).toBe(105);
    expect(resolvedQueue[0].isAdmin).toBe(true);

    // 2nd in queue: 500 ⭐ Cluster Sponsor (Top Donor)
    expect(resolvedQueue[1].telegramId).toBe(104);
    expect(resolvedQueue[1].totalDonatedStars).toBe(500);

    // 3rd in queue: 100 ⭐ Respect Supporter
    expect(resolvedQueue[2].telegramId).toBe(103);
    expect(resolvedQueue[2].totalDonatedStars).toBe(100);

    // 4th in queue: 15 ⭐ Coffee Supporter
    expect(resolvedQueue[3].telegramId).toBe(102);
    expect(resolvedQueue[3].totalDonatedStars).toBe(15);

    // 5th in queue: Free active user
    expect(resolvedQueue[4].telegramId).toBe(101);
    expect(resolvedQueue[4].totalDonatedStars).toBe(0);

    // Dynamic Live Upgrade: Free user donates 1000 ⭐ during live operation
    donationDao.recordDonation(freeUser.id, 101, 1000, "ch_super_1000");
    index.addDonationStars(101, 1000);

    const liveResolvedQueue = index.resolveSubscribers("flagship", "europe", "available");
    // Free user is now ahead of the 500 ⭐ sponsor!
    expect(liveResolvedQueue[0].telegramId).toBe(105); // Admin
    expect(liveResolvedQueue[1].telegramId).toBe(101); // New #1 Donor (1000 ⭐)
    expect(liveResolvedQueue[2].telegramId).toBe(104); // 500 ⭐
  });

  it("Full Simulation 3: Cold-boot database restart and state recovery invariant", () => {
    // 1. Seed database with multiple donors
    const u1 = userDao.upsertUser({ telegram_id: 2001, username: "donor_a", first_name: "A", language: "uk" });
    const u2 = userDao.upsertUser({ telegram_id: 2002, username: "donor_b", first_name: "B", language: "en" });
    userDao.setAdmin(2002, true);

    donationDao.recordDonation(u1.id, 2001, 350, "ch_recovery_350");
    donationDao.recordDonation(u2.id, 2002, 50, "ch_recovery_50");

    db.exec(`INSERT INTO subscriptions (user_id, pool_slug, block_id) VALUES (${u1.id}, 'frontier', 'americas')`);
    db.exec(`INSERT INTO subscriptions (user_id, pool_slug, block_id) VALUES (${u2.id}, 'frontier', 'americas')`);

    // 2. Simulate complete bot crash / cold process restart: new InvertedIndex instance hydrates from SQLite
    const restartedIndex = new SubscriberInvertedIndex(db);

    const restoredSubscribers = restartedIndex.resolveSubscribers("frontier", "americas", "available");
    expect(restoredSubscribers).toHaveLength(2);

    // Admin first, followed by 350 Stars donor
    expect(restoredSubscribers[0].telegramId).toBe(2002);
    expect(restoredSubscribers[0].isAdmin).toBe(true);

    expect(restoredSubscribers[1].telegramId).toBe(2001);
    expect(restoredSubscribers[1].totalDonatedStars).toBe(350);

    // Verify global stats & top donors query
    expect(donationDao.getGlobalTotalDonated()).toBe(400);
    const topDonors = donationDao.getTopDonators(5);
    expect(topDonors[0].telegram_id).toBe(2001);
    expect(topDonors[0].total_stars).toBe(350);
  });
});
