import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { UserDAO } from "../src/db/dao/users.js";
import { SubscriptionDAO } from "../src/db/dao/subscriptions.js";
import { NotificationLogDAO } from "../src/db/dao/notificationLogs.js";
import { SlotHistoryDAO } from "../src/db/dao/slotHistory.js";
import { SubscriberInvertedIndex } from "../src/bot/notifier/subscriberIndex.js";
import { NotificationDispatcher, OutgoingAlertMessage } from "../src/bot/notifier/dispatcher.js";
import { DiffEvent } from "../src/types/domain.js";

describe("NotificationDispatcher Event Bundling", () => {
  let db: Database.Database;
  let userDao: UserDAO;
  let subDao: SubscriptionDAO;
  let logDao: NotificationLogDAO;
  let historyDao: SlotHistoryDAO;
  let index: SubscriberInvertedIndex;
  let enqueuedMessages: OutgoingAlertMessage[] = [];

  beforeEach(() => {
    enqueuedMessages = [];
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
        last_active_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, pool_slug, block_id)
      );
      CREATE TABLE notification_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        pool_slug TEXT NOT NULL,
        block_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    `);

    userDao = new UserDAO(db);
    subDao = new SubscriptionDAO(db);
    logDao = new NotificationLogDAO(db);
    historyDao = new SlotHistoryDAO(db);

    db.exec("INSERT INTO users (id, telegram_id, first_name, language) VALUES (1, 1001, 'Alice', 'uk')");
    db.exec("INSERT INTO subscriptions (user_id, pool_slug, block_id) VALUES (1, 'ALL', 'ALL')");

    index = new SubscriberInvertedIndex(db);
  });

  it("should bundle multiple simultaneous events into 1 single notification per user", async () => {
    const mockBot: any = {
      api: {
        sendMessage: async () => ({ message_id: 1 }),
      },
    };

    const dispatcher = new NotificationDispatcher(mockBot, userDao, logDao, historyDao, index);

    // Override enqueue to capture output
    dispatcher.enqueue = (msg) => {
      enqueuedMessages.push(msg);
    };

    const simultaneousEvents: DiffEvent[] = [
      {
        id: "e1",
        type: "SLOT_APPEARED",
        poolSlug: "flagship",
        poolName: "Flagship Pool",
        block: "europe",
        models: ["Kimi K3", "Qwen3.8 Max"],
        hoursUtc: "08:00 – 16:00 UTC",
        newPrice: "149.00",
        timestamp: Date.now(),
      },
      {
        id: "e2",
        type: "SLOT_APPEARED",
        poolSlug: "frontier",
        poolName: "Frontier Pool",
        block: "asia",
        models: ["GLM 5.3", "MiniMax M3"],
        hoursUtc: "00:00 – 08:00 UTC",
        newPrice: "49.00",
        timestamp: Date.now(),
      },
    ];

    await dispatcher.handleDiffEvents(simultaneousEvents);

    // Should generate EXACTLY 1 bundled message instead of 2 separate messages!
    expect(enqueuedMessages).toHaveLength(1);
    const bundle = enqueuedMessages[0];
    expect(bundle.telegramId).toBe(1001);
    expect(bundle.eventType).toBe("BUNDLE_EVENT");
    expect(bundle.text).toContain("Оновлення слотів (2)");
    expect(bundle.text).toContain("Flagship Pool");
    expect(bundle.text).toContain("Frontier Pool");
    expect(bundle.priority).toBe("P1");
  });
});
