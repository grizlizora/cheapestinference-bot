import { RobustHttpClient } from "../http/client.js";
import { PoolsSnapshot, ScrapeResult } from "../types/domain.js";
import { IFetcherEngine } from "./types.js";

export class JsonApiEngine implements IFetcherEngine {
  private readonly apiUrl = "https://api.cheapestinference.com/api/pools";

  constructor(private readonly httpClient: RobustHttpClient) {}

  public async fetch(etag?: string, lastModified?: string): Promise<ScrapeResult> {
    const res = await this.httpClient.get({
      url: this.apiUrl,
      etag,
      lastModified,
      isHtmlFallback: false,
    });

    if (res.statusCode === 304) {
      return {
        success: true,
        modified: false,
        etag,
        lastModified,
        source: "cache_not_modified",
        latencyMs: res.latencyMs,
      };
    }

    if (res.statusCode !== 200) {
      throw new Error(`JSON API responded with HTTP ${res.statusCode}`);
    }

    const json = JSON.parse(res.body) as PoolsSnapshot;

    if (!json.success || !Array.isArray(json.data) || json.data.length === 0) {
      throw new Error("Invalid payload format from JSON API");
    }

    return {
      success: true,
      modified: true,
      snapshot: json,
      etag: res.etag,
      lastModified: res.lastModified,
      source: "api",
      latencyMs: res.latencyMs,
    };
  }
}
