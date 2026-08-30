import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SlotDiffEngine } from "../src/engine/diffEngine.js";
import { PoolsSnapshot } from "../src/types/domain.js";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/index.js";
import { CatalogHistoryDAO } from "../src/db/dao/catalogHistory.js";

describe("SlotDiffEngine", () => {
  let engine: SlotDiffEngine;
  let db: Database.Database;
  let catalogHistoryDao: CatalogHistoryDAO;

  const sampleSnapshot: PoolsSnapshot = {
    success: true,
    data: [
      {
        id: "flagship",
        slug: "flagship",
        modelId: "flagship",
        modelName: "Flagship Pool — Kimi K3, Qwen3.8 Max",
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

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    catalogHistoryDao = new CatalogHistoryDAO(db);
    engine = new SlotDiffEngine(undefined, catalogHistoryDao);
  });

  afterEach(() => {
    db.close();
  });

  it("should bootstrap silently on cold start without emitting events", () => {
    const events = engine.processSnapshot(sampleSnapshot);
    expect(events).toHaveLength(0);
    expect(engine.isReady()).toBe(true);
  });

  it("should immediately emit SLOT_APPEARED on K=1 when a slot becomes available/limited", () => {
    engine.processSnapshot(sampleSnapshot);

    const updatedSnapshot: PoolsSnapshot = JSON.parse(JSON.stringify(sampleSnapshot));
    updatedSnapshot.data[0].blocks[1].status = "limited";

    const events = engine.processSnapshot(updatedSnapshot);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("SLOT_APPEARED");
    expect(events[0].poolSlug).toBe("flagship");
    expect(events[0].block).toBe("europe");
    expect(events[0].newStatus).toBe("limited");
  });

  it("should require K=2 consecutive confirmations before emitting SLOT_DISAPPEARED", () => {
    const inStockSnapshot: PoolsSnapshot = JSON.parse(JSON.stringify(sampleSnapshot));
    inStockSnapshot.data[0].blocks[1].status = "limited";
    engine.processSnapshot(inStockSnapshot);

    const soldOutSnapshot: PoolsSnapshot = JSON.parse(JSON.stringify(sampleSnapshot));
    soldOutSnapshot.data[0].blocks[1].status = "sold-out";
    const eventsRun1 = engine.processSnapshot(soldOutSnapshot);
    expect(eventsRun1).toHaveLength(0);

    const eventsRun2 = engine.processSnapshot(soldOutSnapshot);
    expect(eventsRun2).toHaveLength(1);
    expect(eventsRun2[0].type).toBe("SLOT_DISAPPEARED");
    expect(eventsRun2[0].block).toBe("europe");
  });

  it("should emit SLOT_PRICE_CHANGED with delta & percentage when price updates", () => {
    engine.processSnapshot(sampleSnapshot);

    const priceChangeSnapshot: PoolsSnapshot = JSON.parse(JSON.stringify(sampleSnapshot));
    priceChangeSnapshot.data[0].blocks[0].pricePerMonth = "140.00";

    const events = engine.processSnapshot(priceChangeSnapshot);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("SLOT_PRICE_CHANGED");
    expect(events[0].slotPrice?.priceDelta).toBe(-15.00);
    expect(events[0].slotPrice?.isDiscount).toBe(true);
  });

  it("should emit MODEL_UPGRADE_EVENT with exact diffs when models update", () => {
    engine.processSnapshot(sampleSnapshot);

    const modelUpdateSnapshot: PoolsSnapshot = JSON.parse(JSON.stringify(sampleSnapshot));
    modelUpdateSnapshot.data[0].models = ["kimi-k3", "qwen-3.8-max", "deepseek-r1"];

    const events = engine.processSnapshot(modelUpdateSnapshot);
    expect(events.some((e) => e.type === "MODEL_UPGRADE_EVENT")).toBe(true);
    const upgradeEvent = events.find((e) => e.type === "MODEL_UPGRADE_EVENT");
    expect(upgradeEvent?.modelUpgrade?.added.some((m) => m.modelName === "deepseek-r1")).toBe(true);
  });

  it("should reconcile and emit SLOT_DISAPPEARED with K=2 confirmation when a previously active slot is deleted from site", () => {
    const inStockSnapshot: PoolsSnapshot = JSON.parse(JSON.stringify(sampleSnapshot));
    inStockSnapshot.data[0].blocks[1].status = "available";
    engine.processSnapshot(inStockSnapshot);

    const deletedSlotSnapshot: PoolsSnapshot = {
      success: true,
      data: [
        {
          ...sampleSnapshot.data[0],
          blocks: [
            sampleSnapshot.data[0].blocks[0],
            sampleSnapshot.data[0].blocks[2],
          ],
        },
      ],
    };

    // First scan without the slot (K=1): No event emitted yet to prevent false alarms
    const events1 = engine.processSnapshot(deletedSlotSnapshot);
    expect(events1.some((e) => e.type === "SLOT_DISAPPEARED" && e.block === "europe")).toBe(false);

    // Second consecutive scan without the slot (K=2): Confirmed disappearance event emitted!
    const events2 = engine.processSnapshot(deletedSlotSnapshot);
    expect(events2.some((e) => e.type === "SLOT_DISAPPEARED" && e.block === "europe")).toBe(true);
  });

  it("should require K=2 confirmation before deleting missing pools to prevent false NEW_POOL_EVENT", () => {
    const engine = new SlotDiffEngine();
    engine.processSnapshot(sampleSnapshot);

    const emptySnapshot = { success: true, data: [] };

    // Tick 1: Missing pool (K=1) - should NOT immediately purge from inMemoryPools
    engine.processSnapshot(emptySnapshot);
    const snapshotAfterK1 = engine.getSnapshot();
    expect(snapshotAfterK1?.data.length).toBe(1); // Still retained!

    // Tick 2: Second consecutive missing scan (K=2) - Now pruned
    engine.processSnapshot(emptySnapshot);
    const snapshotAfterK2 = engine.getSnapshot();
    expect(snapshotAfterK2?.data.length).toBe(0);
  });

  it("should emit ONLY SLOT_PRICE_CHANGED and suppress POOL_BASE_PRICE_CHANGED when a single slot changes price along with minPricePerDay", () => {
    engine.processSnapshot(sampleSnapshot);

    // Americas drops from 149.00 to 135.00, causing minPricePerDay to also drop to 135.00
    const updatedSnapshot: PoolsSnapshot = JSON.parse(JSON.stringify(sampleSnapshot));
    updatedSnapshot.data[0].minPricePerDay = "135.00";
    updatedSnapshot.data[0].blocks[2].pricePerMonth = "135.00";

    const events = engine.processSnapshot(updatedSnapshot);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("SLOT_PRICE_CHANGED");
    expect(events[0].block).toBe("americas");
    expect(events[0].slotPrice?.priceDelta).toBe(-14.00);
    expect(events[0].slotPrice?.isDiscount).toBe(true);
    expect(events.some((e) => e.type === "POOL_BASE_PRICE_CHANGED")).toBe(false);

    // Verify catalog_history recorded BASE_PRICE and slot_price_history recorded SLOT_PRICE
    const catalogRows = db.prepare("SELECT * FROM catalog_history WHERE event_type = 'BASE_PRICE'").all();
    expect(catalogRows.length).toBeGreaterThanOrEqual(1);

    const slotPriceRows = db.prepare("SELECT * FROM slot_price_history WHERE pool_slug = 'flagship' AND block_id = 'americas'").all();
    expect(slotPriceRows.length).toBeGreaterThanOrEqual(1);
  });

  it("should emit 1x POOL_BASE_PRICE_CHANGED and suppress individual slot alerts when ALL slots change uniformly", () => {
    engine.processSnapshot(sampleSnapshot);

    const uniformDropSnapshot: PoolsSnapshot = JSON.parse(JSON.stringify(sampleSnapshot));
    uniformDropSnapshot.data[0].minPricePerDay = "120.00";
    for (const b of uniformDropSnapshot.data[0].blocks) {
      b.pricePerMonth = "120.00";
    }

    const events = engine.processSnapshot(uniformDropSnapshot);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("POOL_BASE_PRICE_CHANGED");
    expect(events[0].block).toBe("ALL");
    expect(events[0].basePrice?.newMinPrice).toBe("120.00");
    expect(events.some((e) => e.type === "SLOT_PRICE_CHANGED")).toBe(false);
  });

  it("should hydrate baseline from SQLite via bootstrapFromDao without emitting false alerts", () => {
    const freshEngine = new SlotDiffEngine();
    freshEngine.bootstrapFromDao([
      {
        pool_slug: "flagship",
        pool_name: "Flagship Pool — Kimi K3, Qwen3.8 Max",
        models_json: JSON.stringify(["kimi-k3", "qwen3.8-max"]),
        block_id: "asia",
        status: "sold-out",
        hours_utc: "00:00-08:00 UTC",
        price_month: "155.00",
        min_price_day: "149.00",
        annual_discount: 0.15,
        description: "Flagship tier",
      },
      {
        pool_slug: "flagship",
        pool_name: "Flagship Pool — Kimi K3, Qwen3.8 Max",
        models_json: JSON.stringify(["kimi-k3", "qwen3.8-max"]),
        block_id: "europe",
        status: "sold-out",
        hours_utc: "08:00-16:00 UTC",
        price_month: "165.00",
        min_price_day: "149.00",
        annual_discount: 0.15,
        description: "Flagship tier",
      },
      {
        pool_slug: "flagship",
        pool_name: "Flagship Pool — Kimi K3, Qwen3.8 Max",
        models_json: JSON.stringify(["kimi-k3", "qwen3.8-max"]),
        block_id: "americas",
        status: "sold-out",
        hours_utc: "16:00-24:00 UTC",
        price_month: "149.00",
        min_price_day: "149.00",
        annual_discount: 0.15,
        description: "Flagship tier",
      },
    ]);

    // Now process an identical snapshot: zero events should be emitted
    const events = freshEngine.processSnapshot(sampleSnapshot);
    expect(events).toHaveLength(0);
  });

  it("should never duplicate SLOT_DISAPPEARED on subsequent ticks (K=1 -> K=2 -> K=3 -> K=4) and update snapshot status", () => {
    const testEngine = new SlotDiffEngine();

    // Baseline: Asia and Americas are available
    const availableSnapshot: PoolsSnapshot = JSON.parse(JSON.stringify(sampleSnapshot));
    availableSnapshot.data[0].blocks[0].status = "limited"; // Asia
    availableSnapshot.data[0].blocks[2].status = "available"; // Americas
    testEngine.processSnapshot(availableSnapshot);

    const snap0 = testEngine.getSnapshot();
    const flagship0 = snap0?.data.find((p) => p.slug === "flagship");
    expect(flagship0?.blocks.filter((b) => b.status === "available" || b.status === "limited")).toHaveLength(2);

    // Both become sold-out upstream
    const soldOutSnapshot: PoolsSnapshot = JSON.parse(JSON.stringify(sampleSnapshot));
    soldOutSnapshot.data[0].blocks[0].status = "sold-out";
    soldOutSnapshot.data[0].blocks[2].status = "sold-out";

    // Tick 1 (K=1 Noise Gate): 0 events, in-memory snapshot still holds available
    const events1 = testEngine.processSnapshot(soldOutSnapshot);
    expect(events1).toHaveLength(0);

    // Tick 2 (K=2 Confirmation): 2 events emitted (Asia & Americas)
    const events2 = testEngine.processSnapshot(soldOutSnapshot);
    expect(events2).toHaveLength(2);
    expect(events2.map((e) => e.type)).toEqual(["SLOT_DISAPPEARED", "SLOT_DISAPPEARED"]);

    // In-memory snapshot MUST now show 0 available blocks!
    const snap2 = testEngine.getSnapshot();
    const flagship2 = snap2?.data.find((p) => p.slug === "flagship");
    expect(flagship2?.blocks.filter((b) => b.status === "available" || b.status === "limited")).toHaveLength(0);

    // Tick 3 (K=3 Steady State): 0 events (NO DUPLICATE ALERTS!)
    const events3 = testEngine.processSnapshot(soldOutSnapshot);
    expect(events3).toHaveLength(0);

    // Tick 4 (K=4 Steady State): 0 events (NO DUPLICATE ALERTS!)
    const events4 = testEngine.processSnapshot(soldOutSnapshot);
    expect(events4).toHaveLength(0);
  });
});
