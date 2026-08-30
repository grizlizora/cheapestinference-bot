import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import Database from "better-sqlite3";
import { UserDAO } from "../src/db/dao/users.js";
import { SubscriberInvertedIndex } from "../src/bot/notifier/subscriberIndex.js";
import { UserActivitySyncer } from "../src/bot/notifier/userActivitySyncer.js";

describe("UserActivitySyncer: 30-Second Debounced Trailing Activity Sync Suite", () => {
  let db: Database.Database;
  let userDao: UserDAO;
  let invertedIndex: SubscriberInvertedIndex;
  let syncer: UserActivitySyncer;

  beforeEach(() => {
    vi.useFakeTimers();
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
        last_active_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        pool_slug TEXT NOT NULL,
        block_id TEXT NOT NULL,
        notify_on_available INTEGER NOT NULL DEFAULT 1,
        notify_on_sold_out INTEGER NOT NULL DEFAULT 0,
        notify_on_models INTEGER NOT NULL DEFAULT 1,
        notify_on_prices INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, pool_slug, block_id)
      );
    `);

    userDao = new UserDAO(db);
    invertedIndex = new SubscriberInvertedIndex(db);

    // Create test user
    const user = userDao.upsertUser({
      telegram_id: 12345,
      username: "active_user",
      first_name: "Active",
      language: "uk",
    });

    invertedIndex.upsertUserProfile({
      userId: user.id,
      telegramId: user.telegram_id,
      language: "uk",
      isMuted: false,
      isActive: true,
      isAdmin: false,
      totalDonatedStars: 0,
      notifyAvailableGlobal: true,
      notifySoldOutGlobal: false,
      notifyModelsGlobal: true,
      notifyPricesGlobal: true,
      lastActiveAt: Date.now() - 100_000,
    });

    syncer = new UserActivitySyncer(userDao, invertedIndex);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("1. should write to SQLite immediately on initial interaction and update RAM", () => {
    const t0 = 1700000000000;
    syncer.touch(12345, t0);

    const profile = invertedIndex.getProfileByTgId(12345);
    expect(profile?.lastActiveAt).toBe(t0);

    const dbUser = userDao.getByTelegramId(12345);
    expect(dbUser?.last_active_at).toBe(new Date(t0).toISOString());
    expect(syncer.getPendingCount()).toBe(1);
  });

  it("2. should debounce multiple clicks within 30s and flush the exact final click to SQLite after 30s quiet", () => {
    const t0 = 1700000000000;
    syncer.touch(12345, t0);

    // User clicks again 5 seconds later
    const t1 = t0 + 5000;
    syncer.touch(12345, t1);

    // User clicks again 12 seconds later (their final click)
    const t2 = t0 + 12000;
    syncer.touch(12345, t2);

    // RAM is already updated to t2
    expect(invertedIndex.getProfileByTgId(12345)?.lastActiveAt).toBe(t2);

    // Advance time by 20 seconds (32s from t0, but only 20s from t2) -> should NOT have flushed t2 yet
    vi.advanceTimersByTime(20000);
    expect(syncer.getPendingCount()).toBe(1);

    // Advance remaining 10 seconds (total 30s since final click at t2)
    vi.advanceTimersByTime(10000);
    expect(syncer.getPendingCount()).toBe(0);

    // SQLite should now have the exact timestamp of t2 (the final click)
    const dbUser = userDao.getByTelegramId(12345);
    expect(dbUser?.last_active_at).toBe(new Date(t2).toISOString());
  });

  it("3. should flushAll immediately on demand before export/backup/shutdown", () => {
    const t0 = 1700000000000;
    syncer.touch(12345, t0 + 8000);
    expect(syncer.getPendingCount()).toBe(1);

    // Immediate flush (e.g. before CSV export or server reboot)
    syncer.flushAll();
    expect(syncer.getPendingCount()).toBe(0);

    const dbUser = userDao.getByTelegramId(12345);
    expect(dbUser?.last_active_at).toBe(new Date(t0 + 8000).toISOString());
  });
});
