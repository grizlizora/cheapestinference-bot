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

    // Slot in europe becomes limited
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
    // 1. Initial baseline: europe is limited
    const inStockSnapshot: PoolsSnapshot = JSON.parse(JSON.stringify(sampleSnapshot));
    inStockSnapshot.data[0].blocks[1].status = "limited";
    engine.processSnapshot(inStockSnapshot);

    // 2. Scrape 1: europe becomes sold-out (K=1, should not emit yet to prevent flapping)
    const soldOutSnapshot: PoolsSnapshot = JSON.parse(JSON.stringify(sampleSnapshot));
    soldOutSnapshot.data[0].blocks[1].status = "sold-out";
    const eventsRun1 = engine.processSnapshot(soldOutSnapshot);
    expect(eventsRun1).toHaveLength(0);

    // 3. Scrape 2: europe still sold-out (K=2, confirmed disappearance)
    const eventsRun2 = engine.processSnapshot(soldOutSnapshot);
    expect(eventsRun2).toHaveLength(1);
    expect(eventsRun2[0].type).toBe("SLOT_DISAPPEARED");
    expect(eventsRun2[0].block).toBe("europe");
  });

  it("should emit PRICE_CHANGED when price updates", () => {
    engine.processSnapshot(sampleSnapshot);

    const priceChangeSnapshot: PoolsSnapshot = JSON.parse(JSON.stringify(sampleSnapshot));
    priceChangeSnapshot.data[0].blocks[0].pricePerMonth = "140.00";

    const events = engine.processSnapshot(priceChangeSnapshot);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("PRICE_CHANGED");
    expect(events[0].newPrice).toBe("140.00");
  });

  it("should emit CATALOG_UPDATED when new models are dynamically added", () => {
    engine.processSnapshot(sampleSnapshot);

    const modelUpdateSnapshot: PoolsSnapshot = JSON.parse(JSON.stringify(sampleSnapshot));
    modelUpdateSnapshot.data[0].models = ["kimi-k3", "qwen3.8-max", "deepseek-r1"];

    const events = engine.processSnapshot(modelUpdateSnapshot);
    expect(events.some((e) => e.type === "CATALOG_UPDATED")).toBe(true);
  });

  it("should reconcile and emit SLOT_DISAPPEARED when a previously active slot is deleted from site", () => {
    // 1. Initial baseline: europe is available
    const inStockSnapshot: PoolsSnapshot = JSON.parse(JSON.stringify(sampleSnapshot));
    inStockSnapshot.data[0].blocks[1].status = "available";
    engine.processSnapshot(inStockSnapshot);

    // 2. Snapshot where europe block is deleted/removed completely from the site
    const deletedSlotSnapshot: PoolsSnapshot = {
      success: true,
      data: [
        {
          ...sampleSnapshot.data[0],
          blocks: [
            sampleSnapshot.data[0].blocks[0], // only asia
            sampleSnapshot.data[0].blocks[2], // only americas
          ],
        },
      ],
    };

    const events = engine.processSnapshot(deletedSlotSnapshot);
    expect(events.some((e) => e.type === "SLOT_DISAPPEARED" && e.block === "europe")).toBe(true);
  });
});
