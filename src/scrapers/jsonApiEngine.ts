import { RobustHttpClient } from "../http/client.js";
import { PoolsSnapshot, ScrapeResult, normalizeSlotStatus } from "../types/domain.js";
import { IFetcherEngine } from "./types.js";

export class JsonApiEngine implements IFetcherEngine {
  private readonly apiUrl = "https://api.cheapestinference.com/api/pools";

  constructor(private readonly httpClient: RobustHttpClient) {}

  public async fetch(
    etag?: string,
    lastModified?: string,
    timeoutMs: number = 8_000,
    signal?: AbortSignal
  ): Promise<ScrapeResult> {
    const res = await this.httpClient.get({
      url: this.apiUrl,
      etag,
      lastModified,
      isHtmlFallback: false,
      timeoutMs,
      signal,
    });

    if (res.statusCode === 304) {
      return {
        success: true,
        modified: false,
        etag: res.etag || etag,
        lastModified: res.lastModified || lastModified,
        source: "cache_not_modified",
        latencyMs: res.latencyMs,
        usedProxy: res.usedProxy,
      };
    }

    if (res.statusCode !== 200) {
      throw new Error(`JSON API responded with HTTP ${res.statusCode}`);
    }

    const raw = JSON.parse(res.body);
    const poolsData = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.data)
      ? raw.data
      : Array.isArray(raw?.pools)
      ? raw.pools
      : null;

    if (!poolsData || poolsData.length === 0) {
      throw new Error("Invalid payload format from JSON API");
    }

    const normalizedPools = poolsData.map((rawPool: any) => ({
      id: String(rawPool.id || rawPool.slug),
      slug: String(rawPool.slug),
      modelId: String(rawPool.modelId || rawPool.slug),
      modelName: String(rawPool.modelName || rawPool.name || rawPool.slug),
      models: Array.isArray(rawPool.models) ? rawPool.models.map(String) : [],
      description: String(rawPool.description || ""),
      status: String(rawPool.status || "active"),
      minPricePerDay: String(rawPool.minPricePerDay || "0"),
      annualDiscount: typeof rawPool.annualDiscount === "number" ? rawPool.annualDiscount : 0.15,
      blocks: Array.isArray(rawPool.blocks)
        ? rawPool.blocks.map((b: any) => ({
            block: String(b.block),
            hoursUtc: String(b.hoursUtc || ""),
            pricePerMonth: String(b.pricePerMonth || "0"),
            status: normalizeSlotStatus(b.status),
          }))
        : [],
      infraSpec: rawPool.infraSpec ? String(rawPool.infraSpec) : undefined,
      manualProvisioning: Boolean(rawPool.manualProvisioning),
    }));

    const snapshot: PoolsSnapshot = {
      success: true,
      data: normalizedPools,
    };

    return {
      success: true,
      modified: true,
      snapshot,
      etag: res.etag,
      lastModified: res.lastModified,
      source: "api",
      latencyMs: res.latencyMs,
      usedProxy: res.usedProxy,
    };
  }
}
