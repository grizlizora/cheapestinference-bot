import { promises as dnsPromises } from "node:dns";
import dns from "node:dns";
import { isIP } from "node:net";

interface CachedDnsEntry {
  addresses: Array<{ address: string; family: number }>;
  expiresAt: number;
  inFlight?: Promise<Array<{ address: string; family: number }>>;
}

/**
 * High-performance, non-blocking in-memory DNS Cache.
 * Uses c-ares via dns.promises to avoid blocking libuv POSIX getaddrinfo threadpool.
 * Supports Stale-While-Revalidate background refreshing for 0ms cache hits.
 */
export class InMemoryDnsCache {
  private cache = new Map<string, CachedDnsEntry>();
  private readonly defaultTtlMs: number;

  constructor(ttlSeconds = 300) {
    this.defaultTtlMs = ttlSeconds * 1000;
  }

  public lookup = (
    hostname: string,
    options: dns.LookupOptions | ((err: NodeJS.ErrnoException | null, address: any, family?: number) => void),
    callback?: (err: NodeJS.ErrnoException | null, address: any, family?: number) => void
  ): void => {
    let cb = callback;
    let opts: dns.LookupOptions = {};
    if (typeof options === "function") {
      cb = options;
      opts = {};
    } else if (options) {
      opts = options;
    }
    const effectiveCb = cb || (() => {});
    this.resolve(hostname, opts)
      .then((records) => {
        if (opts.all) {
          effectiveCb(null, records);
        } else {
          const first = records[0] || { address: "127.0.0.1", family: 4 };
          effectiveCb(null, first.address, first.family);
        }
      })
      .catch((err) => effectiveCb(err, "", 4));
  };

  public async resolve(
    hostname: string,
    options: dns.LookupOptions = {}
  ): Promise<Array<{ address: string; family: number }>> {
    // 1. Check if hostname is already a raw IP address
    const ipFamily = isIP(hostname);
    if (ipFamily !== 0) {
      return [{ address: hostname, family: ipFamily }];
    }

    const now = Date.now();
    const entry = this.cache.get(hostname);

    // 2. Cache Hit (Warm & Valid)
    if (entry && entry.expiresAt > now && entry.addresses.length > 0) {
      // Stale-While-Revalidate: refresh in background if near expiry (< 30s)
      if (entry.expiresAt - now < 30_000 && !entry.inFlight) {
        this.refreshInBackground(hostname);
      }
      return entry.addresses;
    }

    // 3. In-flight Singleflight Deduplication
    if (entry?.inFlight) {
      return entry.inFlight;
    }

    // 4. Cold miss or expired: execute asynchronous resolution
    const resolvePromise = this.performLookup(hostname);
    if (entry) {
      entry.inFlight = resolvePromise;
    } else {
      this.setEntry(hostname, {
        addresses: [],
        expiresAt: 0,
        inFlight: resolvePromise,
      });
    }

    try {
      const records = await resolvePromise;
      this.setEntry(hostname, {
        addresses: records,
        expiresAt: Date.now() + this.defaultTtlMs,
      });
      return records;
    } catch (err) {
      if (entry) {
        entry.inFlight = undefined;
      }
      // Fallback: If network lookup fails, return stale entry if available
      if (entry && entry.addresses.length > 0) {
        return entry.addresses;
      }
      this.cache.delete(hostname);
      throw err;
    }
  }

  private setEntry(hostname: string, entry: CachedDnsEntry): void {
    if (this.cache.size >= 200 && !this.cache.has(hostname)) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(hostname, entry);
  }

  private refreshInBackground(hostname: string): void {
    const entry = this.cache.get(hostname);
    if (!entry || entry.inFlight) return;

    entry.inFlight = this.performLookup(hostname)
      .then((records) => {
        this.setEntry(hostname, {
          addresses: records,
          expiresAt: Date.now() + this.defaultTtlMs,
        });
        return records;
      })
      .catch(() => entry.addresses)
      .finally(() => {
        if (entry) entry.inFlight = undefined;
      });
  }

  private async performLookup(hostname: string): Promise<Array<{ address: string; family: number }>> {
    try {
      // Non-blocking c-ares IPv4 lookup
      const ipv4 = await dnsPromises.resolve4(hostname);
      if (ipv4 && ipv4.length > 0) {
        return ipv4.map((addr) => ({ address: addr, family: 4 }));
      }
    } catch {}

    // Fallback to standard async lookup
    const res = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
    return res.map((r) => ({ address: r.address, family: r.family }));
  }

  public clear(): void {
    this.cache.clear();
  }
}

export const defaultDnsCache = new InMemoryDnsCache(300);
