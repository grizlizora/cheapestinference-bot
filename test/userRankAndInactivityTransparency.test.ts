/**
 * test/userRankAndInactivityTransparency.test.ts
 * Comprehensive test suite verifying:
 * 1. getUserRankMeta for Admin, Diamond, Speed, Contributor, Supporter, Active, Dormant
 * 2. 403 Deactivation & Instant Zero-Loss Revival with RAM Subscription preservation
 * 3. NotificationOutboxDAO markTerminalFailed immediate status transition
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/index.js";
import { UserDAO } from "../src/db/dao/users.js";
import { SubscriptionDAO } from "../src/db/dao/subscriptions.js";
import { NotificationOutboxDAO } from "../src/db/dao/notificationOutbox.js";
import { SubscriberInvertedIndex } from "../src/bot/notifier/subscriberIndex.js";
import { getUserRankMeta, renderUserProfileCard } from "../src/bot/views/userRankHelper.js";

describe("🌟 User Rank, Inactivity Transparency & 403 Revival Suite", () => {
  let db: Database.Database;
  let userDao: UserDAO;
  let subDao: SubscriptionDAO;
  let outboxDao: NotificationOutboxDAO;
  let index: SubscriberInvertedIndex;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    userDao = new UserDAO(db);
    subDao = new SubscriptionDAO(db);
    outboxDao = new NotificationOutboxDAO(db);
    index = new SubscriberInvertedIndex(db);
  });

  describe("1. User Rank & Transparency Metas", () => {
    it("should correctly classify Admin with lifetime immunity and P0 queue", () => {
      const meta = getUserRankMeta({ isAdmin: true, totalDonatedStars: 0 }, "uk");
      expect(meta.tier).toBe("admin");
      expect(meta.isAdmin).toBe(true);
      expect(meta.priorityTitle).toContain("P0");
      expect(meta.retentionText).toContain("Безстроковий імунітет");
    });

    it("should correctly classify Diamond Patron (250+ Stars)", () => {
      const meta = getUserRankMeta({ isAdmin: false, totalDonatedStars: 500 }, "en");
      expect(meta.tier).toBe("diamond");
      expect(meta.priorityTitle).toContain("P1 • Top Queue");
      expect(meta.bonusDays).toBeGreaterThan(400);
      expect(meta.retentionText).toContain("Active for");
    });

    it("should correctly classify Speed Patron (100-249 Stars)", () => {
      const meta = getUserRankMeta({ isAdmin: false, totalDonatedStars: 150 }, "ru");
      expect(meta.tier).toBe("speed");
      expect(meta.priorityTitle).toContain("P1");
      expect(meta.bonusDays).toBeGreaterThan(100);
    });

    it("should correctly classify Supporter (1-49 Stars)", () => {
      const meta = getUserRankMeta({ isAdmin: false, totalDonatedStars: 15 }, "uk");
      expect(meta.tier).toBe("supporter");
      expect(meta.priorityTitle).toContain("P1 • Пріоритетна черга");
      expect(meta.bonusDays).toBe(30); // 15 * 2.0
    });

    it("should correctly classify Active Free User within 14 days", () => {
      const meta = getUserRankMeta({ isAdmin: false, totalDonatedStars: 0 }, "uk");
      expect(meta.tier).toBe("active");
      expect(meta.priorityTitle).toContain("P2 • Стандартна черга");
      expect(meta.remainingDays).toBe(14);
      expect(meta.isDormant).toBe(false);
    });

    it("should correctly classify Dormant User (>14 days inactive)", () => {
      const now = Date.now();
      const fifteenDaysAgo = now - 15 * 24 * 60 * 60 * 1000;
      const meta = getUserRankMeta(
        { isAdmin: false, totalDonatedStars: 0, lastActiveAt: fifteenDaysAgo },
        "uk",
        now
      );
      expect(meta.tier).toBe("dormant");
      expect(meta.isDormant).toBe(true);
      expect(meta.priorityTitle).toContain("Призупинено");
    });

    it("should render clean User Profile Card across all languages", () => {
      const cardUk = renderUserProfileCard({ isAdmin: true, telegramId: 12345 }, "uk");
      expect(cardUk).toContain("Профіль та статус");
      expect(cardUk).toContain("Адміністратор");

      const cardEn = renderUserProfileCard({ isAdmin: false, totalDonatedStars: 100, telegramId: 12345 }, "en");
      expect(cardEn).toContain("Profile & Status");
      expect(cardEn).toContain("Speed Patron");
    });
  });

  describe("2. 403 Deactivation & Instant Zero-Loss Revival Invariants", () => {
    it("should preserve user subscriptions upon 403 deactivation and immediately restore alert dispatch on user touch", () => {
      // 1. Create user and subscribe to flagship
      const user = userDao.upsertUser({
        telegram_id: 999111,
        first_name: "RevivalUser",
        language: "uk",
      });
      subDao.setSubscription(user.id, "flagship", "ALL", true);
      index.hydrateFromDatabase();

      // Verify active dispatch
      let subscribers = index.resolveSubscribers("flagship", "block_1", "available");
      expect(subscribers.map((s) => s.telegramId)).toContain(999111);

      // 2. Telegram returns 403 -> deactivation fast-path
      index.markUserDeactivated(999111);

      // Verify user is excluded from dispatch while deactivated
      subscribers = index.resolveSubscribers("flagship", "block_1", "available");
      expect(subscribers.map((s) => s.telegramId)).not.toContain(999111);

      // 3. User unblocks and sends /start (Reactivation)
      index.updateUserPreferences(999111, { isActive: true });
      index.touchLastActive(999111);

      // Invariant: Subscriptions are 100% intact in RAM and immediately receive alerts!
      subscribers = index.resolveSubscribers("flagship", "block_1", "available");
      expect(subscribers.map((s) => s.telegramId)).toContain(999111);
    });
  });

  describe("3. NotificationOutboxDAO markTerminalFailed", () => {
    it("should transition outbox record to 'failed' on terminal error without needing 3 attempts", () => {
      outboxDao.enqueue({
        id: "term-msg-1",
        userId: 1,
        telegramId: 999111,
        priority: "P1",
        messageText: "Test",
        disableNotification: false,
        eventType: "available",
        status: "pending",
        attempts: 0,
      });

      outboxDao.markTerminalFailed("term-msg-1", "User deactivated or blocked");

      const pending = outboxDao.getPending(10);
      expect(pending.some((p) => p.id === "term-msg-1")).toBe(false);

      const row = db.prepare("SELECT status, attempts, last_error FROM notification_outbox WHERE id = ?").get("term-msg-1") as any;
      expect(row.status).toBe("failed");
      expect(row.attempts).toBe(1);
      expect(row.last_error).toBe("User deactivated or blocked");
    });
  });
});
