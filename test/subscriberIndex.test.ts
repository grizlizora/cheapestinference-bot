import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SubscriberInvertedIndex } from "../src/bot/notifier/subscriberIndex.js";

describe("SubscriberInvertedIndex", () => {
  let db: Database.Database;

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
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  });

  it("should hydrate from database and resolve hierarchical subscribers in O(1)", () => {
    // User 1: Global subscriber
    db.exec("INSERT INTO users (id, telegram_id, first_name, language) VALUES (1, 1001, 'Alice', 'en')");
    db.exec("INSERT INTO subscriptions (user_id, pool_slug, block_id) VALUES (1, 'ALL', 'ALL')");

    // User 2: Flagship pool subscriber
    db.exec("INSERT INTO users (id, telegram_id, first_name, language) VALUES (2, 1002, 'Bob', 'uk')");
    db.exec("INSERT INTO subscriptions (user_id, pool_slug, block_id) VALUES (2, 'flagship', 'ALL')");

    // User 3: Flagship Europe exact block subscriber
    db.exec("INSERT INTO users (id, telegram_id, first_name, language) VALUES (3, 1003, 'Charlie', 'ru')");
    db.exec("INSERT INTO subscriptions (user_id, pool_slug, block_id) VALUES (3, 'flagship', 'europe')");

    // User 4: Frontier Asia subscriber
    db.exec("INSERT INTO users (id, telegram_id, first_name, language) VALUES (4, 1004, 'David', 'en')");
    db.exec("INSERT INTO subscriptions (user_id, pool_slug, block_id) VALUES (4, 'frontier', 'asia')");

    const index = new SubscriberInvertedIndex(db);

    // When Flagship Europe drops: Users 1, 2, and 3 should be matched!
    const matchesEurope = index.resolveSubscribers("flagship", "europe", "available");
    const matchedTgIds = matchesEurope.map((u) => u.telegramId);

    expect(matchedTgIds).toContain(1001);
    expect(matchedTgIds).toContain(1002);
    expect(matchedTgIds).toContain(1003);
    expect(matchedTgIds).not.toContain(1004);
  });

  it("should instantly evict deactivated or blocked users", () => {
    db.exec("INSERT INTO users (id, telegram_id, first_name, language) VALUES (1, 1001, 'Alice', 'en')");
    db.exec("INSERT INTO subscriptions (user_id, pool_slug, block_id) VALUES (1, 'ALL', 'ALL')");

    const index = new SubscriberInvertedIndex(db);
    expect(index.resolveSubscribers("flagship", "europe", "available")).toHaveLength(1);

    // Instant 403 block eviction in memory
    index.markUserDeactivated(1001);
    expect(index.resolveSubscribers("flagship", "europe", "available")).toHaveLength(0);
  });
});
