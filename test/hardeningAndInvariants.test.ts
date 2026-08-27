import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { ModelSemanticMatcher } from "../src/engine/modelSemanticMatcher.js";
import { SlotDiffEngine } from "../src/engine/diffEngine.js";
import { formatRelativeTime } from "../src/i18n/index.js";
import { SubscriberInvertedIndex } from "../src/bot/notifier/subscriberIndex.js";
import { NotificationLogDAO } from "../src/db/dao/notificationLogs.js";
import { ProxyPool } from "../src/proxy/proxyPool.js";
import { TorManager } from "../src/proxy/torManager.js";
import { PoolsSnapshot } from "../src/types/domain.js";

describe("Hardening & Mathematical Invariants Test Suite", () => {
  describe("1. ModelSemanticMatcher Earliest Token Index Anchor", () => {
    it("should correctly classify hybrid models by earliest token index", () => {
      const hybrid = ModelSemanticMatcher.parseModel("deepseek-r1-distill-qwen-32b");
      expect(hybrid.family).toBe("deepseek");
      expect(hybrid.versionStr).toBe("1");

      const qwen = ModelSemanticMatcher.parseModel("qwen-2.5-72b-instruct");
      expect(qwen.family).toBe("qwen");
      expect(qwen.versionStr).toBe("2.5");

      const kimi = ModelSemanticMatcher.parseModel("kimi-k3-preview");
      expect(kimi.family).toBe("kimi");
      expect(kimi.versionStr).toBe("3");

      const glm = ModelSemanticMatcher.parseModel("glm-4-plus");
      expect(glm.family).toBe("glm");
      expect(glm.versionStr).toBe("4");
    });
  });

  describe("2. DiffEngine Glitch Resilience & Startup Invariants", () => {
    let diffEngine: SlotDiffEngine;

    beforeEach(() => {
      diffEngine = new SlotDiffEngine();
    });

    it("should not corrupt slot state or trigger false price drops on transient empty/zero price glitch", () => {
      const initialSnapshot: PoolsSnapshot = {
        timestamp: Date.now(),
        source: "api_json",
        data: [
          {
            id: "frontier",
            slug: "frontier",
            modelId: "frontier",
            modelName: "Frontier Pool",
            models: ["qwen-2.5-72b"],
            description: "High performance",
            status: "active",
            minPricePerDay: "99.00",
            annualDiscount: 0.15,
            blocks: [
              { block: "asia", hoursUtc: "00:00-08:00 UTC", pricePerMonth: "99.00", status: "available" },
            ],
          },
        ],
      };

      // 1. Cold start baseline
      diffEngine.processSnapshot(initialSnapshot);

      // 2. Upstream glitch: pricePerMonth is suddenly empty string ""
      const glitchSnapshot: PoolsSnapshot = {
        timestamp: Date.now() + 1000,
        source: "api_json",
        data: [
          {
            ...initialSnapshot.data[0],
            blocks: [
              { block: "asia", hoursUtc: "00:00-08:00 UTC", pricePerMonth: "", status: "available" },
            ],
          },
        ],
      };

      const glitchEvents = diffEngine.processSnapshot(glitchSnapshot);
      // Glitch should be ignored: NO SLOT_PRICE_CHANGED with -100%
      expect(glitchEvents.filter((e) => e.type === "SLOT_PRICE_CHANGED")).toHaveLength(0);

      // 3. Upstream recovers with normal price
      const recoveredSnapshot: PoolsSnapshot = {
        timestamp: Date.now() + 2000,
        source: "api_json",
        data: [
          {
            ...initialSnapshot.data[0],
            blocks: [
              { block: "asia", hoursUtc: "00:00-08:00 UTC", pricePerMonth: "99.00", status: "available" },
            ],
          },
        ],
      };
      const recoveredEvents = diffEngine.processSnapshot(recoveredSnapshot);
      expect(recoveredEvents).toHaveLength(0);
    });

    it("should hydrate infraSpec and manualProvisioning without emitting false tier updates", () => {
      const records = [
        {
          pool_slug: "flagship",
          pool_name: "Flagship Pool",
          models_json: JSON.stringify(["kimi-k3"]),
          block_id: "asia",
          status: "sold-out",
          hours_utc: "00:00-08:00 UTC",
          price_month: "149.00",
          min_price_day: "149.00",
          annual_discount: 0.15,
          description: "Top tier",
          infra_spec: "8x H100 SXM5",
          manual_provisioning: 1,
        },
      ];

      diffEngine.bootstrapFromDao(records);

      const liveScrape: PoolsSnapshot = {
        timestamp: Date.now(),
        source: "api_json",
        data: [
          {
            id: "flagship",
            slug: "flagship",
            modelId: "flagship",
            modelName: "Flagship Pool",
            models: ["kimi-k3"],
            description: "Top tier",
            infraSpec: "8x H100 SXM5",
            manualProvisioning: true,
            status: "active",
            minPricePerDay: "149.00",
            annualDiscount: 0.15,
            blocks: [
              { block: "asia", hoursUtc: "00:00-08:00 UTC", pricePerMonth: "149.00", status: "sold-out" },
            ],
          },
        ],
      };

      const events = diffEngine.processSnapshot(liveScrape);
      expect(events).toHaveLength(0);
    });
  });

  describe("3. formatRelativeTime Localization Accuracy", () => {
    it("should format timestamps accurately in uk, en, ru", () => {
      const now = Date.now();
      expect(formatRelativeTime(now - 1000, "uk")).toBe("щойно");
      expect(formatRelativeTime(now - 1000, "en")).toBe("just now");
      expect(formatRelativeTime(now - 1000, "ru")).toBe("только что");

      expect(formatRelativeTime(now - 25000, "uk")).toBe("25с тому");
      expect(formatRelativeTime(now - 25000, "en")).toBe("25s ago");
      expect(formatRelativeTime(now - 25000, "ru")).toBe("25с назад");

      expect(formatRelativeTime(now - 300000, "uk")).toBe("5хв тому");
      expect(formatRelativeTime(now - 300000, "en")).toBe("5m ago");
      expect(formatRelativeTime(now - 300000, "ru")).toBe("5мин назад");

      expect(formatRelativeTime(0, "uk")).toBe("невідомо");
      expect(formatRelativeTime(0, "en")).toBe("unknown");
    });
  });

  describe("4. SubscriberInvertedIndex SQLite Timestamp Parsing", () => {
    it("should parse SQLite YYYY-MM-DD HH:MM:SS string without returning NaN", () => {
      const db = new Database(":memory:");
      db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          telegram_id INTEGER NOT NULL UNIQUE,
          username TEXT,
          first_name TEXT NOT NULL,
          language TEXT DEFAULT 'uk',
          is_muted INTEGER DEFAULT 0,
          is_active INTEGER DEFAULT 1,
          notify_available_global INTEGER DEFAULT 1,
          notify_sold_out_global INTEGER DEFAULT 0,
          notify_models_global INTEGER DEFAULT 1,
          notify_prices_global INTEGER DEFAULT 1,
          last_active_at TEXT DEFAULT '2026-08-27 10:30:00'
        );
        CREATE TABLE subscriptions (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL,
          pool_slug TEXT NOT NULL,
          block_id TEXT NOT NULL,
          notify_on_available INTEGER DEFAULT 1,
          notify_on_sold_out INTEGER DEFAULT 0,
          notify_on_models INTEGER DEFAULT 1,
          notify_on_prices INTEGER DEFAULT 1
        );
        INSERT INTO users (id, telegram_id, first_name, last_active_at)
        VALUES (1, 999111, 'Tester', '2026-08-27 10:30:00');
      `);

      const index = new SubscriberInvertedIndex(db);
      const profile = index.getProfileByTgId(999111);
      expect(profile).toBeDefined();
      expect(profile?.lastActiveAt).toBeGreaterThan(0);
      expect(Number.isNaN(profile?.lastActiveAt)).toBe(false);
    });
  });

  describe("5. NotificationLogDAO FK Constraint Safety", () => {
    it("should safely ignore synthetic userIds <= 0", () => {
      const db = new Database(":memory:");
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE users (id INTEGER PRIMARY KEY);
        CREATE TABLE notification_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          pool_slug TEXT NOT NULL,
          block_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
      `);

      const logDao = new NotificationLogDAO(db);
      // userId = 0 (synthetic test alert) should not throw FK error
      logDao.logNotification(0, "flagship", "asia", "SLOT_APPEARED");
      logDao.flush();
      expect(logDao.getRecentHourCount()).toBe(0);
      logDao.close();
    });
  });

  describe("6. 3-Tier Proxy Cascade & Auto-Quarantine", () => {
    it("should prioritize Direct Fast-Path (Priority 1) and auto-failover to Tor (Priority 3) on WAF 403", async () => {
      const torManager = new TorManager({ socksHost: "127.0.0.1", socksPort: 9050 });
      const pool = new ProxyPool(torManager, true);
      
      // Tier 2: Direct is primary fast-path
      const initial = pool.getNextProxyUrl();
      expect(initial).toBeNull();

      // Direct gets Cloudflare 403 WAF block -> demotes to Tier 3 (Tor)
      await pool.reportFailure(null, 403);
      const torFallback = pool.getNextProxyUrl();
      expect(torFallback).toContain("tor_");

      // Tor fails 3 consecutive times -> Tor is quarantined
      await pool.reportFailure(torFallback, 500);
      await pool.reportFailure(torFallback, 500);
      await pool.reportFailure(torFallback, 500);

      const status = pool.getStatus();
      const torEntry = status.proxies.find((p) => p.type === "tor");
      expect(torEntry?.isBanned).toBe(true);
    });

    it("should prioritize Cloudflare Worker (Priority 0) over Direct and Tor", async () => {
      const torManager = new TorManager({ socksHost: "127.0.0.1", socksPort: 9050 });
      const workerUrl = "https://cf-fastpath.workers.dev";
      const pool = new ProxyPool(torManager, true, [], workerUrl);

      // Tier 1: Worker is Priority 0
      const initial = pool.getNextProxy();
      expect(initial.type).toBe("worker");
      expect(initial.url).toBe(workerUrl);

      // Worker gets 403 -> demotes to Tier 2 (Direct)
      await pool.reportFailure(workerUrl, 403);
      const second = pool.getNextProxy();
      expect(second.type).toBe("direct");
      expect(second.url).toBe("");
    });
  });
});
