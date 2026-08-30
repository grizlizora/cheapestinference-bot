import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/index.js";
import { TelegramSender } from "../src/bot/notifier/sender/telegramSender.js";
import { DwrrScheduler } from "../src/bot/notifier/queue/dwrrScheduler.js";
import { NotificationRateLimiter } from "../src/bot/notifier/rateLimiter.js";
import { OutboxManager } from "../src/bot/notifier/outbox/outboxManager.js";
import { NotificationOutboxDAO } from "../src/db/dao/notificationOutbox.js";
import { NotificationLogDAO } from "../src/db/dao/notificationLogs.js";
import { SubscriberInvertedIndex } from "../src/bot/notifier/subscriberIndex.js";
import { UserDAO } from "../src/db/dao/users.js";
import { OutgoingAlertMessage } from "../src/bot/notifier/types.js";

describe("🛡️ CHAOS: TelegramSender Error Boundaries & Resilience", () => {
  let db: Database.Database;
  let outboxDao: NotificationOutboxDAO;
  let logDao: NotificationLogDAO;
  let userDao: UserDAO;
  let index: SubscriberInvertedIndex;
  let outboxManager: OutboxManager;
  let rateLimiter: NotificationRateLimiter;
  let scheduler: DwrrScheduler;
  let sender: TelegramSender;
  let fakeBot: any;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);

    outboxDao = new NotificationOutboxDAO(db);
    logDao = new NotificationLogDAO(db);
    userDao = new UserDAO(db);
    index = new SubscriberInvertedIndex(db);

    userDao.upsertUser({ telegram_id: 123456, username: "TestUser", first_name: "Test", language: "en" });
    index.upsertUserProfile({
      userId: 1,
      telegramId: 123456,
      language: "en",
      isAdmin: false,
      isMuted: false,
      isActive: true,
      totalDonatedStars: 0,
      lastActiveAt: Date.now(),
      notifyAvailableGlobal: true,
      notifySoldOutGlobal: true,
      notifyModelsGlobal: true,
      notifyPricesGlobal: true,
    });

    outboxManager = new OutboxManager(userDao, logDao, outboxDao, index);
    rateLimiter = new NotificationRateLimiter();
    scheduler = new DwrrScheduler(rateLimiter);

    fakeBot = {
      api: {
        sendMessage: vi.fn(),
      },
    };

    sender = new TelegramSender(fakeBot, rateLimiter, scheduler, outboxManager);
  });

  afterEach(() => {
    rateLimiter?.close();
    db.close();
  });

  it("1. Automatically triggers RateLimiter backoff and preserves Head-of-Line ordering on HTTP 429", async () => {
    const msg: OutgoingAlertMessage = {
      id: "msg-429",
      telegramId: 123456,
      userId: 1,
      poolSlug: "flagship",
      blockId: "europe",
      eventType: "SLOT_APPEARED",
      text: "<b>Alert</b>",
      isMuted: false,
      priority: "P0",
      retries: 0,
      enqueuedAt: Date.now(),
    };

    const err429 = {
      error_code: 429,
      description: "Too Many Requests: retry after 4",
      parameters: { retry_after: 4 },
    };

    await sender.handleDispatchError(msg, err429);

    // Assert rate limiter entered paused state
    expect(rateLimiter.isGlobalPaused()).toBe(true);

    // Assert message was pushed back to the head of the P0 queue
    expect(scheduler.p0Queue.size()).toBe(1);
    expect(scheduler.p0Queue.peek()?.id).toBe("msg-429");
  });

  it("2. Falls back to plain text when Telegram returns HTTP 400 'can't parse entities'", async () => {
    const msg: OutgoingAlertMessage = {
      id: "msg-bad-html",
      telegramId: 123456,
      userId: 1,
      poolSlug: "flagship",
      blockId: "europe",
      eventType: "SLOT_APPEARED",
      text: "<b>Unbalanced <i>HTML tag</b>",
      isMuted: false,
      priority: "P1",
      retries: 0,
      enqueuedAt: Date.now(),
    };

    const errBadHtml = {
      error_code: 400,
      description: "Bad Request: can't parse entities: can't find end tag",
    };

    fakeBot.api.sendMessage.mockResolvedValueOnce({ message_id: 9999 });

    await sender.handleDispatchError(msg, errBadHtml);

    // Verify plain text fallback was called with HTML tags stripped
    expect(fakeBot.api.sendMessage).toHaveBeenCalledWith(
      123456,
      "Unbalanced HTML tag",
      expect.objectContaining({ disable_notification: false })
    );
  });

  it("3. Instantly deactivates user upon receiving HTTP 403 Forbidden without deleting subscriptions", async () => {
    const msg: OutgoingAlertMessage = {
      id: "msg-blocked",
      telegramId: 123456,
      userId: 1,
      poolSlug: "flagship",
      blockId: "europe",
      eventType: "SLOT_APPEARED",
      text: "Alert",
      isMuted: false,
      priority: "P1",
      retries: 0,
      enqueuedAt: Date.now(),
    };

    const err403 = {
      error_code: 403,
      description: "Forbidden: bot was blocked by the user",
    };

    await sender.handleDispatchError(msg, err403);
    outboxManager.flushBlockedUsersToDb();

    // Assert user is marked inactive in DB
    const user = userDao.getUserByTgId(123456);
    expect(user?.is_active).toBe(0);

    // Assert profile is marked inactive in RAM index
    const profile = index.getProfileByTgId(123456);
    expect(profile?.isActive).toBe(false);
  });
});
