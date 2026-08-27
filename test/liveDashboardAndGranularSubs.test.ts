import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { UserDAO } from "../src/db/dao/users.js";
import { SubscriptionDAO } from "../src/db/dao/subscriptions.js";
import { SubscriberInvertedIndex } from "../src/bot/notifier/subscriberIndex.js";
import { ActiveDashboardRegistry, fnv1a32 } from "../src/bot/liveSync/dashboardRegistry.js";

describe("Live Dashboard Registry & Granular Subscriptions Test Suite", () => {
  let db: Database.Database;
  let userDao: UserDAO;
  let subDao: SubscriptionDAO;
  let invertedIndex: SubscriberInvertedIndex;

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

    userDao = new UserDAO(db);
    subDao = new SubscriptionDAO(db);
    invertedIndex = new SubscriberInvertedIndex(db);
  });

  describe("1. Granular Per-Pool Event Subscriptions", () => {
    it("should allow independent per-pool event preferences", () => {
      const user = userDao.upsertUser({
        telegram_id: 77777,
        username: "pro_trader",
        first_name: "Pro",
        language: "uk",
      });

      invertedIndex.upsertUserProfile({
        userId: user.id,
        telegramId: user.telegram_id,
        language: "uk",
        isMuted: false,
        isActive: true,
        notifyAvailableGlobal: true,
        notifySoldOutGlobal: true,
        notifyModelsGlobal: true,
        notifyPricesGlobal: true,
      });

      // Initially Flagship has default flags
      const initialFlags = subDao.getPoolFlags(user.id, "flagship");
      expect(initialFlags.available).toBe(true);
      expect(initialFlags.soldOut).toBe(false);

      // Toggle Sold Out on Flagship
      const resSold = subDao.togglePoolEventCategory(user.id, "flagship", "sold_out", ["asia", "europe", "americas"]);
      expect(resSold.newState).toBe(true);
      expect(resSold.flags.notify_on_sold_out).toBe(1);

      // Toggle Models OFF on Flagship
      const resModels = subDao.togglePoolEventCategory(user.id, "flagship", "models", ["asia", "europe", "americas"]);
      expect(resModels.newState).toBe(false);
      expect(resModels.flags.notify_on_models).toBe(0);

      // Core pool remains independent
      const coreFlags = subDao.getPoolFlags(user.id, "core");
      expect(coreFlags.soldOut).toBe(false);
      expect(coreFlags.models).toBe(true);

      // Check Inverted Index resolution for Flagship vs Core
      invertedIndex.updateSubscription(user.id, "flagship", "ALL", {
        available: true,
        soldOut: true,
        models: false,
        prices: true,
      });

      const flagshipSoldSubscribers = invertedIndex.resolveSubscribers("flagship", "asia", "sold_out");
      expect(flagshipSoldSubscribers.map((s) => s.userId)).toContain(user.id);

      const flagshipModelSubscribers = invertedIndex.resolveSubscribers("flagship", "asia", "models");
      expect(flagshipModelSubscribers.map((s) => s.userId)).not.toContain(user.id);
    });
  });

  describe("2. ActiveDashboardRegistry & FNV-1a Hash Diffing", () => {
    it("should register, update, and detect text changes with FNV-1a", () => {
      const registry = new ActiveDashboardRegistry();
      registry.register(1001, 555, 1, "uk", "dashboard");

      const session = registry.get(1001);
      expect(session).toBeDefined();
      expect(session?.viewType).toBe("dashboard");

      const text1 = "Dashboard State 1";
      const text2 = "Dashboard State 2";
      const hash1 = fnv1a32(text1);
      const hash2 = fnv1a32(text2);
      const hash1Again = fnv1a32(text1);

      expect(hash1).not.toBe(hash2);
      expect(hash1).toBe(hash1Again);

      registry.updateView(1001, "pool_detail", "core");
      const updated = registry.get(1001);
      expect(updated?.viewType).toBe("pool_detail");
      expect(updated?.poolSlug).toBe("core");

      const active = registry.getActiveSessions();
      expect(active).toHaveLength(1);
      expect(active[0].chatId).toBe(1001);

      registry.remove(1001);
      expect(registry.get(1001)).toBeUndefined();
    });
  });
});
