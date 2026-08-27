import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/index.js";
import { SlotHistoryDAO } from "../src/db/dao/slotHistory.js";
import { CatalogHistoryDAO } from "../src/db/dao/catalogHistory.js";
import { UserDAO } from "../src/db/dao/users.js";
import { SubscriptionDAO } from "../src/db/dao/subscriptions.js";
import { NotificationLogDAO } from "../src/db/dao/notificationLogs.js";
import { SubscriberInvertedIndex } from "../src/bot/notifier/subscriberIndex.js";
import { NotificationDispatcher } from "../src/bot/notifier/dispatcher.js";
import { SlotDiffEngine } from "../src/engine/diffEngine.js";
import { DiffEvent } from "../src/types/domain.js";

describe("Predictive Price Analytics (ATL/Fair Value) & Disappeared ETA Alerts Test Suite", () => {
  let db: Database.Database;
  let slotHistoryDao: SlotHistoryDAO;
  let catalogHistoryDao: CatalogHistoryDAO;
  let userDao: UserDAO;
  let subDao: SubscriptionDAO;
  let logDao: NotificationLogDAO;
  let invertedIndex: SubscriberInvertedIndex;
  let dispatcher: NotificationDispatcher;
  let diffEngine: SlotDiffEngine;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    slotHistoryDao = new SlotHistoryDAO(db);
    catalogHistoryDao = new CatalogHistoryDAO(db);
    userDao = new UserDAO(db);
    subDao = new SubscriptionDAO(db);
    logDao = new NotificationLogDAO(db);
    invertedIndex = new SubscriberInvertedIndex(db);
    dispatcher = new NotificationDispatcher({} as any, invertedIndex, userDao, logDao);
    diffEngine = new SlotDiffEngine(slotHistoryDao, catalogHistoryDao);
  });

  afterEach(() => {
    db.close();
  });

  describe("1. CatalogHistoryDAO Price Analytics & Fair Value Evaluation", () => {
    it("should return insufficient_data when sample count < 3", () => {
      // Seed only 2 price changes
      catalogHistoryDao.recordSlotPriceChange("flagship", "europe", "$120", "$110", -10, -8.3);
      catalogHistoryDao.recordSlotPriceChange("flagship", "europe", "$110", "$100", -10, -9.1);

      const analytics = catalogHistoryDao.getPriceAnalytics("flagship", "europe", 95);
      expect(analytics.sampleCount).toBe(2);
      expect(analytics.rating).toBe("insufficient_data");
    });

    it("should detect all_time_low (ATL) when price is at or below historical min (N >= 3)", () => {
      // Seed 4 historical price points: 150, 140, 130, 120
      catalogHistoryDao.recordSlotPriceChange("flagship", "europe", "$160", "$150", -10, -6.25);
      catalogHistoryDao.recordSlotPriceChange("flagship", "europe", "$150", "$140", -10, -6.67);
      catalogHistoryDao.recordSlotPriceChange("flagship", "europe", "$140", "$130", -10, -7.14);
      catalogHistoryDao.recordSlotPriceChange("flagship", "europe", "$130", "$120", -10, -7.69);

      // Now price drops to $99 (below minimum $120)
      const analytics = catalogHistoryDao.getPriceAnalytics("flagship", "europe", 99);
      expect(analytics.sampleCount).toBe(4);
      expect(analytics.minPrice).toBe(120);
      expect(analytics.rating).toBe("all_time_low");
    });

    it("should classify prices accurately: below_average vs above_average vs fair", () => {
      // Seed price records around average $100 (e.g. 90, 100, 110)
      catalogHistoryDao.recordSlotPriceChange("core", "asia", "$80", "$90", 10, 12.5);
      catalogHistoryDao.recordSlotPriceChange("core", "asia", "$90", "$100", 10, 11.1);
      catalogHistoryDao.recordSlotPriceChange("core", "asia", "$100", "$110", 10, 10.0);

      // Avg is $100
      const below = catalogHistoryDao.getPriceAnalytics("core", "asia", 92);
      expect(below.rating).toBe("below_average");

      const fair = catalogHistoryDao.getPriceAnalytics("core", "asia", 100);
      expect(fair.rating).toBe("fair");

      const above = catalogHistoryDao.getPriceAnalytics("core", "asia", 115);
      expect(above.rating).toBe("above_average");
    });
  });

  describe("2. SLOT_DISAPPEARED Alert with Reappearance ETA", () => {
    it("should include ETA forecast when slot closes and historical samples N >= 3 exist", () => {
      // Seed 4 slot cycles ~24h apart
      const now = Date.now();
      const daySec = 86400;
      for (let i = 4; i >= 1; i--) {
        const openEpoch = Math.round((now - i * daySec * 1000) / 1000);
        const closeEpoch = openEpoch + 3600;
        db.prepare(`
          INSERT INTO slot_lifecycle_history (pool_slug, block_id, initial_status, price_month, opened_at, closed_at, duration_seconds)
          VALUES ('flagship', 'europe', 'available', '$99', datetime(${openEpoch}, 'unixepoch'), datetime(${closeEpoch}, 'unixepoch'), 3600)
        `).run();
      }

      const event: DiffEvent = {
        id: "disappear-1",
        type: "SLOT_DISAPPEARED",
        poolSlug: "flagship",
        poolName: "Flagship Pool",
        block: "europe",
        models: ["claude-3-7-sonnet"],
        hoursUtc: "08:00 – 16:00 UTC",
        timestamp: Date.now(),
        analytics: {
          avgLifespanFormatted: "",
          avgLifespanSeconds: null,
          demandCategory: "unknown",
          isBatchDrop: false,
          dropPattern: "UNKNOWN",
          totalOpenings: 4,
          eta: {
            isPredictable: true,
            sampleCount: 4,
            minRequired: 3,
            confidence: "HIGH",
            confidenceScore: 85,
            medianDowntimeSeconds: 82800,
            downtimeIqrLowSeconds: 82800,
            downtimeIqrHighSeconds: 82800,
            detectedCadenceHours: 24,
            expectedOpenTimestampMin: now + 82800 * 1000,
            expectedOpenTimestampMax: now + 82800 * 1000,
            formattedEtaWindow: "~23.0год",
          },
        },
      };

      const user = {
        userId: 1,
        telegramId: 123456789,
        language: "uk" as const,
        isMuted: false,
        isActive: true,
        notifyAvailableGlobal: true,
        notifySoldOutGlobal: true,
        notifyModelsGlobal: true,
        notifyPricesGlobal: true,
        lastActiveAt: Date.now(),
      };

      const msg = (dispatcher as any).formatAlertMessage(user, event, "P2");
      expect(msg.text).toContain("СЛОТ РОЗПРОДАНО");
      expect(msg.text).toContain("Очікувана поява");
      expect(msg.text).toContain("добовий цикл ~24h");
      expect(msg.text).toContain("Висока точність");
    });
  });

  describe("3. SLOT_PRICE_CHANGED Alert with ATL Badge", () => {
    it("should render ATL badge in price alert when rating is all_time_low", () => {
      const event: DiffEvent = {
        id: "price-drop-1",
        type: "SLOT_PRICE_CHANGED",
        poolSlug: "flagship",
        poolName: "Flagship Pool",
        block: "europe",
        models: ["claude-3-7-sonnet"],
        hoursUtc: "08:00 – 16:00 UTC",
        previousPrice: "$120",
        newPrice: "$85",
        timestamp: Date.now(),
        slotPrice: {
          block: "europe",
          hoursUtc: "08:00 – 16:00 UTC",
          previousPrice: "$120",
          newPrice: "$85",
          priceDelta: -35,
          percentageDelta: -29.2,
          isDiscount: true,
          priceAnalytics: {
            rating: "all_time_low",
            minPrice: 99,
            avgPrice: 110,
            maxPrice: 130,
            sampleCount: 5,
          },
        },
      };

      const user = {
        userId: 1,
        telegramId: 123456789,
        language: "uk" as const,
        isMuted: false,
        isActive: true,
        notifyAvailableGlobal: true,
        notifySoldOutGlobal: true,
        notifyModelsGlobal: true,
        notifyPricesGlobal: true,
        lastActiveAt: Date.now(),
      };

      const msg = (dispatcher as any).formatAlertMessage(user, event, "P1");
      expect(msg.text).toContain("ЗМІНА ЦІНИ СЛОТА");
      expect(msg.text).toContain("Знижка: -$35/міс (-29.2%)");
      expect(msg.text).toContain("Історичний мінімум (ATL)");
    });
  });
});
