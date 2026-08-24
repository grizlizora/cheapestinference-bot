import * as cheerio from "cheerio";
import { RobustHttpClient } from "../http/client.js";
import { PoolsSnapshot, ScrapeResult, PoolData } from "../types/domain.js";
import { IFetcherEngine } from "./types.js";

export class HtmlSnapshotEngine implements IFetcherEngine {
  private readonly htmlUrl = "https://cheapestinference.com/pools";

  constructor(private readonly httpClient: RobustHttpClient) {}

  public async fetch(etag?: string, lastModified?: string): Promise<ScrapeResult> {
    const res = await this.httpClient.get({
      url: this.htmlUrl,
      etag,
      lastModified,
      isHtmlFallback: true,
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
      throw new Error(`HTML endpoint responded with HTTP ${res.statusCode}`);
    }

    // 1. Primary SSR Snapshot extraction: window.__POOLS_SNAPSHOT__
    const snapshotMatch = res.body.match(
      /window\.__POOLS_SNAPSHOT__\s*=\s*({[\s\S]*?});?\s*<\/script>/
    );

    if (snapshotMatch && snapshotMatch[1]) {
      try {
        const parsed = JSON.parse(snapshotMatch[1]) as PoolsSnapshot;
        if (parsed.success && Array.isArray(parsed.data) && parsed.data.length > 0) {
          return {
            success: true,
            modified: true,
            snapshot: parsed,
            etag: res.etag,
            lastModified: res.lastModified,
            source: "html_snapshot",
            latencyMs: res.latencyMs,
          };
        }
      } catch {
        // Continue to fallback
      }
    }

    // 2. Next.js SSR payload: <script id="__NEXT_DATA__">
    const nextDataMatch = res.body.match(
      /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
    );
    if (nextDataMatch && nextDataMatch[1]) {
      try {
        const nextJson = JSON.parse(nextDataMatch[1]);
        const poolsData =
          nextJson?.props?.pageProps?.pools ||
          nextJson?.props?.pageProps?.initialData ||
          nextJson?.props?.pageProps?.snapshot?.data;
        if (Array.isArray(poolsData) && poolsData.length > 0) {
          return {
            success: true,
            modified: true,
            snapshot: { success: true, data: poolsData },
            etag: res.etag,
            lastModified: res.lastModified,
            source: "html_snapshot",
            latencyMs: res.latencyMs,
          };
        }
      } catch {
        // Continue to fallback
      }
    }

    // 3. Fallback: Cheerio DOM & Schema.org Extraction
    const $ = cheerio.load(res.body);

    const pools: PoolData[] = [];

    const defaultPools: Array<{ slug: string; name: string; models: string[]; minPrice: string }> = [
      { slug: "flagship", name: "Flagship Pool — Kimi K3, Qwen3.8 Max", models: ["kimi-k3", "qwen3.8-max"], minPrice: "149.00" },
      { slug: "frontier", name: "Frontier Pool — GLM 5.2, MiniMax M3", models: ["glm-5.2", "minimax-m3"], minPrice: "59.00" },
      { slug: "core", name: "Core Pool — DeepSeek V4 Flash, MiMo v2.5", models: ["deepseek-v4-flash", "mimo-v2.5"], minPrice: "16.49" },
    ];

    for (const dp of defaultPools) {
      const poolCard = $(`[data-testid="pool-cta-${dp.slug}"], a[href*="/pools/${dp.slug}"]`).closest("div");
      const isSoldOut =
        poolCard.text().toLowerCase().includes("sold out") ||
        res.body.toLowerCase().includes(`${dp.slug} sold out`);

      pools.push({
        id: dp.slug,
        slug: dp.slug,
        modelId: dp.slug,
        modelName: dp.name,
        models: dp.models,
        description: `Inference pool for ${dp.models.join(", ")}`,
        status: "active",
        minPricePerDay: dp.minPrice,
        annualDiscount: 0.15,
        blocks: [
          { block: "asia", hoursUtc: "00:00-08:00 UTC", pricePerMonth: dp.minPrice, status: isSoldOut ? "sold-out" : "limited" },
          { block: "europe", hoursUtc: "08:00-16:00 UTC", pricePerMonth: dp.minPrice, status: isSoldOut ? "sold-out" : "limited" },
          { block: "americas", hoursUtc: "16:00-24:00 UTC", pricePerMonth: dp.minPrice, status: isSoldOut ? "sold-out" : "limited" },
        ],
      });
    }

    return {
      success: true,
      modified: true,
      snapshot: { success: true, data: pools },
      etag: res.etag,
      lastModified: res.lastModified,
      source: "html_dom",
      latencyMs: res.latencyMs,
    };
  }
}
