import { TorManager } from "./torManager.js";
import type { RobustHttpClient } from "../http/client.js";

export type ProxyType = "worker" | "direct" | "external" | "tor";

export interface ProxyEntry {
  url: string;
  type: ProxyType;
  priority: number; // 0: worker, 1: direct, 2: external, 3: tor
  lastUsedAt: number;
  consecutiveErrors: number;
  bannedUntil: number | null;
  latencyMs: number;
  totalSuccesses: number;
  totalFailures: number;
}

export class ProxyPool {
  private proxies: ProxyEntry[] = [];
  private allowDirectFallback: boolean;
  private httpClient?: RobustHttpClient;

  constructor(
    private torManager?: TorManager,
    allowDirectFallback: boolean = true,
    externalProxyList: string[] = [],
    cfWorkerUrl?: string
  ) {
    this.allowDirectFallback = allowDirectFallback;

    // Tier 1: Cloudflare Worker Fast-Path (Priority 0)
    if (cfWorkerUrl && cfWorkerUrl.trim()) {
      this.proxies.push({
        url: cfWorkerUrl.trim(),
        type: "worker",
        priority: 0,
        lastUsedAt: 0,
        consecutiveErrors: 0,
        bannedUntil: null,
        latencyMs: 50,
        totalSuccesses: 0,
        totalFailures: 0,
      });
    }

    // Tier 2: Direct Fast-Path with In-Memory DNS Cache (Priority 1)
    if (this.allowDirectFallback) {
      this.proxies.push({
        url: "",
        type: "direct",
        priority: 1,
        lastUsedAt: 0,
        consecutiveErrors: 0,
        bannedUntil: null,
        latencyMs: 80,
        totalSuccesses: 0,
        totalFailures: 0,
      });
    }

    // Tier 2.5: External Proxies (Priority 2)
    for (const url of externalProxyList) {
      if (url.trim()) {
        this.proxies.push({
          url: url.trim(),
          type: "external",
          priority: 2,
          lastUsedAt: 0,
          consecutiveErrors: 0,
          bannedUntil: null,
          latencyMs: 200,
          totalSuccesses: 0,
          totalFailures: 0,
        });
      }
    }

    // Tier 3: Tor SOCKS5 Standby (Priority 3)
    if (this.torManager) {
      this.proxies.push({
        url: this.torManager.getSocksUrl(),
        type: "tor",
        priority: 3,
        lastUsedAt: 0,
        consecutiveErrors: 0,
        bannedUntil: null,
        latencyMs: 500,
        totalSuccesses: 0,
        totalFailures: 0,
      });
    }
  }

  public setHttpClient(client: RobustHttpClient): void {
    this.httpClient = client;
  }

