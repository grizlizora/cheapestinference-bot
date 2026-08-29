import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { UserDAO } from "../src/db/dao/users.js";
import { SubscriptionDAO } from "../src/db/dao/subscriptions.js";
import { NotificationLogDAO } from "../src/db/dao/notificationLogs.js";
import { SlotHistoryDAO } from "../src/db/dao/slotHistory.js";
import { SubscriberInvertedIndex } from "../src/bot/notifier/subscriberIndex.js";
import { NotificationDispatcher, OutgoingAlertMessage } from "../src/bot/notifier/dispatcher.js";
import { DiffEvent } from "../src/types/domain.js";

describe("NotificationDispatcher Modern Alert & Bundling Test Suite", () => {
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
        is_admin INTEGER NOT NULL DEFAULT 0,
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

  it("should bundle multiple simultaneous events into 1 single notification per user with action buttons", async () => {
    const mockBot: any = {
      api: {
        sendMessage: async () => ({ message_id: 1 }),
      },
    };

    const dispatcher = new NotificationDispatcher(mockBot, userDao, logDao, historyDao, index);
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
        newPrice: "149",
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
        newPrice: "49",
        timestamp: Date.now(),
      },
    ];

    await dispatcher.handleDiffEvents(simultaneousEvents);

    expect(enqueuedMessages).toHaveLength(1);
    const bundle = enqueuedMessages[0];
    expect(bundle.telegramId).toBe(1001);
    expect(bundle.eventType).toBe("BUNDLE_EVENT");
    expect(bundle.text).toContain("Оновлення слотів (2)");
    expect(bundle.text).toContain("Flagship Pool • Європа");
    expect(bundle.text).toContain("Frontier Pool • Азія");
    expect(bundle.text).toContain("<code>$149/міс</code>");
    expect(bundle.text).toContain("<code>$49/міс</code>");
    expect(bundle.priority).toBe("P1");
    expect(bundle.keyboard).toBeDefined();
  });

  it("should format single SLOT_APPEARED with high-contrast banner and localized button", async () => {
    const mockBot: any = {
      api: {
        sendMessage: async () => ({ message_id: 1 }),
      },
    };

    const dispatcher = new NotificationDispatcher(mockBot, userDao, logDao, historyDao, index);
    dispatcher.enqueue = (msg) => {
      enqueuedMessages.push(msg);
    };

    const singleEvent: DiffEvent[] = [
      {
        id: "e1",
        type: "SLOT_APPEARED",
        poolSlug: "frontier",
        poolName: "Frontier Pool",
        block: "europe",
        models: ["deepseek-r1", "glm-5.3"],
        hoursUtc: "08:00 – 16:00 UTC",
        newPrice: "149",
        newStatus: "available",
        timestamp: Date.now(),
      },
    ];

    await dispatcher.handleDiffEvents(singleEvent);

    expect(enqueuedMessages).toHaveLength(1);
    const alert = enqueuedMessages[0];
    expect(alert.text).toContain("08:00 – 16:00 UTC");
    expect(alert.text).toContain("<code>deepseek-r1</code>");
    expect(alert.text).toContain("<code>$149/міс</code>");
  });

  it("should format price discounts with green badge and localized sign", async () => {
    const mockBot: any = {
      api: {
        sendMessage: async () => ({ message_id: 1 }),
      },
    };

    const dispatcher = new NotificationDispatcher(mockBot, userDao, logDao, historyDao, index);
    dispatcher.enqueue = (msg) => {
      enqueuedMessages.push(msg);
    };

    const priceDiscountEvent: DiffEvent[] = [
      {
        id: "p1",
        type: "SLOT_PRICE_CHANGED",
        poolSlug: "core",
        poolName: "Core Pool",
        block: "asia",
        models: ["deepseek-v4"],
        hoursUtc: "00:00 – 08:00 UTC",
        previousPrice: "39",
        newPrice: "29",
        timestamp: Date.now(),
        slotPrice: {
          block: "asia",
          hoursUtc: "00:00 – 08:00 UTC",
          previousPrice: "39",
          newPrice: "29",
          priceDelta: -10,
          percentageDelta: -25.6,
          isDiscount: true,
        },
      },
    ];

    await dispatcher.handleDiffEvents(priceDiscountEvent);

    expect(enqueuedMessages).toHaveLength(1);
    const alert = enqueuedMessages[0];
    expect(alert.text).toContain("ЗМІНА ЦІНИ СЛОТА • Core Pool");
    expect(alert.text).toContain("<s>$39</s> ➔ <b>$29/міс</b>");
    expect(alert.text).toContain("🟢 <b>Знижка: -$10/міс (-25.6%) 🔥</b>");
  });

  it("should never leak unparsed template placeholders like {pool_name} in bundled digests", async () => {
    const mockBot: any = {
      api: {
        sendMessage: async () => ({ message_id: 1 }),
      },
    };

    const dispatcher = new NotificationDispatcher(mockBot, userDao, logDao, historyDao, index);
    dispatcher.enqueue = (msg) => {
      enqueuedMessages.push(msg);
    };

    const mixedEvents: DiffEvent[] = [
      {
        id: "m1",
        type: "SLOT_APPEARED",
        poolSlug: "frontier",
        poolName: "Frontier Pool",
        block: "europe",
        models: ["glm-5.3", "minimax-m3"],
        hoursUtc: "08:00 – 16:00 UTC",
        newPrice: "49.00",
        timestamp: Date.now(),
      },
      {
        id: "m2",
        type: "MODEL_UPGRADE_EVENT",
        poolSlug: "core",
        poolName: "Core Pool",
        block: "ALL",
        models: ["deepseek-v4-r1"],
        hoursUtc: "",
        timestamp: Date.now(),
      },
      {
        id: "m3",
        type: "TIER_UPDATED_EVENT",
        poolSlug: "flagship",
        poolName: "Flagship Pool",
        block: "ALL",
        models: ["kimi-k3"],
        hoursUtc: "",
        timestamp: Date.now(),
      },
    ];

    await dispatcher.handleDiffEvents(mixedEvents);

    expect(enqueuedMessages).toHaveLength(1);
    const bundle = enqueuedMessages[0];
    expect(bundle.text).not.toContain("{pool_name}");
    expect(bundle.text).not.toContain("{block_name}");
    expect(bundle.text).not.toContain("{models}");
    expect(bundle.text).toContain("Core Pool • Оновлення моделей");
    expect(bundle.text).toContain("Flagship Pool • Оновлення тарифу");
  });

  it("should deduplicate buttons in bundled alert when multiple slots disappear for the same pool", async () => {
    const mockBot: any = {
      api: {
        sendMessage: async () => ({ message_id: 1 }),
      },
    };

    // User is subscribed to sold_out alerts
    db.exec("UPDATE subscriptions SET notify_on_sold_out = 1 WHERE user_id = 1");
    index = new SubscriberInvertedIndex(db);

    const dispatcher = new NotificationDispatcher(mockBot, userDao, logDao, historyDao, index);
    dispatcher.enqueue = (msg) => {
      enqueuedMessages.push(msg);
    };

    const duplicateDisappearEvents: DiffEvent[] = [
      {
        id: "d1",
        type: "SLOT_DISAPPEARED",
        poolSlug: "flagship",
        poolName: "Flagship Pool",
        block: "asia",
        models: ["kimi-k3", "qwen3.8-max"],
        hoursUtc: "00:00 – 08:00 UTC",
        newStatus: "sold-out",
        timestamp: Date.now(),
      },
      {
        id: "d2",
        type: "SLOT_DISAPPEARED",
        poolSlug: "flagship",
        poolName: "Flagship Pool",
        block: "americas",
        models: ["kimi-k3", "qwen3.8-max"],
        hoursUtc: "16:00 – 24:00 UTC",
        newStatus: "sold-out",
        timestamp: Date.now(),
      },
    ];

    await dispatcher.handleDiffEvents(duplicateDisappearEvents);

    expect(enqueuedMessages).toHaveLength(1);
    const bundle = enqueuedMessages[0];
    const inlineButtons = bundle.keyboard?.inline_keyboard.flat() || [];

    // There should be exactly 1 button for FLAGSHIP, not 2 duplicate buttons!
    expect(inlineButtons).toHaveLength(1);
    expect(inlineButtons[0].text).toBe("🔍 FLAGSHIP");
    expect(inlineButtons[0].url).toBe("https://cheapestinference.com/pools/flagship");
  });

  it("should prioritize specific slot claim button over generic pool button for the same pool", async () => {
    const mockBot: any = {
      api: {
        sendMessage: async () => ({ message_id: 1 }),
      },
    };

    db.exec("UPDATE subscriptions SET notify_on_sold_out = 1, notify_on_available = 1 WHERE user_id = 1");
    index = new SubscriberInvertedIndex(db);

    const dispatcher = new NotificationDispatcher(mockBot, userDao, logDao, historyDao, index);
    dispatcher.enqueue = (msg) => {
      enqueuedMessages.push(msg);
    };

    const mixedPoolEvents: DiffEvent[] = [
      {
        id: "m1",
        type: "SLOT_DISAPPEARED",
        poolSlug: "flagship",
        poolName: "Flagship Pool",
        block: "asia",
        models: ["kimi-k3"],
        hoursUtc: "00:00 – 08:00 UTC",
        newStatus: "sold-out",
        timestamp: Date.now(),
      },
      {
        id: "m2",
        type: "SLOT_APPEARED",
        poolSlug: "flagship",
        poolName: "Flagship Pool",
        block: "americas",
        models: ["kimi-k3"],
        hoursUtc: "16:00 – 24:00 UTC",
        newPrice: "149.00",
        newStatus: "available",
        timestamp: Date.now(),
      },
    ];

    await dispatcher.handleDiffEvents(mixedPoolEvents);

    expect(enqueuedMessages).toHaveLength(1);
    const bundle = enqueuedMessages[0];
    const inlineButtons = bundle.keyboard?.inline_keyboard.flat() || [];

    // The high-intent claim button should be present, and generic 🔍 FLAGSHIP suppressed
    expect(inlineButtons).toHaveLength(1);
    expect(inlineButtons[0].text).toContain("⚡ FLAGSHIP (Америка)");
    expect(inlineButtons[0].url).toBe("https://cheapestinference.com/pools/flagship#americas");
  });
});
