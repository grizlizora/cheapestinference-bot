import { TorManager } from "./torManager.js";
import type { RobustHttpClient } from "../http/client.js";

export interface ProxyEntry {
  url: string;
  type: "tor" | "external" | "direct";
  lastUsedAt: number;
  consecutiveErrors: number;
  bannedUntil: number | null;
  latencyMs: number;
}

export class ProxyPool {
  private proxies: ProxyEntry[] = [];
  private allowDirectFallback: boolean;
  private httpClient?: RobustHttpClient;

  constructor(
    private torManager?: TorManager,
    allowDirectFallback: boolean = true,
    externalProxyList: string[] = []
  ) {
    this.allowDirectFallback = allowDirectFallback;

    if (this.torManager) {
      this.proxies.push({
        url: this.torManager.getSocksUrl(),
        type: "tor",
        lastUsedAt: 0,
        consecutiveErrors: 0,
        bannedUntil: null,
        latencyMs: 300,
      });
    }

    for (const url of externalProxyList) {
      if (url.trim()) {
        this.proxies.push({
          url: url.trim(),
          type: "external",
          lastUsedAt: 0,
          consecutiveErrors: 0,
          bannedUntil: null,
          latencyMs: 200,
        });
      }
    }

    if (this.proxies.length === 0 && this.allowDirectFallback) {
      this.proxies.push({
        url: "",
        type: "direct",
        lastUsedAt: 0,
        consecutiveErrors: 0,
        bannedUntil: null,
        latencyMs: 50,
      });
    }
  }

  public setHttpClient(client: RobustHttpClient): void {
    this.httpClient = client;
  }

  public getNextProxyUrl(): string | null {
    const now = Date.now();

    // Auto-recover proxies whose quarantine expired
    for (const p of this.proxies) {
      if (p.bannedUntil && p.bannedUntil <= now) {
        p.bannedUntil = null;
        p.consecutiveErrors = 0;
      }
    }

    const available = this.proxies.filter((p) => p.bannedUntil === null || p.bannedUntil <= now);

    if (available.length === 0) {
      if (this.allowDirectFallback) return null;
      return this.proxies[0]?.url || null;
    }

    // Least Recently Used (LRU) tiebreaker among lowest error proxies
    available.sort(
      (a, b) => a.consecutiveErrors - b.consecutiveErrors || a.lastUsedAt - b.lastUsedAt
    );

    const selected = available[0];
    selected.lastUsedAt = now;
    return selected.url || null;
  }

  public reportSuccess(proxyUrl: string | null, latencyMs: number): void {
    const entry = this.findEntry(proxyUrl);
    if (entry) {
      entry.consecutiveErrors = 0;
      entry.bannedUntil = null;
      entry.latencyMs = latencyMs;
    }
  }

  public async reportFailure(proxyUrl: string | null, statusCode?: number): Promise<void> {
    const entry = this.findEntry(proxyUrl);
    if (!entry) return;

    entry.consecutiveErrors += 1;

    // HTTP 429 (Rate Limit) or 403 (Cloudflare WAF Block)
    if (statusCode === 429 || statusCode === 403) {
      if (entry.type === "tor" && this.torManager) {
        console.warn("🧅 [ProxyPool] Tor IP throttled/blocked. Renewing Tor circuit...");
        await this.torManager.renewCircuit().catch(() => {});
        this.httpClient?.invalidateDispatcher(entry.url);
        entry.consecutiveErrors = 0;
        return;
      }

      // Quarantine non-Tor proxy for 5 minutes
      entry.bannedUntil = Date.now() + 300_000;
      this.httpClient?.invalidateDispatcher(entry.url);
      console.warn(`⚠️ [ProxyPool] Proxy ${entry.url || "direct"} banned for 5 minutes due to HTTP ${statusCode}`);
      return;
    }

    if (entry.consecutiveErrors >= 3) {
      if (entry.type === "tor" && this.torManager) {
        await this.torManager.renewCircuit().catch(() => {});
        this.httpClient?.invalidateDispatcher(entry.url);
        entry.consecutiveErrors = 0;
      } else {
        entry.bannedUntil = Date.now() + 180_000; // 3 min quarantine
        this.httpClient?.invalidateDispatcher(entry.url);
      }
    }
  }

  private findEntry(proxyUrl: string | null): ProxyEntry | undefined {
    const targetUrl = proxyUrl ?? "";
    return this.proxies.find((p) => p.url === targetUrl);
  }

  public getStatus() {
    return {
      total: this.proxies.length,
      available: this.proxies.filter((p) => p.bannedUntil === null || p.bannedUntil <= Date.now()).length,
      quarantined: this.proxies.filter((p) => p.bannedUntil !== null && p.bannedUntil > Date.now()).length,
      proxies: this.proxies.map((p) => ({
        type: p.type,
        url: p.url ? p.url.replace(/\/\/.*@/, "//***@") : "direct",
        consecutiveErrors: p.consecutiveErrors,
        isBanned: p.bannedUntil !== null && p.bannedUntil > Date.now(),
        latencyMs: p.latencyMs,
      })),
    };
  }
}
