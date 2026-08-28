import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { HtmlSnapshotEngine } from "../src/scrapers/htmlSnapshotEngine.js";
import { RobustHttpClient } from "../src/http/client.js";
import { ProxyPool } from "../src/proxy/proxyPool.js";
import { SlotDiffEngine } from "../src/engine/diffEngine.js";
import { PoolStateDAO } from "../src/db/dao/poolState.js";
import { normalizeSlotStatus, isSlotAvailable, PoolsSnapshot } from "../src/types/domain.js";

describe("Slot Availability Oscillation & RSC Parsing Protection Suite", () => {
  let db: Database.Database;
  let poolStateDao: PoolStateDAO;
  let diffEngine: SlotDiffEngine;

  beforeEach(() => {
    db = new Database(":memory:");
    const schemaSql = fs.readFileSync(path.resolve(process.cwd(), "src/db/schema.sql"), "utf-8");
    db.exec(schemaSql);
    poolStateDao = new PoolStateDAO(db);
    diffEngine = new SlotDiffEngine();
  });

  afterEach(() => {
    db.close();
  });

  it("1. should correctly extract live dynamic slots from multi-chunk RSC flight stream", () => {
    const proxyPool = new ProxyPool();
    const httpClient = new RobustHttpClient(proxyPool);
    const engine = new HtmlSnapshotEngine(httpClient);

    // Simulating Next.js RSC Flight Stream where static layout is pushed first (0/3 free),
    // followed by dynamic server component update with Flagship Asia limited (1/3 free)
    const simulatedRscHtml = `
      <!DOCTYPE html>
      <html>
      <body>
      <script>(self.__next_f=self.__next_f||[]).push([0,"1:{\\"slug\\":\\"flagship\\",\\"modelName\\":\\"Flagship Pool\\",\\"models\\":[\\"kimi-k3\\",\\"qwen3.8-max\\"],\\"minPricePerDay\\":\\"5.00\\",\\"blocks\\":[{\\"block\\":\\"asia\\",\\"hoursUtc\\":\\"00:00-08:00 UTC\\",\\"pricePerMonth\\":\\"$155/mo\\",\\"status\\":\\"sold-out\\"},{\\"block\\":\\"europe\\",\\"hoursUtc\\":\\"08:00-16:00 UTC\\",\\"pricePerMonth\\":\\"$155/mo\\",\\"status\\":\\"sold-out\\"},{\\"block\\":\\"americas\\",\\"hoursUtc\\":\\"16:00-24:00 UTC\\",\\"pricePerMonth\\":\\"$155/mo\\",\\"status\\":\\"sold-out\\"}]}\\n"])</script>
      <script>(self.__next_f=self.__next_f||[]).push([1,"2:{\\"slug\\":\\"flagship\\",\\"modelName\\":\\"Flagship Pool\\",\\"models\\":[\\"kimi-k3\\",\\"qwen3.8-max\\"],\\"minPricePerDay\\":\\"5.00\\",\\"blocks\\":[{\\"block\\":\\"asia\\",\\"hoursUtc\\":\\"00:00-08:00 UTC\\",\\"pricePerMonth\\":\\"$155/mo\\",\\"status\\":\\"limited\\"},{\\"block\\":\\"europe\\",\\"hoursUtc\\":\\"08:00-16:00 UTC\\",\\"pricePerMonth\\":\\"$155/mo\\",\\"status\\":\\"sold-out\\"},{\\"block\\":\\"americas\\",\\"hoursUtc\\":\\"16:00-24:00 UTC\\",\\"pricePerMonth\\":\\"$155/mo\\",\\"status\\":\\"sold-out\\"}]}\\n"])</script>
      </body>
      </html>
    `;

    const extracted = engine.extractRscPayload(simulatedRscHtml);
    expect(extracted).not.toBeNull();
    expect(extracted!.length).toBe(1);

    const flagship = extracted![0];
    expect(flagship.slug).toBe("flagship");
    const asiaBlock = flagship.blocks.find((b) => b.block === "asia");
    expect(asiaBlock).toBeDefined();
    // Must contain latest dynamic "limited" status, not stale "sold-out" from chunk 0
    expect(asiaBlock!.status).toBe("limited");
  });

  it("2. should normalize status variants (casing, underscores, synonyms)", () => {
    expect(normalizeSlotStatus("available")).toBe("available");
    expect(normalizeSlotStatus("AVAILABLE")).toBe("available");
    expect(normalizeSlotStatus("in_stock")).toBe("available");
    expect(normalizeSlotStatus("active")).toBe("available");

    expect(normalizeSlotStatus("limited")).toBe("limited");
    expect(normalizeSlotStatus("Limited")).toBe("limited");
    expect(normalizeSlotStatus("low_stock")).toBe("limited");

    expect(normalizeSlotStatus("sold-out")).toBe("sold-out");
    expect(normalizeSlotStatus("sold_out")).toBe("sold-out");
    expect(normalizeSlotStatus("SOLD_OUT")).toBe("sold-out");
    expect(normalizeSlotStatus("unavailable")).toBe("sold-out");
    expect(normalizeSlotStatus("")).toBe("sold-out");

    expect(isSlotAvailable("Limited")).toBe(true);
    expect(isSlotAvailable("AVAILABLE")).toBe(true);
    expect(isSlotAvailable("sold_out")).toBe(false);
  });

  it("3. should maintain 1/3 capacity on dashboard and protect SQLite from transient K=1 flapping", () => {
    // 1. Initial baseline: Flagship Asia becomes limited (1/3 available)
    const snapshotAvailable: PoolsSnapshot = {
      success: true,
      data: [
        {
          id: "flagship",
          slug: "flagship",
          modelId: "flagship",
          modelName: "Flagship Pool",
          models: ["kimi-k3", "qwen3.8-max"],
          description: "Top AI Cluster",
          status: "active",
          minPricePerDay: "5.00",
          annualDiscount: 0.15,
          blocks: [
            { block: "asia", hoursUtc: "00:00-08:00 UTC", pricePerMonth: "$155", status: "limited" },
            { block: "europe", hoursUtc: "08:00-16:00 UTC", pricePerMonth: "$155", status: "sold-out" },
            { block: "americas", hoursUtc: "16:00-24:00 UTC", pricePerMonth: "$155", status: "sold-out" },
          ],
        },
      ],
    };

    // Process first tick (bootstrap)
    diffEngine.processSnapshot(snapshotAvailable);
    const auth1 = diffEngine.getSnapshot() || snapshotAvailable;
    poolStateDao.saveSnapshot(auth1, "html_rsc_stream", 50);

    let summaries = poolStateDao.getPoolSummaries();
    expect(summaries[0].available_count).toBe(1);
    expect(summaries[0].total_blocks).toBe(3);

    // 2. Transient tick: transient glitch or stale edge response reports sold-out for Asia (K=1)
    const transientStaleSnapshot: PoolsSnapshot = {
      success: true,
      data: [
        {
          id: "flagship",
          slug: "flagship",
          modelId: "flagship",
          modelName: "Flagship Pool",
          models: ["kimi-k3", "qwen3.8-max"],
          description: "Top AI Cluster",
          status: "active",
          minPricePerDay: "5.00",
          annualDiscount: 0.15,
          blocks: [
            { block: "asia", hoursUtc: "00:00-08:00 UTC", pricePerMonth: "$155", status: "sold-out" },
            { block: "europe", hoursUtc: "08:00-16:00 UTC", pricePerMonth: "$155", status: "sold-out" },
            { block: "americas", hoursUtc: "16:00-24:00 UTC", pricePerMonth: "$155", status: "sold-out" },
          ],
        },
      ],
    };

    // DiffEngine suppresses SLOT_DISAPPEARED on K=1
    const events = diffEngine.processSnapshot(transientStaleSnapshot);
    expect(events.length).toBe(0); // Noise-gated!

    // Authoritative snapshot from diffEngine retains Asia as limited!
    const auth2 = diffEngine.getSnapshot();
    expect(auth2).not.toBeNull();
    const asiaAuth = auth2!.data[0].blocks.find((b) => b.block === "asia");
    expect(asiaAuth!.status).toBe("limited");

    // Saving authoritative snapshot to DB keeps dashboard at 1/3!
    poolStateDao.saveSnapshot(auth2!, "html_rsc_stream", 50);
    summaries = poolStateDao.getPoolSummaries();
    expect(summaries[0].available_count).toBe(1);
    expect(summaries[0].total_blocks).toBe(3);

    // 3. Next tick: fresh live HTML snapshot reaffirms Asia is limited
    diffEngine.processSnapshot(snapshotAvailable);
    const auth3 = diffEngine.getSnapshot()!;
    poolStateDao.saveSnapshot(auth3, "html_rsc_stream", 50);

    summaries = poolStateDao.getPoolSummaries();
    expect(summaries[0].available_count).toBe(1);
    expect(summaries[0].total_blocks).toBe(3);
  });
});
