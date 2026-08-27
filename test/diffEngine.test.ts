import { describe, it, expect, beforeEach } from "vitest";
import { SlotDiffEngine } from "../src/engine/diffEngine.js";
import { PoolsSnapshot } from "../src/types/domain.js";

describe("SlotDiffEngine", () => {
  let engine: SlotDiffEngine;

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
    engine = new SlotDiffEngine();
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

    expect(freshEngine.isReady()).toBe(true);

    // Now process an identical snapshot: zero events should be emitted
    const events = freshEngine.processSnapshot(sampleSnapshot);
    expect(events).toHaveLength(0);
  });
});
