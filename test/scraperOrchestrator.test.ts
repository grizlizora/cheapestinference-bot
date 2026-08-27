import { describe, it, expect, vi, beforeEach } from "vitest";
import { ScraperOrchestrator } from "../src/engine/scraperOrchestrator.js";
import { SlotDiffEngine } from "../src/engine/diffEngine.js";
import { SanityGuard } from "../src/engine/sanityGuard.js";
import { PoolStateDAO } from "../src/db/dao/poolState.js";
import { PoolsSnapshot } from "../src/types/domain.js";
import Database from "better-sqlite3";

describe("ScraperOrchestrator forceRefresh & Singleflight", () => {
  let db: Database.Database;
  let poolStateDao: PoolStateDAO;
  let diffEngine: SlotDiffEngine;
  let sanityGuard: SanityGuard;
  let orchestrator: ScraperOrchestrator;
  let mockApiEngine: any;
  let mockHtmlEngine: any;

  const sampleSnapshot: PoolsSnapshot = {
    success: true,
    data: [
      {
        id: "flagship",
        slug: "flagship",
        modelId: "flagship",
        modelName: "Flagship Pool",
        models: ["kimi-k3"],
        description: "Flagship tier",
        status: "active",
        minPricePerDay: "149.00",
        annualDiscount: 0.15,
        blocks: [
          { block: "asia", hoursUtc: "00:00-08:00 UTC", pricePerMonth: "149.00", status: "sold-out" },
        ],
      },
    ],
  };

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE IF NOT EXISTS pool_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pool_slug TEXT NOT NULL,
        pool_name TEXT NOT NULL,
        models_json TEXT NOT NULL,
        block_id TEXT NOT NULL,
        status TEXT NOT NULL,
        hours_utc TEXT NOT NULL,
        price_month TEXT NOT NULL,
        min_price_day TEXT NOT NULL,
        annual_discount REAL NOT NULL DEFAULT 0.15,
        description TEXT NOT NULL DEFAULT '',
        infra_spec TEXT NOT NULL DEFAULT '',
        manual_provisioning INTEGER NOT NULL DEFAULT 0,
        last_changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(pool_slug, block_id)
      );
      CREATE TABLE IF NOT EXISTS system_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    poolStateDao = new PoolStateDAO(db);
    diffEngine = new SlotDiffEngine();
    sanityGuard = new SanityGuard();

    mockApiEngine = {
      fetch: vi.fn().mockResolvedValue({
        success: true,
        modified: true,
        snapshot: sampleSnapshot,
        etag: '"etag-1"',
        lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
        source: "api_json",
        latencyMs: 120,
      }),
    };

    mockHtmlEngine = {
      fetch: vi.fn(),
    };

    orchestrator = new ScraperOrchestrator(
      mockApiEngine,
      mockHtmlEngine,
      diffEngine,
      sanityGuard,
      poolStateDao,
      {
        minIntervalSec: 15,
        maxIntervalSec: 30,
        maxBackoffSec: 60,
      }
    );
  });

  it("should perform live scrape and update database synchronously on forceRefresh", async () => {
    const res = await orchestrator.forceRefresh(0);
    expect(res.refreshed).toBe(true);
    expect(res.source).toBe("api_json");
    expect(mockApiEngine.fetch).toHaveBeenCalledTimes(1);

    const summaries = poolStateDao.getPoolSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].slug).toBe("flagship");

    const lastVerified = poolStateDao.getLastVerified();
    expect(lastVerified).not.toBeNull();
    expect(lastVerified?.source).toBe("api_json");
  });

  it("should coalesce concurrent forceRefresh calls into a single HTTP scrape (Singleflight)", async () => {
    // Fire 5 concurrent forceRefresh requests
    const promises = [
      orchestrator.forceRefresh(0),
      orchestrator.forceRefresh(0),
      orchestrator.forceRefresh(0),
      orchestrator.forceRefresh(0),
      orchestrator.forceRefresh(0),
    ];

    const results = await Promise.all(promises);
    expect(results).toHaveLength(5);
    // API Engine fetch should only have been called ONCE due to inFlightPollPromise
    expect(mockApiEngine.fetch).toHaveBeenCalledTimes(1);
  });

  it("should touch system_metadata on HTTP 304 Cache Not Modified", async () => {
    mockApiEngine.fetch.mockResolvedValueOnce({
      success: true,
      modified: false,
      snapshot: null,
      source: "api_json_304",
      latencyMs: 45,
    });

    const events = await orchestrator.poll();
    expect(events).toHaveLength(0);

    const lastVerified = poolStateDao.getLastVerified();
    expect(lastVerified).not.toBeNull();
    expect(lastVerified?.source).toBe("api_json_304");
  });
});
