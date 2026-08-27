import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { UserDAO } from "../src/db/dao/users.js";
import { escapeHtml } from "../src/i18n/index.js";

describe("UserDAO & Admin Settings", () => {
  let db: Database.Database;
  let userDao: UserDAO;

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
        last_active_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    userDao = new UserDAO(db);
  });

  it("should upsert user and return defaults", () => {
    const user = userDao.upsertUser({
      telegram_id: 12345,
      username: "testuser",
      first_name: "Test",
      language: "en",
    });

    expect(user.telegram_id).toBe(12345);
    expect(user.first_name).toBe("Test");
    expect(user.notify_admin_new_users).toBe(1);
    expect(user.notify_available_global).toBe(1);
  });

  it("should update last_active_at via touchLastActive", () => {
    userDao.upsertUser({
      telegram_id: 54321,
      username: "activeuser",
      first_name: "Active",
    });

    userDao.touchLastActive(54321);
    const user = userDao.getByTelegramId(54321);
    expect(user?.last_active_at).toBeDefined();
  });

  it("should toggle notify_admin_new_users on and off", () => {
    userDao.upsertUser({
      telegram_id: 99999,
      username: "adminuser",
      first_name: "Admin",
    });

    // Default is 1 (ON). Toggle once -> 0 (OFF)
    const off = userDao.toggleAdminNewUsers(99999);
    expect(off).toBe(0);

    // Toggle again -> 1 (ON)
    const on = userDao.toggleAdminNewUsers(99999);
    expect(on).toBe(1);
  });

  it("should support setAdmin, isAdmin, and getAllAdminTelegramIds", () => {
    userDao.upsertUser({
      telegram_id: 88888,
      username: "promotedadmin",
      first_name: "Admin",
    });

    expect(userDao.isAdmin(88888)).toBe(false);
    userDao.setAdmin(88888, true);
    expect(userDao.isAdmin(88888)).toBe(true);

    const admins = userDao.getAllAdminTelegramIds([11111]);
    expect(admins).toContain(88888);
    expect(admins).toContain(11111);
  });

  it("should evaluate isUserAdmin strictly", async () => {
    const { isUserAdmin } = await import("../src/config/env.js");

    expect(isUserAdmin(undefined, userDao)).toBe(false);
    expect(isUserAdmin(0, userDao)).toBe(false);

    // Not in env list and not in DB -> false
    expect(isUserAdmin(1234567, userDao)).toBe(false);

    // Promoted in DB -> true
    userDao.upsertUser({ telegram_id: 1234567, first_name: "VIP" });
    userDao.setAdmin(1234567, true);
    expect(isUserAdmin(1234567, userDao)).toBe(true);
  });

  it("should evaluate isUserOwner cryptographically and reject unauthorized users", async () => {
    const { isUserOwner, CREATOR_TELEGRAM_ID } = await import("../src/config/env.js");

    // Valid creator ID with matching SHA-256
    expect(isUserOwner(CREATOR_TELEGRAM_ID)).toBe(true);

    // Other IDs must strictly fail
    expect(isUserOwner(undefined)).toBe(false);
    expect(isUserOwner(0)).toBe(false);
    expect(isUserOwner(123456789)).toBe(false);
    expect(isUserOwner(999999999)).toBe(false);
  });

  it("should calculate subscription stats correctly in SubscriptionDAO", async () => {
    const { SubscriptionDAO } = await import("../src/db/dao/subscriptions.js");
    db.exec(`
      CREATE TABLE subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
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
    const subDao = new SubscriptionDAO(db);

    const initial = subDao.getSubscriptionStats();
    expect(initial.totalRules).toBe(0);
    expect(initial.subscribedUsers).toBe(0);

    // Add default subscriptions for 1 user
    subDao.createDefaultSubscriptions(1);
    const stats1 = subDao.getSubscriptionStats();
    expect(stats1.totalRules).toBe(13);
    expect(stats1.subscribedUsers).toBe(1);

    // Add for a second user
    subDao.createDefaultSubscriptions(2);
    const stats2 = subDao.getSubscriptionStats();
    expect(stats2.totalRules).toBe(26);
    expect(stats2.subscribedUsers).toBe(2);
  });

  it("should escape HTML characters safely", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe("&lt;script&gt;alert('xss')&lt;/script&gt;");
    expect(escapeHtml("Fast & Reliable < 50ms")).toBe("Fast &amp; Reliable &lt; 50ms");
    expect(escapeHtml("")).toBe("");
  });
});
