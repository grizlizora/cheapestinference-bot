import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/index.js";
import { SlotHistoryDAO } from "../src/db/dao/slotHistory.js";
import { PredictiveAnalyticsEngine } from "../src/engine/predictiveEngine.js";

describe("PredictiveAnalyticsEngine Mathematical & Statistical Invariants", () => {
  let db: Database.Database;
  let historyDao: SlotHistoryDAO;
  let engine: PredictiveAnalyticsEngine;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    historyDao = new SlotHistoryDAO(db);
    engine = new PredictiveAnalyticsEngine(historyDao);
  });

  afterEach(() => {
    db.close();
  });

  describe("1. IQR & Outlier Rejection", () => {
    it("should calculate exact quartiles and IQR for even and odd datasets", () => {
      const oddData = [10, 20, 30, 40, 50];
      const qOdd = PredictiveAnalyticsEngine.calculateQuartiles(oddData);
      expect(qOdd.q1).toBe(20);
      expect(qOdd.q2).toBe(30);
      expect(qOdd.q3).toBe(40);
      expect(qOdd.iqr).toBe(20);

      const evenData = [10, 20, 30, 40, 50, 60];
      const qEven = PredictiveAnalyticsEngine.calculateQuartiles(evenData);
      expect(qEven.q2).toBe(35);
    });

    it("should reject 30-day maintenance outlier and preserve true ~10 min lifespan", () => {
      // 10 realistic slot drops (~600 seconds = 10 minutes) + 1 massive 30-day anomaly (2,592,000s)
      const testDurations = [580, 600, 620, 590, 610, 605, 595, 600, 615, 600, 2592000];

      // Seed database
      for (const d of testDurations) {
        db.prepare(`
          INSERT INTO slot_lifecycle_history (pool_slug, block_id, initial_status, price_month, opened_at, closed_at, duration_seconds)
          VALUES ('flagship', 'europe', 'available', '$99', datetime('now', '-${d + 100} seconds'), datetime('now', '-100 seconds'), ${d})
        `).run();
      }

      const profile = engine.getDemandProfile("flagship", "europe");
      expect(profile.totalOpenings).toBe(11);
      expect(profile.sampleCount).toBe(10); // Outlier 2,592,000s was rejected!
      expect(profile.medianDurationSeconds).toBe(600);
      expect(profile.demandCategory).toBe("hot");
      expect(profile.avgFormatted).toBe("~10 min");
    });
  });

  describe("2. Drop Pattern Classification", () => {
    it("should classify single drop at :00 UTC as UNRENEWED_EXPIRY", () => {
      // Mock timestamp at 14:00:05 UTC (5 seconds from :00 boundary)
      const boundaryTime = new Date("2026-08-27T14:00:05.000Z").getTime();
      const drop = engine.classifyDrop("flagship", "europe", boundaryTime, 1, false);

      expect(drop.dropType).toBe("UNRENEWED_EXPIRY");
      expect(drop.isHourlyBoundary).toBe(true);
      expect(drop.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("should classify multi-region concurrent release as BATCH_CAPACITY_EXPANSION", () => {
      // Mid-hour opening at 14:27:30 UTC with 3 concurrent blocks opening
      const midHourTime = new Date("2026-08-27T14:27:30.000Z").getTime();
      const drop = engine.classifyDrop("flagship", "europe", midHourTime, 3, false);

      expect(drop.dropType).toBe("BATCH_CAPACITY_EXPANSION");
      expect(drop.clusterSize).toBe(3);
      expect(drop.confidence).toBeGreaterThanOrEqual(0.65);
    });
  });

  describe("3. Time-to-Next-Availability (ETA) & Sample Gating (N >= 3)", () => {
    it("should strictly return INSUFFICIENT_DATA when sampleCount < 3", () => {
      // Seed only 2 observations
      db.prepare(`
        INSERT INTO slot_lifecycle_history (pool_slug, block_id, initial_status, price_month, opened_at, closed_at, duration_seconds)
        VALUES ('core', 'asia', 'available', '$20', datetime('now', '-2 days'), datetime('now', '-1.9 days'), 8640)
      `).run();
      db.prepare(`
        INSERT INTO slot_lifecycle_history (pool_slug, block_id, initial_status, price_month, opened_at, closed_at, duration_seconds)
        VALUES ('core', 'asia', 'available', '$20', datetime('now', '-1 days'), datetime('now', '-0.9 days'), 8640)
      `).run();

      const eta = engine.predictNextAvailability("core", "asia");
      expect(eta.isPredictable).toBe(false);
      expect(eta.sampleCount).toBeLessThan(3);
      expect(eta.confidence).toBe("INSUFFICIENT_DATA");
      expect(eta.message).toContain("Збір даних");
    });

    it("should detect 24h daily cadence when N >= 3 and return confident forecast", () => {
      // Seed 4 openings spaced ~24h apart
      const now = Date.now();
      const daySec = 86400;

      for (let i = 4; i >= 1; i--) {
        const openEpoch = Math.round((now - (i * daySec * 1000)) / 1000);
        const closeEpoch = openEpoch + 3600; // Open for 1 hour

        db.prepare(`
          INSERT INTO slot_lifecycle_history (pool_slug, block_id, initial_status, price_month, opened_at, closed_at, duration_seconds)
          VALUES ('flagship', 'asia', 'available', '$150', datetime(${openEpoch}, 'unixepoch'), datetime(${closeEpoch}, 'unixepoch'), 3600)
        `).run();
      }

      const eta = engine.predictNextAvailability("flagship", "asia");
      expect(eta.isPredictable).toBe(true);
      expect(eta.sampleCount).toBeGreaterThanOrEqual(3);
      expect(eta.detectedCadenceHours).toBe(24);
      expect(eta.confidence).toBe("HIGH");
      expect(eta.formattedEtaWindow).toMatch(/год/);
    });
  });

  describe("4. Strict Per-Pool and Per-Block Isolation", () => {
    it("should keep Flagship Asia and Flagship Europe statistics 100% decoupled", () => {
      // Flagship Asia: 10 openings of 3 minutes each (Flash Drop)
      for (let i = 0; i < 10; i++) {
        db.prepare(`
          INSERT INTO slot_lifecycle_history (pool_slug, block_id, initial_status, price_month, opened_at, closed_at, duration_seconds)
          VALUES ('flagship', 'asia', 'available', '$150', datetime('now', '-${(i + 1) * 3600} seconds'), datetime('now', '-${(i + 1) * 3600 - 180} seconds'), 180)
        `).run();
      }

      // Flagship Europe: 5 openings of 3 hours each (Stable Availability)
      for (let i = 0; i < 5; i++) {
        db.prepare(`
          INSERT INTO slot_lifecycle_history (pool_slug, block_id, initial_status, price_month, opened_at, closed_at, duration_seconds)
          VALUES ('flagship', 'europe', 'available', '$165', datetime('now', '-${(i + 1) * 86400} seconds'), datetime('now', '-${(i + 1) * 86400 - 10800} seconds'), 10800)
        `).run();
      }

      const asiaProfile = engine.getDemandProfile("flagship", "asia");
      const europeProfile = engine.getDemandProfile("flagship", "europe");

      expect(asiaProfile.demandCategory).toBe("flash");
      expect(asiaProfile.avgFormatted).toBe("~3 min");

      expect(europeProfile.demandCategory).toBe("stable");
      expect(europeProfile.avgFormatted).toBe("~3.0 h");
    });
  });
});
