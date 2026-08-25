import { EventEmitter } from "node:events";
import { PoolsSnapshot, ScrapeResult, DiffEvent } from "../types/domain.js";
import { JsonApiEngine } from "../scrapers/jsonApiEngine.js";
import { HtmlSnapshotEngine } from "../scrapers/htmlSnapshotEngine.js";
import { SlotDiffEngine } from "./diffEngine.js";
import { SanityGuard } from "./sanityGuard.js";
import { PoolStateDAO } from "../db/dao/poolState.js";

export interface ScraperConfig {
  minIntervalSec: number;
  maxIntervalSec: number;
  maxBackoffSec: number;
}

export class ScraperOrchestrator extends EventEmitter {
  private isRunning = false;
  private isPolling = false;
  private timer?: NodeJS.Timeout;
  private consecutiveFailures = 0;
  private totalScrapes = 0;
  private lastScrapeTimestamp = 0;
  private lastScrapeLatencyMs = 0;
  private lastSource = "none";

  // Cache headers
  private apiEtag?: string;
  private apiLastModified?: string;
  private htmlEtag?: string;
  private htmlLastModified?: string;

  // Circuit Breaker for JSON API
  private apiConsecutiveErrors = 0;
  private apiCircuitOpenUntil = 0;

  constructor(
    private readonly apiEngine: JsonApiEngine,
    private readonly htmlEngine: HtmlSnapshotEngine,
    private readonly diffEngine: SlotDiffEngine,
    private readonly sanityGuard: SanityGuard,
    private readonly poolStateDao: PoolStateDAO,
    private readonly config: ScraperConfig
  ) {
    super();
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log("🚀 [ScraperOrchestrator] Starting adaptive polling scraper engine...");
    this.scheduleNext(0);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    console.log("🛑 [ScraperOrchestrator] Scraper engine stopped.");
  }

  private calculateNextIntervalMs(): number {
    if (this.consecutiveFailures === 0) {
      const range = this.config.maxIntervalSec - this.config.minIntervalSec;
      const randomSec = this.config.minIntervalSec + Math.random() * range;
      return Math.floor(randomSec * 1000);
    }

    const exponentialSec = this.config.minIntervalSec * Math.pow(1.5, this.consecutiveFailures);
    const cappedSec = Math.min(exponentialSec, this.config.maxBackoffSec);
    const jitterMs = Math.floor(Math.random() * 5000);
    return Math.floor(cappedSec * 1000) + jitterMs;
  }

  private scheduleNext(delayMs?: number): void {
    if (!this.isRunning) return;
    const interval = delayMs !== undefined ? delayMs : this.calculateNextIntervalMs();

    this.timer = setTimeout(async () => {
      try {
        await this.poll();
      } catch (err: any) {
        this.emit("error", err);
      } finally {
        if (this.isRunning) {
          this.scheduleNext();
        }
      }
    }, interval);
  }

  public async poll(): Promise<DiffEvent[]> {
    if (this.isPolling) {
      return [];
    }

    this.isPolling = true;
    this.totalScrapes++;
    const startTime = Date.now();

    try {
      const result = await this.fetchFromEngines();

      // Handle HTTP 304 Cache Not Modified
      if (!result.modified || !result.snapshot) {
        this.consecutiveFailures = 0;
        this.lastScrapeTimestamp = Date.now();
        this.lastScrapeLatencyMs = result.latencyMs;
        this.lastSource = result.source;

        this.emit("heartbeat", {
          source: result.source,
          latencyMs: result.latencyMs,
          modified: false,
        });
        return [];
      }

      // Validate snapshot integrity
      this.sanityGuard.validateSnapshot(result.snapshot);

      this.consecutiveFailures = 0;
      this.lastScrapeTimestamp = Date.now();
      this.lastScrapeLatencyMs = result.latencyMs;
      this.lastSource = result.source;

      // 1. FAST PATH: Compute diffs and dispatch alerts IMMEDIATELY at T+0ms
      const events = this.diffEngine.processSnapshot(result.snapshot);

      this.emit("heartbeat", {
        source: result.source,
        latencyMs: result.latencyMs,
        modified: true,
        eventsCount: events.length,
      });

      if (events.length > 0) {
        this.emit("diff_events", events);
      }

      // 2. Persist state to SQLite asynchronously without blocking alert dispatch
      queueMicrotask(() => {
        try {
          this.poolStateDao.saveSnapshot(result.snapshot!);
        } catch (e: any) {
          this.emit("warn", `Failed to save snapshot to SQLite: ${e.message}`);
        }
      });

      return events;
    } catch (err: any) {
      this.consecutiveFailures++;
      this.lastScrapeTimestamp = Date.now();
      this.lastScrapeLatencyMs = Date.now() - startTime;
      this.emit("error", err);
      return [];
    } finally {
      this.isPolling = false;
    }
  }

  private async fetchFromEngines(): Promise<ScrapeResult> {
    const now = Date.now();
    const isApiCircuitOpen = this.apiConsecutiveErrors >= 2 && now < this.apiCircuitOpenUntil;

    // If API Circuit is OPEN, route directly to HTML engine without incurring 3.5s timeout
    if (isApiCircuitOpen) {
      const htmlResult = await this.htmlEngine.fetch(
        this.htmlEtag,
        this.htmlLastModified,
        5_000
      );
      if (htmlResult.etag) this.htmlEtag = htmlResult.etag;
      if (htmlResult.lastModified) this.htmlLastModified = htmlResult.lastModified;
      return htmlResult;
    }

    try {
      const apiResult = await this.apiEngine.fetch(
        this.apiEtag,
        this.apiLastModified,
        3_500 // Fast 3.5s timeout for ultra-fast failover
      );
      this.apiConsecutiveErrors = 0;
      if (apiResult.etag) this.apiEtag = apiResult.etag;
      if (apiResult.lastModified) this.apiLastModified = apiResult.lastModified;
      return apiResult;
    } catch (apiErr: any) {
      this.apiConsecutiveErrors++;
      if (this.apiConsecutiveErrors >= 2) {
        // Open circuit for 60 seconds
        this.apiCircuitOpenUntil = Date.now() + 60_000;
        this.emit("warn", `API Engine circuit opened for 60s due to consecutive failures. Defaulting to HTML fallback.`);
      } else {
        this.emit("warn", `API Engine failed (${apiErr.message}). Switching to HTML fallback.`);
      }

      const htmlResult = await this.htmlEngine.fetch(
        this.htmlEtag,
        this.htmlLastModified,
        5_000
      );
      if (htmlResult.etag) this.htmlEtag = htmlResult.etag;
      if (htmlResult.lastModified) this.htmlLastModified = htmlResult.lastModified;
      return htmlResult;
    }
  }

  public getTelemetry() {
    return {
      isRunning: this.isRunning,
      isPolling: this.isPolling,
      totalScrapes: this.totalScrapes,
      consecutiveFailures: this.consecutiveFailures,
      lastScrapeTimestamp: this.lastScrapeTimestamp,
      lastScrapeLatencyMs: this.lastScrapeLatencyMs,
      lastSource: this.lastSource,
      apiCircuitOpen: Date.now() < this.apiCircuitOpenUntil,
    };
  }
}
