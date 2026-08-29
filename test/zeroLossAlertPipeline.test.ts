import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/index.js";
import { UserDAO } from "../src/db/dao/users.js";
import { SubscriptionDAO } from "../src/db/dao/subscriptions.js";
import { NotificationOutboxDAO } from "../src/db/dao/notificationOutbox.js";
import { NotificationLogDAO } from "../src/db/dao/notificationLogs.js";
import { SubscriberInvertedIndex } from "../src/bot/notifier/subscriberIndex.js";
import { NotificationDispatcher } from "../src/bot/notifier/dispatcher.js";
import { DiffEvent } from "../src/types/domain.js";

describe("Zero-Loss Alert Pipeline & Exclusion Matching Invariants", () => {
  let db: Database.Database;
  let userDao: UserDAO;
  let subDao: SubscriptionDAO;
  let outboxDao: NotificationOutboxDAO;
  let logDao: NotificationLogDAO;
  let index: SubscriberInvertedIndex;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    userDao = new UserDAO(db);
    subDao = new SubscriptionDAO(db);
    outboxDao = new NotificationOutboxDAO(db);
    logDao = new NotificationLogDAO(db);
    index = new SubscriberInvertedIndex(db);
  });

  afterEach(() => {
    logDao.close();
    db.close();
  });

  it("1. NotificationOutboxDAO: accurately enqueues, fetches pending, and marks dispatched", () => {
    const user = userDao.upsertUser({
      telegram_id: 111222,
      first_name: "TestUser",
      language: "uk",
    });

    outboxDao.enqueue({
      id: "msg-1",
      userId: user.id,
      telegramId: 111222,
      priority: "P1",
      messageText: "<b>⚡ ВІЛЬНИЙ СЛОТ</b>",
      disableNotification: false,
      eventType: "available",
      poolSlug: "flagship",
      blockId: "americas",
      status: "pending",
      attempts: 0,
    });

    const pending = outboxDao.getPending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("msg-1");
    expect(pending[0].poolSlug).toBe("flagship");
    expect(pending[0].blockId).toBe("americas");

    outboxDao.markDispatched("msg-1");
    const pendingAfter = outboxDao.getPending(10);
    expect(pendingAfter).toHaveLength(0);
  });

  it("2. SubscriberInvertedIndex: strictly respects explicit pool exclusions over ALL:ALL global wildcard", () => {
    // User 1: Global wildcard subscriber
    const user1 = userDao.upsertUser({ telegram_id: 101, first_name: "User 1", language: "uk" });
    subDao.upsertSubscriptionWithFlags(user1.id, "ALL", "ALL", 1, 0, 1, 1);

    // User 2: Global wildcard but explicitly DISABLED Flagship availability
    const user2 = userDao.upsertUser({ telegram_id: 102, first_name: "User 2", language: "en" });
    subDao.upsertSubscriptionWithFlags(user2.id, "ALL", "ALL", 1, 0, 1, 1);
    subDao.upsertSubscriptionWithFlags(user2.id, "flagship", "ALL", 0, 0, 1, 1);

    // Re-hydrate index
    index.hydrateFromDatabase();

    // Event: Flagship Americas is available
    const flagshipSubs = index.resolveSubscribers("flagship", "americas", "available");
    const flagshipUserIds = flagshipSubs.map((s) => s.userId);

    expect(flagshipUserIds).toContain(user1.id);
    expect(flagshipUserIds).not.toContain(user2.id); // User 2 is excluded!

    // Event: Frontier Americas is available
    const frontierSubs = index.resolveSubscribers("frontier", "americas", "available");
    const frontierUserIds = frontierSubs.map((s) => s.userId);

    expect(frontierUserIds).toContain(user1.id);
    expect(frontierUserIds).toContain(user2.id); // User 2 receives Frontier!
  });

  it("3. NotificationDispatcher: hydrates pending alerts from SQLite Outbox upon reboot and drains them", async () => {
    const user = userDao.upsertUser({ telegram_id: 999, first_name: "RebootUser", language: "uk" });
    index.hydrateFromDatabase();

    // Seed an un-dispatched message in Outbox (as if container crashed before sending)
    outboxDao.enqueue({
      id: "crash-recovery-msg-1",
      userId: user.id,
      telegramId: 999,
      priority: "P1",
      messageText: "Recovered slot alert",
      disableNotification: false,
      eventType: "available",
      poolSlug: "flagship",
      blockId: "asia",
      status: "pending",
      attempts: 0,
    });

    const sentMessages: any[] = [];
    const mockBot: any = {
      api: {
        sendMessage: vi.fn(async (chatId, text, extra) => {
          sentMessages.push({ chatId, text, extra });
          return { message_id: 12345 };
        }),
      },
    };

    // Instantiate new dispatcher on reboot
    const rebootDispatcher = new NotificationDispatcher(
      mockBot,
      userDao,
      logDao,
      undefined,
      index,
      undefined,
      outboxDao
    );

    // Flush pending during shutdown / test drain
    await rebootDispatcher.flushPending();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].chatId).toBe(999);
    expect(sentMessages[0].text).toContain("Recovered slot alert");

    // Outbox should now be marked dispatched
    const remainingPending = outboxDao.getPending(10);
    expect(remainingPending).toHaveLength(0);

    rebootDispatcher.stop();
  });
});