  public getNextProxy(): ProxyEntry {
    const now = Date.now();

    // Auto-recover proxies whose quarantine expired
    for (const p of this.proxies) {
      if (p.bannedUntil !== null && p.bannedUntil <= now) {
        console.log(`♻️ [ProxyPool] Quarantine expired for [${p.type.toUpperCase()}]. Reinstated to active pool.`);
        p.bannedUntil = null;
        p.consecutiveErrors = 0;
      }
    }

    const available = this.proxies.filter((p) => p.bannedUntil === null || p.bannedUntil <= now);

    if (available.length === 0) {
      console.warn("🚨 [ProxyPool] All proxy tiers are quarantined! Forcing Direct fallback.");
      return this.proxies.find((p) => p.type === "direct") || this.proxies[0];
    }

    // Strict Tier Priority sorting with Error & LRU tiebreakers
    available.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.consecutiveErrors !== b.consecutiveErrors) return a.consecutiveErrors - b.consecutiveErrors;
      return a.lastUsedAt - b.lastUsedAt;
    });

    const selected = available[0];
    selected.lastUsedAt = now;
    return selected;
  }

  public getNextProxyUrl(): string | null {
    const proxy = this.getNextProxy();
    return proxy.url || null;
  }

  public reportSuccess(proxyUrl: string | null, latencyMs: number): void {
    const entry = this.findEntry(proxyUrl);
    if (entry) {
      entry.consecutiveErrors = 0;
      entry.bannedUntil = null;
      entry.latencyMs = latencyMs;
      entry.totalSuccesses += 1;
    }
  }

  public async reportFailure(proxyUrl: string | null, statusCode?: number): Promise<void> {
    const entry = this.findEntry(proxyUrl);
    if (!entry) return;

    entry.consecutiveErrors += 1;
    entry.totalFailures += 1;
    const now = Date.now();

    // HTTP 429 (Rate Limit) or 403 (Cloudflare WAF Block)
    if (statusCode === 429 || statusCode === 403) {
      if (entry.type === "worker") {
        entry.bannedUntil = now + 600_000; // Quarantine worker for 10m
        console.warn(`⚠️ [ProxyPool] Tier 1 Cloudflare Worker blocked (HTTP ${statusCode}). Demoting to Tier 2 (Direct) for 10m.`);
        return;
      }

      if (entry.type === "direct") {
        entry.bannedUntil = now + 900_000; // Quarantine direct for 15m
        console.warn(`⚠️ [ProxyPool] Tier 2 Direct IP blocked (HTTP ${statusCode}). Demoting to Tier 3 (Tor) for 15m.`);
        return;
      }

      if (entry.type === "external") {
        entry.bannedUntil = now + 300_000; // Quarantine external for 5m
        this.httpClient?.invalidateDispatcher(entry.url);
        console.warn(`⚠️ [ProxyPool] External proxy ${entry.url} blocked (HTTP ${statusCode}). Quarantined for 5m.`);
        return;
      }

      if (entry.type === "tor" && this.torManager) {
        console.warn("🧅 [ProxyPool] Tor IP throttled/blocked. Rotating SOCKS5 stream isolation circuit...");
        this.httpClient?.invalidateDispatcher(entry.url);
        entry.url = this.torManager.rotateStreamIsolation();
        if (entry.consecutiveErrors >= 3) {
          entry.bannedUntil = now + 120_000; // Quarantine Tor for 2m
          console.warn("🧅 [ProxyPool] Tor repeated 403/429 (>=3). Quarantined for 2m to enable Tier 1/2 retry.");
        }
        void this.torManager.renewCircuit().catch(() => {});
        return;
      }
    }

    // 5xx Server Errors & Network Timeouts
    if (entry.consecutiveErrors >= 3) {
      const quarantineMs = entry.type === "tor" ? 120_000 : 180_000;
      entry.bannedUntil = now + quarantineMs;
      if (entry.url) this.httpClient?.invalidateDispatcher(entry.url);
      console.warn(`⚠️ [ProxyPool] [${entry.type.toUpperCase()}] failed 3 consecutive times. Quarantined for ${quarantineMs / 1000}s.`);
      if (entry.type === "tor" && this.torManager) {
        entry.url = this.torManager.rotateStreamIsolation();
        void this.torManager.renewCircuit().catch(() => {});
      }
    }
  }

  private findEntry(proxyUrl: string | null): ProxyEntry | undefined {
    if (proxyUrl && (proxyUrl.startsWith("socks5h://tor_") || proxyUrl.includes("127.0.0.1:9050"))) {
      return this.proxies.find((p) => p.type === "tor");
    }
    const targetUrl = proxyUrl ?? "";
    return this.proxies.find((p) => p.url === targetUrl);
  }

  public getStatus() {
    const now = Date.now();
    return {
      total: this.proxies.length,
      available: this.proxies.filter((p) => p.bannedUntil === null || p.bannedUntil <= now).length,
      quarantined: this.proxies.filter((p) => p.bannedUntil !== null && p.bannedUntil > now).length,
      proxies: this.proxies.map((p) => ({
        type: p.type,
        priority: p.priority,
        url: p.url ? p.url.replace(/\/\/.*@/, "//***@") : "direct",
        consecutiveErrors: p.consecutiveErrors,
        isBanned: p.bannedUntil !== null && p.bannedUntil > now,
        latencyMs: p.latencyMs,
      })),
    };
  }
}

