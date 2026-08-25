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
    // Schedule first periodic poll after calculated delay to prevent immediate duplicate
    this.scheduleNext(this.calculateDelayMs());
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
        this.opts.minIntervalSec * Math.pow(1.5, this.consecutiveFailures)
      );
      const jitter = Math.random() * 5_000;
      return Math.floor(exp * 1000 + jitter);
    }

    const range = this.opts.maxIntervalSec - this.opts.minIntervalSec;
    const intervalSec = this.opts.minIntervalSec + Math.random() * range;
    return Math.floor(intervalSec * 1000);
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    if (this.timerHandle) clearTimeout(this.timerHandle);

    this.timerHandle = setTimeout(async () => {
      await this.poll();
      if (this.running) {
        this.scheduleNext(this.calculateDelayMs());
      }
    }, delayMs);
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
      this.lastScrapeTimestamp = Date.now();
      this.lastScrapeLatencyMs = result.latencyMs;
      this.lastSource = result.source;
      this.consecutiveFailures = 0;

      // Handle HTTP 304 Cache Not Modified
      if (!result.modified || !result.snapshot) {
        this.emit("heartbeat", {
          source: result.source,
          latencyMs: result.latencyMs,
          modified: false,
        });
        return [];
      }

      // Validate snapshot integrity
      this.sanityGuard.validateSnapshot(result.snapshot);

      // Persist latest state to database
      this.poolStateDao.saveSnapshot(result.snapshot);

      // Compute diffs against previous baseline
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
    try {
      const apiResult = await this.apiEngine.fetch(
        this.apiEtag,
        this.apiLastModified,
        8_000
      );
      if (apiResult.etag) this.apiEtag = apiResult.etag;
      if (apiResult.lastModified) this.apiLastModified = apiResult.lastModified;
      return apiResult;
    } catch (apiErr: any) {
      this.emit("warn", `API Engine failed (${apiErr.message}). Switching to HTML fallback.`);

      const htmlResult = await this.htmlEngine.fetch(
        this.htmlEtag,
        this.htmlLastModified
      );
      if (htmlResult.etag) this.htmlEtag = htmlResult.etag;
      if (htmlResult.lastModified) this.htmlLastModified = htmlResult.lastModified;
      return htmlResult;
    }
  }
}
