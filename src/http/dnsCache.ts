import dns from "node:dns/promises";

interface DnsRecord {
  address: string;
  family: number;
  expiresAt: number;
}

/**
 * Fast in-memory DNS cache with TTL pre-resolving.
 * Bypasses libuv threadpool getaddrinfo(3) contention under high concurrency.
 */
export class FastDnsCache {
  private cache = new Map<string, DnsRecord>();
  private inFlight = new Map<string, Promise<DnsRecord>>();
  private readonly ttlMs: number;

  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  public lookup(
    hostname: string,
    options: any,
    callback: (err: any, address: string, family: number) => void
  ): void {
    const now = Date.now();
    const cached = this.cache.get(hostname);

    if (cached && cached.expiresAt > now) {
      callback(null, cached.address, cached.family);
      return;
    }

    let promise = this.inFlight.get(hostname);
    if (!promise) {
      promise = (async () => {
        try {
          const res = await dns.lookup(hostname, { family: 4 });
          const record: DnsRecord = {
            address: res.address,
            family: res.family,
            expiresAt: Date.now() + this.ttlMs,
          };
          this.cache.set(hostname, record);
          return record;
        } catch (err) {
          if (cached) {
            return cached;
          }
          throw err;
        } finally {
          this.inFlight.delete(hostname);
        }
      })();
      this.inFlight.set(hostname, promise);
    }

    promise
      .then((record) => callback(null, record.address, record.family))
      .catch((err) => callback(err, "", 4));
  }

  public clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }
}
