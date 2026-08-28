import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/index.js";
import { SlotHistoryDAO } from "../src/db/dao/slotHistory.js";
import { CatalogHistoryDAO } from "../src/db/dao/catalogHistory.js";
import { UserDAO } from "../src/db/dao/users.js";
import { SubscriptionDAO } from "../src/db/dao/subscriptions.js";
import { NotificationLogDAO } from "../src/db/dao/notificationLogs.js";
import { SubscriberInvertedIndex, PackedUserProfile } from "../src/bot/notifier/subscriberIndex.js";
import { NotificationDispatcher } from "../src/bot/notifier/dispatcher.js";
import { PredictiveAnalyticsEngine } from "../src/engine/predictiveEngine.js";
import { AvailabilityIntelligenceEngine } from "../src/engine/intelligenceEngine.js";
import { DiffEvent, SupportedLanguage } from "../src/types/domain.js";

describe("🌟 Ultimate Realistic Multi-Day Real-World Simulation Test Suite", () => {
  let db: Database.Database;
  let slotHistoryDao: SlotHistoryDAO;
  let catalogHistoryDao: CatalogHistoryDAO;
  let userDao: UserDAO;
  let subDao: SubscriptionDAO;
  let logDao: NotificationLogDAO;
  let invertedIndex: SubscriberInvertedIndex;
  let predictiveEngine: PredictiveAnalyticsEngine;
  let intelligenceEngine: AvailabilityIntelligenceEngine;
  let dispatcher: NotificationDispatcher;

  const POOL = "flagship";
  const BLOCK = "europe";

  const createUser = (id: number, tgId: number, lang: SupportedLanguage): PackedUserProfile => ({
    userId: id,
    telegramId: tgId,
    language: lang,
    isMuted: false,
    isActive: true,
    notifyAvailableGlobal: true,
    notifySoldOutGlobal: true,
    notifyModelsGlobal: true,
    notifyPricesGlobal: true,
    lastActiveAt: Date.now(),
  });

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    slotHistoryDao = new SlotHistoryDAO(db);
    catalogHistoryDao = new CatalogHistoryDAO(db);
    userDao = new UserDAO(db);
    subDao = new SubscriptionDAO(db);
    logDao = new NotificationLogDAO(db);
    invertedIndex = new SubscriberInvertedIndex(db);
    predictiveEngine = new PredictiveAnalyticsEngine(slotHistoryDao);
    intelligenceEngine = new AvailabilityIntelligenceEngine(slotHistoryDao);
    dispatcher = new NotificationDispatcher({} as any, userDao, logDao, slotHistoryDao, invertedIndex);
  });

  afterEach(() => {
    db.close();
  });

  // --------------------------------------------------------------------------
  // STAGE 1: Cold Start & Gating Thresholds (N = 0 -> 2)
  // --------------------------------------------------------------------------
  describe("Stage 1: Cold Start & Gating Thresholds (N=0 -> 2)", () => {
    it("should report gathering data status for ETA when sample size N < 3", () => {
      const now = Date.now();
      const open1 = Math.round((now - 172800 * 1000) / 1000); // -2 days
      const close1 = open1 + 600; // Open for 10 min
      const open2 = Math.round((now - 86400 * 1000) / 1000);  // -1 day
      const close2 = open2 + 600;

      // Seed 2 cycles (only 1 downtime interval: open2 - close1)
      db.prepare(`
        INSERT INTO slot_lifecycle_history (pool_slug, block_id, initial_status, price_month, opened_at, closed_at, duration_seconds)
        VALUES ('${POOL}', '${BLOCK}', 'available', '$120', datetime(${open1}, 'unixepoch'), datetime(${close1}, 'unixepoch'), 600)
      `).run();
      db.prepare(`
        INSERT INTO slot_lifecycle_history (pool_slug, block_id, initial_status, price_month, opened_at, closed_at, duration_seconds)
        VALUES ('${POOL}', '${BLOCK}', 'available', '$120', datetime(${open2}, 'unixepoch'), datetime(${close2}, 'unixepoch'), 600)
      `).run();

      const downtimes = slotHistoryDao.getDowntimeIntervals(POOL, BLOCK);
      expect(downtimes.length).toBe(1);

      const eta = predictiveEngine.predictNextAvailability(POOL, BLOCK, "sold-out");
      expect(eta.isPredictable).toBe(false);
      expect(eta.sampleCount).toBe(1);
      expect(eta.minRequired).toBe(3);
      expect(eta.confidence).toBe("INSUFFICIENT_DATA");
      expect(eta.confidenceScore).toBe(0);

      // Verify Disappeared Alert rendering in UK, EN, RU
      const event: DiffEvent = {
        id: "disappear-cold-1",
        type: "SLOT_DISAPPEARED",
        poolSlug: POOL,
        poolName: "Flagship Pool",
        block: BLOCK,
        models: ["claude-3-7-sonnet"],
        hoursUtc: "08:00 – 16:00 UTC",
        timestamp: now,
        analytics: {
          avgLifespanFormatted: "~10 min",
          avgLifespanSeconds: 600,
          demandCategory: "hot",
          isBatchDrop: false,
          dropPattern: "UNKNOWN",
          totalOpenings: 2,
          eta,
        },
      };

      const msgUk = (dispatcher as any).formatAlertMessage(createUser(1, 101, "uk"), event, "P3");
      expect(msgUk.text).toContain("Збір статистики (1/3)");

      const msgEn = (dispatcher as any).formatAlertMessage(createUser(2, 102, "en"), event, "P3");
      expect(msgEn.text).toContain("Collecting stats (1/3)");

      const msgRu = (dispatcher as any).formatAlertMessage(createUser(3, 103, "ru"), event, "P3");
      expect(msgRu.text).toContain("Сбор статистики (1/3)");

      // Verify Menu Intelligence SmartStatus
      const smartStatus = intelligenceEngine.getSmartStatus(POOL, BLOCK, "sold-out", "uk");
      expect(smartStatus.collectingStatsTip).toContain("Збір статистики (1/3)");
      expect(smartStatus.etaTip).toBeUndefined();
    });

    it("should suppress price rating badges when price change samples N < 3", () => {
      // Record 1st price change
      catalogHistoryDao.recordSlotPriceChange(POOL, BLOCK, "$120", "$110", -10, -8.3);

      const priceAnalytics = catalogHistoryDao.getPriceAnalytics(POOL, BLOCK, 110);
      expect(priceAnalytics.sampleCount).toBe(1);
      expect(priceAnalytics.rating).toBe("insufficient_data");

      const event: DiffEvent = {
        id: "price-cold-1",
        type: "SLOT_PRICE_CHANGED",
        poolSlug: POOL,
        poolName: "Flagship Pool",
        block: BLOCK,
        hoursUtc: "08:00 – 16:00 UTC",
        previousPrice: "$120",
        newPrice: "$110",
        timestamp: Date.now(),
        slotPrice: {
          block: BLOCK,
          hoursUtc: "08:00 – 16:00 UTC",
          previousPrice: "$120",
          newPrice: "$110",
          priceDelta: -10,
          percentageDelta: -8.3,
          isDiscount: true,
          priceAnalytics,
        },
      };

      const msg = (dispatcher as any).formatAlertMessage(createUser(1, 101, "uk"), event, "P2");
      expect(msg.text).toContain("Знижка: -$10/міс (-8.3%)");
      expect(msg.text).not.toContain("Історичний мінімум");
      expect(msg.text).not.toContain("Стандартна ринкова ціна");
      expect(msg.text).not.toContain("Нижче середнього");
    });
  });

  // --------------------------------------------------------------------------
  // STAGE 2: Threshold Breach & Mathematical Inception (N = 3)
  // --------------------------------------------------------------------------
  describe("Stage 2: Threshold Breach & Mathematical Inception (N=3)", () => {
    it("should activate ETA predictions and compute initial IQR upon reaching N=3", () => {
      const now = Date.now();
      const intervals = [3600, 3600, 3600]; // 1 hour downtime intervals

      // Seed 4 slots to produce 3 downtime intervals
      let prevClose = Math.round((now - 4 * 3600 * 1000) / 1000);
      for (let i = 0; i < 4; i++) {
        const open = prevClose + (intervals[i - 1] || 0);
        const close = open + 600; // Open for 10 min
        db.prepare(`
          INSERT INTO slot_lifecycle_history (pool_slug, block_id, initial_status, price_month, opened_at, closed_at, duration_seconds)
          VALUES ('${POOL}', '${BLOCK}', 'available', '$120', datetime(${open}, 'unixepoch'), datetime(${close}, 'unixepoch'), 600)
        `).run();
        prevClose = close;
      }

      const downtimes = slotHistoryDao.getDowntimeIntervals(POOL, BLOCK);
      expect(downtimes.length).toBe(3);

      const eta = predictiveEngine.predictNextAvailability(POOL, BLOCK, "sold-out");
      expect(eta.isPredictable).toBe(true);
      expect(eta.sampleCount).toBe(3);
      expect(eta.medianDowntimeSeconds).toBe(3600);
      expect(eta.downtimeIqrLowSeconds).toBe(3600);
      expect(eta.downtimeIqrHighSeconds).toBe(3600);
      expect(eta.confidence).toBe("HIGH"); // Matches 1h candidate cadence
      expect(eta.detectedCadenceHours).toBe(1);

      const profile = predictiveEngine.getDemandProfile(POOL, BLOCK);
      expect(profile.demandCategory).toBe("hot");
      expect(profile.avgFormatted).toBe("~10 min");
    });
  });

  // --------------------------------------------------------------------------
  // STAGE 3: Outlier Pollution Attack & Tukey IQR Defense
  // --------------------------------------------------------------------------
  describe("Stage 3: Outlier Pollution Attack & Tukey IQR Defense", () => {
    it("should successfully reject a 14-day outlier lease and preserve ~14 min lifespan", () => {
      // 10 realistic lifespans (~14 min = 840s) + 1 corrupted 14-day lease (1,209,600s)
      const realisticDurations = [800, 820, 830, 840, 850, 840, 860, 830, 850, 840];
      const outlierDuration = 14 * 86400; // 1,209,600 seconds

      const allDurations = [...realisticDurations, outlierDuration];
      const baseEpoch = 1700000000;

      for (let i = 0; i < allDurations.length; i++) {
        const d = allDurations[i];
        const openEpoch = baseEpoch + i * 20 * 86400;
        const closeEpoch = openEpoch + d;
        db.prepare(`
          INSERT INTO slot_lifecycle_history (pool_slug, block_id, initial_status, price_month, opened_at, closed_at, duration_seconds)
          VALUES ('${POOL}', '${BLOCK}', 'available', '$120', datetime(${openEpoch}, 'unixepoch'), datetime(${closeEpoch}, 'unixepoch'), ${d})
        `).run();
      }

      // Theoretical arithmetic mean without Tukey IQR would be ~110,700s (~30.7 hours = "stable")
      const rawDurations = slotHistoryDao.getRawDurations(POOL, BLOCK);
      expect(rawDurations.length).toBe(11);

      const profile = predictiveEngine.getDemandProfile(POOL, BLOCK);
      expect(profile.totalOpenings).toBe(11);
      expect(profile.sampleCount).toBe(10); // Outlier was rejected!
      expect(profile.medianDurationSeconds).toBe(840);
      expect(profile.demandCategory).toBe("hot");
      expect(profile.avgFormatted).toBe("~14 min");
    });
  });

  // --------------------------------------------------------------------------
  // STAGE 4: 24h Harmonic Cadence & Confidence Escalation (N = 4 -> 7)
  // --------------------------------------------------------------------------
  describe("Stage 4: 24h Harmonic Cadence & Confidence Escalation (N=4 -> 7)", () => {
    it("should detect 24h daily cadence at 08:00 UTC and escalate confidence to HIGH (85%)", () => {
      const now = Date.now();
      const daySec = 86400;

      // Seed 6 daily openings at 08:00 UTC spaced 24 hours apart
      for (let i = 6; i >= 1; i--) {
        const openEpoch = Math.round((now - i * daySec * 1000) / 1000);
        const closeEpoch = openEpoch + 900; // Open for 15 min

        db.prepare(`
          INSERT INTO slot_lifecycle_history (pool_slug, block_id, initial_status, price_month, opened_at, closed_at, duration_seconds)
          VALUES ('${POOL}', '${BLOCK}', 'available', '$120', datetime(${openEpoch}, 'unixepoch'), datetime(${closeEpoch}, 'unixepoch'), 900)
        `).run();
      }

      const eta = predictiveEngine.predictNextAvailability(POOL, BLOCK, "sold-out");
      expect(eta.isPredictable).toBe(true);
      expect(eta.sampleCount).toBe(5);
      expect(eta.detectedCadenceHours).toBe(24);
      expect(eta.confidence).toBe("HIGH");
      expect(eta.confidenceScore).toBe(85);

      const event: DiffEvent = {
        id: "disappear-cadence-1",
        type: "SLOT_DISAPPEARED",
        poolSlug: POOL,
        poolName: "Flagship Pool",
        block: BLOCK,
        hoursUtc: "08:00 – 16:00 UTC",
        timestamp: now,
        analytics: {
          avgLifespanFormatted: "~15 min",
          avgLifespanSeconds: 900,
          demandCategory: "hot",
          isBatchDrop: false,
          dropPattern: "UNKNOWN",
          totalOpenings: 6,
          eta,
        },
      };

      const msgUk = (dispatcher as any).formatAlertMessage(createUser(1, 101, "uk"), event, "P3");
      expect(msgUk.text).toContain("добовий цикл ~24h");
      expect(msgUk.text).toContain("Висока точність");

      const msgEn = (dispatcher as any).formatAlertMessage(createUser(2, 102, "en"), event, "P3");
      expect(msgEn.text).toContain("24h daily cycle");
      expect(msgEn.text).toContain("High confidence");

      const msgRu = (dispatcher as any).formatAlertMessage(createUser(3, 103, "ru"), event, "P3");
      expect(msgRu.text).toContain("суточный цикл ~24ч");
      expect(msgRu.text).toContain("Высокая точность");
    });
  });

  // --------------------------------------------------------------------------
  // STAGE 5: Batch Capacity Expansion Detection
  // --------------------------------------------------------------------------
  describe("Stage 5: Batch Capacity Expansion Detection", () => {
    it("should classify concurrent 3-region opening with catalog upgrade as BATCH_CAPACITY_EXPANSION (score > 0.80)", () => {
      // 14:23:15 UTC (mid-hour, non-boundary)
      const midHourTime = new Date("2026-08-27T14:23:15.000Z").getTime();
      const concurrentCluster = 3;
      const hasCatalogMutation = true;

      const classification = predictiveEngine.classifyDrop(
        POOL,
        BLOCK,
        midHourTime,
        concurrentCluster,
        hasCatalogMutation
      );

      expect(classification.dropType).toBe("BATCH_CAPACITY_EXPANSION");
      expect(classification.clusterSize).toBe(3);
      expect(classification.confidence).toBeGreaterThanOrEqual(0.85);
      expect(classification.isHourlyBoundary).toBe(false);

      const event: DiffEvent = {
        id: "batch-appear-1",
        type: "SLOT_APPEARED",
        poolSlug: POOL,
        poolName: "Flagship Pool",
        block: BLOCK,
        models: ["claude-3-7-sonnet", "deepseek-r1"],
        hoursUtc: "08:00 – 16:00 UTC",
        newPrice: "120",
        newStatus: "available",
        timestamp: midHourTime,
        analytics: {
          avgLifespanFormatted: "~15 min",
          avgLifespanSeconds: 900,
          demandCategory: "hot",
          isBatchDrop: true,
          dropPattern: "BATCH_DROP",
          totalOpenings: 3,
          dropClassification: classification,
        },
      };

      const msgUk = (dispatcher as any).formatAlertMessage(createUser(1, 101, "uk"), event, "P1");
      expect(msgUk.text).toContain("Новий дроп потужностей");

      const msgEn = (dispatcher as any).formatAlertMessage(createUser(2, 102, "en"), event, "P1");
      expect(msgEn.text).toContain("Capacity Drop");
    });
  });

  // --------------------------------------------------------------------------
  // STAGE 6: Real-World Price Dynamics & ATL Triggering
  // --------------------------------------------------------------------------
  describe("Stage 6: Real-World Price Dynamics & ATL Triggering", () => {
    it("should trigger All-Time Low (ATL) when price drops to $79 and Above Average when rising to $130", () => {
      // Historical price points: $120, $110, $95, $90
      catalogHistoryDao.recordSlotPriceChange(POOL, BLOCK, "$130", "$120", -10, -7.7);
      catalogHistoryDao.recordSlotPriceChange(POOL, BLOCK, "$120", "$110", -10, -8.3);
      catalogHistoryDao.recordSlotPriceChange(POOL, BLOCK, "$110", "$95", -15, -13.6);
      catalogHistoryDao.recordSlotPriceChange(POOL, BLOCK, "$95", "$90", -5, -5.3);

      // Case A: Price drops to $79 (ATL)
      const atlAnalytics = catalogHistoryDao.getPriceAnalytics(POOL, BLOCK, 79);
      expect(atlAnalytics.sampleCount).toBe(4);
      expect(atlAnalytics.minPrice).toBe(90);
      expect(atlAnalytics.rating).toBe("all_time_low");

      const atlEvent: DiffEvent = {
        id: "price-atl-1",
        type: "SLOT_PRICE_CHANGED",
        poolSlug: POOL,
        poolName: "Flagship Pool",
        block: BLOCK,
        hoursUtc: "08:00 – 16:00 UTC",
        previousPrice: "$90",
        newPrice: "$79",
        timestamp: Date.now(),
        slotPrice: {
          block: BLOCK,
          hoursUtc: "08:00 – 16:00 UTC",
          previousPrice: "$90",
          newPrice: "$79",
          priceDelta: -11,
          percentageDelta: -12.2,
          isDiscount: true,
          priceAnalytics: atlAnalytics,
        },
      };

      const msgAtlUk = (dispatcher as any).formatAlertMessage(createUser(1, 101, "uk"), atlEvent, "P1");
      expect(msgAtlUk.text).toContain("Історичний мінімум (ATL)");
      expect(msgAtlUk.text).toContain("Знижка: -$11/міс (-12.2%)");

      const msgAtlEn = (dispatcher as any).formatAlertMessage(createUser(2, 102, "en"), atlEvent, "P1");
      expect(msgAtlEn.text).toContain("All-Time Low (ATL)");
      expect(msgAtlEn.text).toContain("Price Drop: -$11/mo (-12.2%)");

      // Case B: Price hikes to $130 (Above Average)
      const aboveAvgAnalytics = catalogHistoryDao.getPriceAnalytics(POOL, BLOCK, 130);
      expect(aboveAvgAnalytics.rating).toBe("above_average");

      const hikeEvent: DiffEvent = {
        id: "price-hike-1",
        type: "SLOT_PRICE_CHANGED",
        poolSlug: POOL,
        poolName: "Flagship Pool",
        block: BLOCK,
        hoursUtc: "08:00 – 16:00 UTC",
        previousPrice: "$79",
        newPrice: "$130",
        timestamp: Date.now(),
        slotPrice: {
          block: BLOCK,
          hoursUtc: "08:00 – 16:00 UTC",
          previousPrice: "$79",
          newPrice: "$130",
          priceDelta: 51,
          percentageDelta: 64.6,
          isDiscount: false,
          priceAnalytics: aboveAvgAnalytics,
        },
      };

      const msgHikeUk = (dispatcher as any).formatAlertMessage(createUser(1, 101, "uk"), hikeEvent, "P1");
      expect(msgHikeUk.text).toContain("Вище середнього");
      expect(msgHikeUk.text).toContain("Підвищення: +$51/міс (+64.6%)");
    });
  });

  // --------------------------------------------------------------------------
  // STAGE 7: Overdue / Imminent Slot Detection
  // --------------------------------------------------------------------------
  describe("Stage 7: Overdue / Imminent Slot Detection", () => {
    it("should set isOverdue = true when elapsed downtime exceeds highSec threshold", () => {
      const now = Date.now();
      const pastCloseEpoch = Math.round((now - 7200 * 1000) / 1000); // Closed 2 hours ago

      // Seed 3 short historical downtimes of 30 minutes (1800s)
      for (let i = 4; i >= 1; i--) {
        const open = pastCloseEpoch - i * 1800;
        const close = open + 300;
        db.prepare(`
          INSERT INTO slot_lifecycle_history (pool_slug, block_id, initial_status, price_month, opened_at, closed_at, duration_seconds)
          VALUES ('${POOL}', '${BLOCK}', 'available', '$120', datetime(${open}, 'unixepoch'), datetime(${close}, 'unixepoch'), 300)
        `).run();
      }

      const eta = predictiveEngine.predictNextAvailability(POOL, BLOCK, "sold-out");
      expect(eta.isPredictable).toBe(true);
      expect(eta.isOverdue).toBe(true);
      expect(eta.expectedOpenTimestampMax).toBeLessThan(now);
    });
  });

  // --------------------------------------------------------------------------
  // STAGE 8: Multi-Lingual Alert Dispatcher Rendering
  // --------------------------------------------------------------------------
  describe("Stage 8: Multi-Lingual Alert Dispatcher Rendering", () => {
    it("should format all button labels, HTML headers, and badges consistently across UK, EN, and RU", () => {
      const event: DiffEvent = {
        id: "multilang-1",
        type: "SLOT_APPEARED",
        poolSlug: "frontier",
        poolName: "Frontier Pool",
        block: "americas",
        models: ["deepseek-r1", "glm-5.3"],
        hoursUtc: "16:00 – 24:00 UTC",
        newPrice: "149",
        newStatus: "available",
        timestamp: Date.now(),
      };

      const ukMsg = (dispatcher as any).formatAlertMessage(createUser(1, 101, "uk"), event, "P1");
      expect(ukMsg.text).toContain("ВІЛЬНИЙ СЛОТ • Frontier Pool");
      expect(ukMsg.text).toContain("Америка");
      expect(ukMsg.text).toContain("149/міс");
      expect(ukMsg.keyboard?.inline_keyboard[0][0].text).toContain("Забрати (Америка) • $149/міс");

      const enMsg = (dispatcher as any).formatAlertMessage(createUser(2, 102, "en"), event, "P1");
      expect(enMsg.text).toContain("SLOT DROP • Frontier Pool");
      expect(enMsg.text).toContain("Americas");
      expect(enMsg.text).toContain("149/mo");
      expect(enMsg.keyboard?.inline_keyboard[0][0].text).toContain("Claim (Americas) • $149/mo");

      const ruMsg = (dispatcher as any).formatAlertMessage(createUser(3, 103, "ru"), event, "P1");
      expect(ruMsg.text).toContain("СВОБОДНЫЙ СЛОТ • Frontier Pool");
      expect(ruMsg.text).toContain("Америка");
      expect(ruMsg.text).toContain("149/мес");
      expect(ruMsg.keyboard?.inline_keyboard[0][0].text).toContain("Забрать (Америка) • $149/мес");
    });
  });
});
