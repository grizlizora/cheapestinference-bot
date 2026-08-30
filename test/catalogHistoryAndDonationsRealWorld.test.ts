import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/index.js";
import { CatalogHistoryDAO } from "../src/db/dao/catalogHistory.js";
import { DonationDAO } from "../src/db/dao/donations.js";
import { UserDAO } from "../src/db/dao/users.js";
import { SlotDiffEngine } from "../src/engine/diffEngine.js";
import { PoolsSnapshot } from "../src/types/domain.js";

describe("Deep Forensic Audit: catalog_history & donations SQLite Operations", () => {
  let db: Database.Database;
  let catalogHistoryDao: CatalogHistoryDAO;
  let donationDao: DonationDAO;
  let userDao: UserDAO;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    catalogHistoryDao = new CatalogHistoryDAO(db);
    donationDao = new DonationDAO(db);
    userDao = new UserDAO(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("1. catalog_history Table Comprehensive Verification", () => {
    it("should write and read MODEL_UPGRADE events with exact JSON schemas", () => {
      catalogHistoryDao.recordModelUpgrade({
        poolSlug: "flagship",
        poolName: "Flagship Pool",
        added: ["deepseek-v3.1", "qwen-2.5-coder"],
        upgraded: [{ model: "claude-3-7-sonnet", reason: "Context increased to 200k" }],
        removed: ["legacy-model-v1"],
        currentModels: ["deepseek-v3.1", "qwen-2.5-coder", "claude-3-7-sonnet"],
      });

      const rows = db.prepare("SELECT * FROM catalog_history WHERE event_type = 'MODEL_UPGRADE'").all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].pool_slug).toBe("flagship");
      expect(rows[0].pool_name).toBe("Flagship Pool");
      expect(JSON.parse(rows[0].added_models_json)).toEqual(["deepseek-v3.1", "qwen-2.5-coder"]);
      expect(JSON.parse(rows[0].upgraded_models_json)).toEqual([{ model: "claude-3-7-sonnet", reason: "Context increased to 200k" }]);
      expect(JSON.parse(rows[0].removed_models_json)).toEqual(["legacy-model-v1"]);
      expect(JSON.parse(rows[0].all_models_json)).toEqual(["deepseek-v3.1", "qwen-2.5-coder", "claude-3-7-sonnet"]);
      expect(rows[0].detected_at).toBeTruthy();
    });

    it("should write and read TIER_UPDATE events with exact metadata JSON", () => {
      catalogHistoryDao.recordTierUpdate("core", "Core Pool", ["qwen-32b"], {
        previousDescription: "Old 8x H100",
        newDescription: "New 8x H200 Superdome",
        previousAnnualDiscount: 0.15,
        newAnnualDiscount: 0.20,
        previousInfraSpec: "8x H100 SXM5",
        newInfraSpec: "8x H200 SXM5 141GB",
        previousManualProvisioning: false,
        newManualProvisioning: true,
      });

      const rows = db.prepare("SELECT * FROM catalog_history WHERE event_type = 'TIER_UPDATE'").all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].pool_slug).toBe("core");
      const meta = JSON.parse(rows[0].metadata_json);
      expect(meta.newInfraSpec).toBe("8x H200 SXM5 141GB");
      expect(meta.newAnnualDiscount).toBe(0.20);
      expect(meta.newManualProvisioning).toBe(true);
    });

    it("should write and read BASE_PRICE events directly and via DiffEngine", () => {
      catalogHistoryDao.recordBasePriceUpdate("flagship", "Flagship Pool", ["kimi-k3"], {
        previousMinPrice: "149.00",
        newMinPrice: "349.00",
        priceDelta: 200.00,
        percentageDelta: 134.23,
      });

      const rows = db.prepare("SELECT * FROM catalog_history WHERE event_type = 'BASE_PRICE'").all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].pool_slug).toBe("flagship");
      expect(rows[0].previous_min_price).toBe("149.00");
      expect(rows[0].new_min_price).toBe("349.00");
      const meta = JSON.parse(rows[0].metadata_json);
      expect(meta.priceDelta).toBe(200.00);
      expect(meta.percentageDelta).toBe(134.23);
      expect(meta.isDiscount).toBe(false);
    });

    it("should record base price in catalog_history during real DiffEngine snapshot processing with mixed regional slot prices", () => {
      const diffEngine = new SlotDiffEngine(undefined, catalogHistoryDao);

      const baselineSnapshot: PoolsSnapshot = {
        success: true,
        data: [
          {
            id: "flagship",
            slug: "flagship",
            modelId: "flagship",
            modelName: "Flagship Pool",
            models: ["kimi-k3", "qwen3.8-max"],
            description: "Flagship tier",
            status: "active",
            minPricePerDay: "149.00",
            annualDiscount: 0.15,
            blocks: [
              { block: "asia", hoursUtc: "00:00-08:00 UTC", pricePerMonth: "155.00", status: "sold-out" },
              { block: "europe", hoursUtc: "08:00-16:00 UTC", pricePerMonth: "165.00", status: "sold-out" },
              { block: "americas", hoursUtc: "16:00-24:00 UTC", pricePerMonth: "149.00", status: "sold-out" },
            ],
          },
        ],
      };

      // Bootstrap baseline
      diffEngine.processSnapshot(baselineSnapshot);

      // New snapshot arrives: minPricePerDay becomes 349.00, Asia becomes 363.00, Europe becomes 386.00, Americas becomes 349.00
      const changedSnapshot: PoolsSnapshot = {
        success: true,
        data: [
          {
            id: "flagship",
            slug: "flagship",
            modelId: "flagship",
            modelName: "Flagship Pool",
            models: ["kimi-k3", "qwen3.8-max"],
            description: "Flagship tier",
            status: "active",
            minPricePerDay: "349.00",
            annualDiscount: 0.15,
            blocks: [
              { block: "asia", hoursUtc: "00:00-08:00 UTC", pricePerMonth: "363.00", status: "sold-out" },
              { block: "europe", hoursUtc: "08:00-16:00 UTC", pricePerMonth: "386.00", status: "sold-out" },
              { block: "americas", hoursUtc: "16:00-24:00 UTC", pricePerMonth: "349.00", status: "sold-out" },
            ],
          },
        ],
      };

      const events = diffEngine.processSnapshot(changedSnapshot);
      // 3 regional slot price events generated for alerts
      expect(events).toHaveLength(3);
      expect(events.map((e) => e.block)).toEqual(["asia", "europe", "americas"]);

      // 1. catalog_history MUST contain the BASE_PRICE record:
      const catalogBasePriceRows = db.prepare("SELECT * FROM catalog_history WHERE event_type = 'BASE_PRICE'").all() as any[];
      expect(catalogBasePriceRows).toHaveLength(1);
      expect(catalogBasePriceRows[0].previous_min_price).toBe("149.00");
      expect(catalogBasePriceRows[0].new_min_price).toBe("349.00");

      // 2. slot_price_history MUST contain all 3 regional records:
      const slotPriceRows = db.prepare("SELECT * FROM slot_price_history WHERE pool_slug = 'flagship' ORDER BY block_id ASC").all() as any[];
      expect(slotPriceRows).toHaveLength(3);
      expect(slotPriceRows[0].block_id).toBe("americas");
      expect(slotPriceRows[0].new_price).toBe("349.00");
      expect(slotPriceRows[1].block_id).toBe("asia");
      expect(slotPriceRows[1].new_price).toBe("363.00");
      expect(slotPriceRows[2].block_id).toBe("europe");
      expect(slotPriceRows[2].new_price).toBe("386.00");
    });
  });

  describe("2. donations Table Comprehensive Verification", () => {
    it("should process donations atomically, update user stars, and enforce idempotency", () => {
      // 1. Create a user
      const user = userDao.upsertUser({
        telegram_id: 99887766,
        username: "generous_patron",
        first_name: "Roman",
        language: "uk",
      });

      expect(user.total_donated_stars).toBe(0);

      // 2. Record first donation of 100 Stars
      const don1 = donationDao.recordDonation(
        user.id,
        user.telegram_id,
        100,
        "charge_unique_100_stars",
        "provider_charge_abc"
      );

      expect(don1.amount_stars).toBe(100);
      expect(don1.currency).toBe("XTR");

      // Check user total_donated_stars updated in DB
      const updatedUser1 = userDao.getById(user.id);
      expect(updatedUser1?.total_donated_stars).toBe(100);

      // Check DAO helpers
      expect(donationDao.getUserTotalDonated(user.id)).toBe(100);
      expect(donationDao.getGlobalTotalDonated()).toBe(100);

      // 3. Idempotency check: replay the exact same charge ID
      const donDuplicate = donationDao.recordDonation(
        user.id,
        user.telegram_id,
        100,
        "charge_unique_100_stars",
        "provider_charge_abc"
      );

      expect(donDuplicate.id).toBe(don1.id);
      // Stars must NOT double
      expect(donationDao.getUserTotalDonated(user.id)).toBe(100);

      // 4. Second distinct donation of 500 Stars
      const don2 = donationDao.recordDonation(
        user.id,
        user.telegram_id,
        500,
        "charge_unique_500_stars",
        "provider_charge_def"
      );

      expect(don2.amount_stars).toBe(500);
      expect(donationDao.getUserTotalDonated(user.id)).toBe(600);
      expect(donationDao.getGlobalTotalDonated()).toBe(600);

      // 5. Leaderboard / Top donators check
      const topDonators = donationDao.getTopDonators(10);
      expect(topDonators).toHaveLength(1);
      expect(topDonators[0].telegram_id).toBe(99887766);
      expect(topDonators[0].total_stars).toBe(600);

      // 6. Recent donations check
      const recent = donationDao.getRecentDonations(10);
      expect(recent).toHaveLength(2);
      expect(recent[0].amount_stars).toBe(500);
      expect(recent[1].amount_stars).toBe(100);
    });
  });
});
