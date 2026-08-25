import { RobustHttpClient } from "../http/client.js";
import { PoolsSnapshot, ScrapeResult } from "../types/domain.js";
import { IFetcherEngine } from "./types.js";

export class JsonApiEngine implements IFetcherEngine {
  private readonly apiUrl = "https://api.cheapestinference.com/api/pools";

  constructor(private readonly httpClient: RobustHttpClient) {}

  public async fetch(
    etag?: string,
    lastModified?: string,
    timeoutMs: number = 8_000
  ): Promise<ScrapeResult> {
    const res = await this.httpClient.get({
      url: this.apiUrl,
      etag,
      lastModified,
      isHtmlFallback: false,
      timeoutMs,
    });

    if (res.statusCode === 304) {
      return {
        success: true,
        modified: false,
        etag: res.etag || etag,
        lastModified: res.lastModified || lastModified,
        source: "cache_not_modified",
        latencyMs: res.latencyMs,
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

    const snapshot: PoolsSnapshot = {
      success: true,
      data: poolsData,
    };

    return {
      success: true,
      modified: true,
      snapshot,
      etag: res.etag,
      lastModified: res.lastModified,
      source: "api",
      latencyMs: res.latencyMs,
    };
  }
}
