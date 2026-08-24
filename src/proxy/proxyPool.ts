import { TorManager } from "./torManager.js";

export interface ProxyItem {
  url: string;
  type: "tor" | "socks5" | "http" | "https";
  alive: boolean;
  latencyMs: number;
  consecutiveErrors: number;
  bannedUntil?: number;
  lastUsedAt: number;
}

export class ProxyPool {
  private proxies: ProxyItem[] = [];

  constructor(
    private readonly torManager?: TorManager,
    private readonly allowDirectFallback = true,
    initialProxyUrls: string[] = []
  ) {
    if (this.torManager) {
      this.proxies.push({
        url: this.torManager.getSocksUrl(),
        type: "tor",
        alive: true,
        latencyMs: 0,
        consecutiveErrors: 0,
        lastUsedAt: 0,
      });
    }

    for (const url of initialProxyUrls) {
      this.addProxy(url);
    }
  }

  public addProxy(url: string): void {
    let type: ProxyItem["type"] = "http";
    if (url.startsWith("socks5")) type = "socks5";
    else if (url.startsWith("https")) type = "https";

    this.proxies.push({
      url,
      type,
      alive: true,
      latencyMs: 0,
      consecutiveErrors: 0,
      lastUsedAt: 0,
    });
  }

  public getNextProxyUrl(): string | null {
    const now = Date.now();

    // Auto-recover proxies whose quarantine has expired
    for (const p of this.proxies) {
      if (!p.alive && p.bannedUntil && p.bannedUntil <= now) {
        p.alive = true;
        p.bannedUntil = undefined;
        p.consecutiveErrors = 1; // probationary error count
      }
    }

    const available = this.proxies.filter(
      (p) => p.alive && (!p.bannedUntil || p.bannedUntil <= now)
    );

    if (available.length === 0) {
      if (this.allowDirectFallback) return null; // Direct connection
      throw new Error("No active proxies available and direct fallback is disabled");
    }

    // Sort by lowest consecutive errors, lowest latency, and LRU tiebreaker
    available.sort(
      (a, b) =>
        a.consecutiveErrors - b.consecutiveErrors ||
        a.latencyMs - b.latencyMs ||
        a.lastUsedAt - b.lastUsedAt
    );

    const selected = available[0];
    selected.lastUsedAt = now;
    return selected.url;
  }

  public reportSuccess(proxyUrl: string | null, latencyMs: number): void {
    if (!proxyUrl) return;
    const entry = this.proxies.find((p) => p.url === proxyUrl);
    if (entry) {
      entry.alive = true;
      entry.consecutiveErrors = 0;
      entry.latencyMs = latencyMs;
      entry.bannedUntil = undefined;
    }
  }

  public async reportFailure(proxyUrl: string | null, statusCode?: number): Promise<void> {
    if (!proxyUrl) return;
    const entry = this.proxies.find((p) => p.url === proxyUrl);
    if (!entry) return;

    entry.consecutiveErrors += 1;

    // Tor circuit rotation on rate-limiting / blocking
    if (
      entry.type === "tor" &&
      (statusCode === 429 || statusCode === 403 || entry.consecutiveErrors >= 2)
    ) {
      if (this.torManager) {
        await this.torManager.renewCircuit().catch(() => {});
        entry.consecutiveErrors = 0;
      }
      return;
    }

    if (statusCode === 429 || statusCode === 403) {
      // Quarantine for 1-5 minutes
      entry.bannedUntil = Date.now() + Math.min(300_000, 30_000 * Math.pow(2, entry.consecutiveErrors));
    } else if (entry.consecutiveErrors >= 3) {
      entry.alive = false;
      entry.bannedUntil = Date.now() + 60_000;
    }
  }

  public getStatus(): { total: number; alive: number; torActive: boolean } {
    return {
      total: this.proxies.length,
      alive: this.proxies.filter((p) => p.alive).length,
      torActive: this.proxies.some((p) => p.type === "tor" && p.alive),
    };
  }
}
