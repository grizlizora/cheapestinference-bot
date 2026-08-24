import EventEmitter from "node:events";
import { JsonApiEngine } from "../scrapers/jsonApiEngine.js";
import { HtmlSnapshotEngine } from "../scrapers/htmlSnapshotEngine.js";
import { SanityGuard } from "./sanityGuard.js";
import { SlotDiffEngine } from "./diffEngine.js";
import { PoolStateDAO } from "../db/dao/poolState.js";
import { DiffEvent, ScrapeResult } from "../types/domain.js";

export interface OrchestratorOptions {
  minIntervalSec: number;
  maxIntervalSec: number;
  maxBackoffSec: number;
}

export interface TelemetryData {
  lastScrapeTimestamp: number;
  lastScrapeLatencyMs: number;
  lastSource: string;
  consecutiveFailures: number;
  totalScrapes: number;
}

export class ScraperOrchestrator extends EventEmitter {
  private running = false;
  private isPolling = false;
  private apiEtag?: string;
  private apiLastModified?: string;
  private htmlEtag?: string;
  private htmlLastModified?: string;
  private timerHandle?: NodeJS.Timeout;
  private consecutiveFailures = 0;
  private totalScrapes = 0;
  private lastScrapeTimestamp = 0;
  private lastScrapeLatencyMs = 0;
  private lastSource = "none";

  constructor(
    private readonly apiEngine: JsonApiEngine,
    private readonly htmlEngine: HtmlSnapshotEngine,
    private readonly sanityGuard: SanityGuard,
    private readonly diffEngine: SlotDiffEngine,
    private readonly poolStateDao: PoolStateDAO,
    private readonly opts: OrchestratorOptions = {
      minIntervalSec: 15,
      maxIntervalSec: 35,
      maxBackoffSec: 300,
    }
  ) {
    super();
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    console.log("🕷 [ScraperOrchestrator] Starting polling loop...");
    this.scheduleNext(0);
  }

  public stop(): void {
    this.running = false;
    if (this.timerHandle) {
      clearTimeout(this.timerHandle);
      this.timerHandle = undefined;
    }
    console.log("🛑 [ScraperOrchestrator] Polling loop stopped.");
  }

  public getTelemetry(): TelemetryData {
    return {
      lastScrapeTimestamp: this.lastScrapeTimestamp,
      lastScrapeLatencyMs: this.lastScrapeLatencyMs,
      lastSource: this.lastSource,
      consecutiveFailures: this.consecutiveFailures,
      totalScrapes: this.totalScrapes,
    };
  }

  private calculateDelayMs(): number {
    if (this.consecutiveFailures > 0) {
      const exp = Math.min(
        this.opts.maxBackoffSec,
        this.opts.minIntervalSec * Math.pow(1.8, this.consecutiveFailures)
      );
      const jitter = Math.random() * 5;
      return (exp + jitter) * 1000;
    }

    const span = this.opts.maxIntervalSec - this.opts.minIntervalSec;
    const intervalSec = this.opts.minIntervalSec + Math.random() * span;
    return intervalSec * 1000;
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timerHandle = setTimeout(() => this.poll(), delayMs);
  }

  public async poll(): Promise<ScrapeResult | null> {
    if (this.isPolling) return null;
    if (!this.running && this.totalScrapes > 0) return null;

    this.isPolling = true;
    this.totalScrapes++;
    let result: ScrapeResult;

    try {
      // 1. Try Primary JSON API Engine
      try {
        result = await this.apiEngine.fetch(
          this.apiEtag,
          this.apiLastModified
        );
        if (result.etag) this.apiEtag = result.etag;
        if (result.lastModified) this.apiLastModified = result.lastModified;
      } catch (apiErr: any) {
        this.emit("warn", `API Engine failed (${apiErr.message}). Switching to HTML fallback.`);
        // 2. Seamless HTML Fallback with isolated ETag
        result = await this.htmlEngine.fetch(
          this.htmlEtag,
          this.htmlLastModified
        );
        if (result.etag) this.htmlEtag = result.etag;
        if (result.lastModified) this.htmlLastModified = result.lastModified;
      }

      this.lastScrapeLatencyMs = result.latencyMs;
      this.lastScrapeTimestamp = Date.now();
      this.lastSource = result.source;
      this.consecutiveFailures = 0;

      if (result.modified && result.snapshot) {
        // Validate payload sanity
        const validSnapshot = this.sanityGuard.validateSnapshot(result.snapshot);

        // Update database with latest dynamic pool data
        this.poolStateDao.saveSnapshot(validSnapshot);

        // Compute state diffs
        const events: DiffEvent[] = this.diffEngine.processSnapshot(validSnapshot);

        if (events.length > 0) {
          this.emit("diff_events", events);
        }
      }

      this.emit("heartbeat", {
        source: result.source,
        latencyMs: result.latencyMs,
        modified: result.modified,
        timestamp: this.lastScrapeTimestamp,
      });

      return result;
    } catch (err: any) {
      this.consecutiveFailures++;
      this.emit("error", err);
      return null;
    } finally {
      this.isPolling = false;
      if (this.running) {
        this.scheduleNext(this.calculateDelayMs());
      }
    }
  }
}
