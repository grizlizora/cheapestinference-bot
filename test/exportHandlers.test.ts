import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { UserDAO } from "../src/db/dao/users.js";
import { SubscriptionDAO } from "../src/db/dao/subscriptions.js";
import { createUsersExportHandler, createHistoryExportHandler } from "../src/bot/handlers/backup.js";

describe("Admin Excel/CSV Export Handlers Test Suite", () => {
  let db: Database.Database;
  let userDao: UserDAO;
  let subDao: SubscriptionDAO;

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

      CREATE TABLE slot_lifecycle_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pool_slug TEXT NOT NULL,
        block_id TEXT NOT NULL,
        opened_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        closed_at DATETIME,
        duration_seconds INTEGER,
        initial_status TEXT NOT NULL,
        price_month TEXT NOT NULL
      );

      CREATE TABLE catalog_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pool_slug TEXT NOT NULL,
        pool_name TEXT NOT NULL,
        event_type TEXT NOT NULL,
        added_models_json TEXT NOT NULL DEFAULT '[]',
        upgraded_models_json TEXT NOT NULL DEFAULT '[]',
        removed_models_json TEXT NOT NULL DEFAULT '[]',
        all_models_json TEXT NOT NULL,
        previous_min_price TEXT,
        new_min_price TEXT,
        metadata_json TEXT DEFAULT '{}',
        detected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE slot_price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pool_slug TEXT NOT NULL,
        block_id TEXT NOT NULL,
        old_price TEXT NOT NULL,
        new_price TEXT NOT NULL,
        price_delta REAL NOT NULL,
        percent_delta REAL NOT NULL,
        changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    userDao = new UserDAO(db);
    subDao = new SubscriptionDAO(db);
  });

  it("1. should export users CSV with UTF-8 BOM and correct columns", async () => {
    const user = userDao.upsertUser({
      telegram_id: 112233,
      username: "roman_dev",
      first_name: "Роман",
      language: "uk",
    });
    userDao.setAdmin(112233, true);

    subDao.togglePoolWithBlocks(user.id, "flagship", ["asia", "europe", "americas"]);

    let sentDoc: any = null;
    let sentCaption: string = "";

    const ctxMock: any = {
      from: { id: 112233, username: "roman_dev" },
      lang: "uk",
      t: (k: string) => k,
      reply: vi.fn().mockResolvedValue({ message_id: 1 }),
      replyWithDocument: vi.fn().mockImplementation((doc, opts) => {
        sentDoc = doc;
        sentCaption = opts?.caption || "";
        return Promise.resolve();
      }),
      api: { deleteMessage: vi.fn().mockResolvedValue(true) },
      chat: { id: 112233 },
    };

    const handler = createUsersExportHandler(db, userDao, subDao);
    await handler(ctxMock);

    expect(ctxMock.replyWithDocument).toHaveBeenCalled();
    expect(sentDoc).toBeDefined();

    // Verify CSV content
    const csvContent = (sentDoc as any).fileData.toString("utf8");
    expect(csvContent.startsWith("\uFEFF")).toBe(true); // Excel UTF-8 BOM
    expect(csvContent).toContain("Telegram ID");
    expect(csvContent).toContain("112233");
    expect(csvContent).toContain("roman_dev");
    expect(csvContent).toContain("FLAGSHIP:ALL");
    expect(sentCaption).toContain("Звіт користувачів");
  });

  it("2. should export full change history CSV with slots, price deltas, and model upgrades", async () => {
    const user = userDao.upsertUser({
      telegram_id: 112233,
      username: "grizlizora",
      first_name: "Admin",
      language: "uk",
    });
    userDao.setAdmin(112233, true);

    db.prepare(`
      INSERT INTO slot_lifecycle_history (pool_slug, block_id, opened_at, closed_at, duration_seconds, initial_status, price_month)
      VALUES ('flagship', 'europe', '2026-08-27 12:00:00', '2026-08-27 12:45:00', 2700, 'available', '$99')
    `).run();

    db.prepare(`
      INSERT INTO catalog_history (pool_slug, pool_name, event_type, added_models_json, upgraded_models_json, all_models_json, detected_at)
      VALUES ('core', 'Core Tier', 'MODEL_UPGRADE', '["gpt-4o"]', '["claude-3-7-sonnet"]', '["gpt-4o", "claude-3-7-sonnet"]', '2026-08-27 13:00:00')
    `).run();

    db.prepare(`
      INSERT INTO slot_price_history (pool_slug, block_id, old_price, new_price, price_delta, percent_delta, changed_at)
      VALUES ('frontier', 'asia', '$120', '$99', -21, -17.5, '2026-08-27 14:00:00')
    `).run();

    let sentDoc: any = null;
    let sentCaption: string = "";

    const ctxMock: any = {
      from: { id: 112233, username: "grizlizora" },
      lang: "uk",
      t: (k: string) => k,
      reply: vi.fn().mockResolvedValue({ message_id: 1 }),
      replyWithDocument: vi.fn().mockImplementation((doc, opts) => {
        sentDoc = doc;
        sentCaption = opts?.caption || "";
        return Promise.resolve();
      }),
      api: { deleteMessage: vi.fn().mockResolvedValue(true) },
      chat: { id: 112233 },
    };

    const handler = createHistoryExportHandler(db, userDao);
    await handler(ctxMock);

    expect(ctxMock.replyWithDocument).toHaveBeenCalled();
    const csvContent = (sentDoc as any).fileData.toString("utf8");
    expect(csvContent.startsWith("\uFEFF")).toBe(true);
    expect(csvContent).toContain("FLAGSHIP");
    expect(csvContent).toContain("45 min");
    expect(csvContent).toContain("MODEL_UPGRADE");
    expect(csvContent).toContain("claude-3-7-sonnet");
    expect(csvContent).toContain("-21");
    expect(sentCaption).toContain("Повна історія всіх змін");
  });
});
