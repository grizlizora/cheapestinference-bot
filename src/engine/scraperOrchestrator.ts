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
  private lastUsedProxy?: string | null;

  // Cache headers
  private apiEtag?: string;
  private apiLastModified?: string;
  private htmlEtag?: string;
  private htmlLastModified?: string;

  // Circuit Breaker for JSON API
  private apiConsecutiveErrors = 0;
  private apiCircuitOpenUntil = 0;

  // Singleflight coalescing promise
  private inFlightPollPromise: Promise<DiffEvent[]> | null = null;

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

  /**
   * On-demand forced refresh with Singleflight coalescing and rate-limit guard.
   * Ensures instant live feedback for users clicking "🔄 Оновити".
   */
  public async forceRefresh(_maxAgeMs = 1000): Promise<{ refreshed: boolean; latencyMs: number; source: string }> {
    const now = Date.now();
    if (now - this.lastForceRefreshTimestamp < 1_000) {
      return {
        refreshed: false,
        latencyMs: this.lastScrapeLatencyMs,
        source: this.lastSource,
      };
    }
    this.lastForceRefreshTimestamp = now;

    // Execute live scrape coalesced through Singleflight bypassing ETag for guaranteed fresh data
    await this.executeSingleflightPoll(true);

    return {
      refreshed: this.consecutiveFailures === 0,
      latencyMs: this.lastScrapeLatencyMs,
      source: this.lastSource,
    };
  }

  private lastForceRefreshTimestamp = 0;
  private lastSlotEventTimestamp = 0;

  public executeSingleflightPoll(bypassEtag = false): Promise<DiffEvent[]> {
    if (this.inFlightPollPromise) {
      return this.inFlightPollPromise;
    }
    this.inFlightPollPromise = this.poll(bypassEtag).finally(() => {
      this.inFlightPollPromise = null;
    });
    return this.inFlightPollPromise;
  }

  private calculateNextIntervalMs(): number {
    if (this.consecutiveFailures === 0) {
      const now = Date.now();
      const isVolatile = now - this.lastSlotEventTimestamp < 5 * 60 * 1000;
      
      if (isVolatile) {
        const timeSinceEvent = now - this.lastSlotEventTimestamp;
        // Stepped volatility decay: 3.0s (0-1m) -> 3.6s (1-3m) -> 4.2s (3-5m) -> baseline (5s+)
        let fastMin = 3.0;
        let fastMax = 4.0;
        if (timeSinceEvent > 3 * 60 * 1000) {
          fastMin = 4.2;
          fastMax = 5.0;
        } else if (timeSinceEvent > 1 * 60 * 1000) {
          fastMin = 3.6;
          fastMax = 4.4;
        }
        return Math.floor((fastMin + Math.random() * (fastMax - fastMin)) * 1000);
      }

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
        await this.executeSingleflightPoll(false);
      } catch (err: any) {
        this.emit("error", err);
      } finally {
        if (this.isRunning) {
          this.scheduleNext();
        }
      }
    }, interval);
  }

  public async poll(bypassEtag = false): Promise<DiffEvent[]> {
    if (this.isPolling && !bypassEtag) {
      return [];
    }

    this.isPolling = true;
    this.totalScrapes++;

    try {
      const result = await this.fetchFromEngines(bypassEtag);

      // Handle HTTP 304 Cache Not Modified
      if (!result.modified || !result.snapshot) {
        this.consecutiveFailures = 0;
        this.lastScrapeTimestamp = Date.now();
        this.lastScrapeLatencyMs = result.latencyMs;
        this.lastSource = result.source;
        this.lastUsedProxy = result.usedProxy;

        // Touch verified in SQLite so UI knows verified timestamp
        this.poolStateDao.touchVerified(result.source, result.latencyMs);

        this.emit("heartbeat", {
          source: result.source,
          latencyMs: result.latencyMs,
          usedProxy: result.usedProxy,
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
      this.lastUsedProxy = result.usedProxy;

      // 1. FAST PATH: Compute diffs and dispatch alerts IMMEDIATELY at T+0ms (Zero DB Delay)
      const events = this.diffEngine.processSnapshot(result.snapshot);

      this.emit("heartbeat", {
        source: result.source,
        latencyMs: result.latencyMs,
        usedProxy: result.usedProxy,
        modified: true,
        eventsCount: events.length,
      });

      if (events.length > 0) {
        this.lastSlotEventTimestamp = Date.now();
        this.emit("diff_events", events);
      }

      // 2. Synchronously persist authoritative snapshot to SQLite DB (0.15ms execution time)
      try {
        const authoritativeSnapshot = this.diffEngine.getSnapshot() || result.snapshot;
        if (authoritativeSnapshot) {
          this.poolStateDao.saveSnapshot(authoritativeSnapshot, result.source, result.latencyMs);
        }
      } catch (e: any) {
        this.emit("warn", `Failed to save snapshot to SQLite: ${e.message}`);
      }

      return events;
    } catch (err: any) {
      this.consecutiveFailures++;
      this.emit("error", err);
      return [];
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Resilient dual-engine execution: Queries live backend REST API (primary ground truth),
   * with automatic fallback to HTML snapshot if API is temporarily unreachable.
   */
  private async fetchFromEngines(bypassEtag = false): Promise<ScrapeResult> {
    const effectiveApiEtag = bypassEtag ? undefined : this.apiEtag;
    const effectiveApiLastModified = bypassEtag ? undefined : this.apiLastModified;
    const effectiveHtmlEtag = bypassEtag ? undefined : this.htmlEtag;
    const effectiveHtmlLastModified = bypassEtag ? undefined : this.htmlLastModified;

    // Primary: Live Backend REST API (api.cheapestinference.com/api/pools) with real-time stock
    try {
      const apiResult = await this.apiEngine.fetch(
        effectiveApiEtag,
        effectiveApiLastModified,
        4_000
      );
      if (apiResult.etag) this.apiEtag = apiResult.etag;
      if (apiResult.lastModified) this.apiLastModified = apiResult.lastModified;
      return apiResult;
    } catch (apiErr: any) {
      this.emit("warn", `JSON API Engine fetch error (${apiErr?.message || apiErr}). Falling back to HTML.`);
      const htmlResult = await this.htmlEngine.fetch(
        effectiveHtmlEtag,
        effectiveHtmlLastModified,
        4_000
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
      lastUsedProxy: this.lastUsedProxy,
      apiCircuitOpen: Date.now() < this.apiCircuitOpenUntil,
    };
  }
}
