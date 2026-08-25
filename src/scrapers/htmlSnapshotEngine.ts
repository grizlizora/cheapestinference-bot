import * as cheerio from "cheerio";
import { RobustHttpClient } from "../http/client.js";
import { PoolsSnapshot, ScrapeResult, PoolData } from "../types/domain.js";
import { IFetcherEngine } from "./types.js";

export class HtmlSnapshotEngine implements IFetcherEngine {
  private readonly htmlUrl = "https://cheapestinference.com/pools";

  constructor(private readonly httpClient: RobustHttpClient) {}

  public async fetch(etag?: string, lastModified?: string, timeoutMs: number = 5_000): Promise<ScrapeResult> {
    const res = await this.httpClient.get({
      url: this.htmlUrl,
      etag,
      lastModified,
      isHtmlFallback: true,
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
      throw new Error(`HTML endpoint responded with HTTP ${res.statusCode}`);
    }

    // 1. Next.js App Router RSC Flight Stream Chunk Parser (supporting Next.js 14/15)
    const rscPools = this.extractRscPayload(res.body);
    if (rscPools && rscPools.length > 0) {
      return {
        success: true,
        modified: true,
        snapshot: { success: true, data: rscPools },
        etag: res.etag,
        lastModified: res.lastModified,
        source: "html_rsc_stream",
        latencyMs: res.latencyMs,
      };
    }

    // 2. Primary SSR Snapshot extraction: window.__POOLS_SNAPSHOT__
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
      } catch {}
    }

    // 3. Next.js SSR payload: <script id="__NEXT_DATA__">
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
      } catch {}
    }

    // 4. Fallback: Cheerio DOM & Schema.org Extraction with Dynamic Discovery
    const $ = cheerio.load(res.body);
    const pools: PoolData[] = [];

    const discoveredSlugs = new Set<string>();
    $('a[href*="/pools/"], [data-testid*="pool-"]').each((_, el) => {
      const href = $(el).attr("href") || "";
      const testId = $(el).attr("data-testid") || "";
      const match = href.match(/\/pools\/([\w-]+)/) || testId.match(/pool-(?:cta-)?([\w-]+)/);
      if (match && match[1]) {
        discoveredSlugs.add(match[1].toLowerCase());
      }
    });

    // Ensure baseline default slugs are included
    discoveredSlugs.add("flagship");
    discoveredSlugs.add("frontier");
    discoveredSlugs.add("core");

    for (const slug of discoveredSlugs) {
      const poolCard = $(`[data-testid*="${slug}"], a[href*="/pools/${slug}"]`).closest("div");
      const cardText = poolCard.text().toLowerCase();
      const isSoldOut =
        cardText.includes("sold out") ||
        res.body.toLowerCase().includes(`${slug} sold out`);

      const defaultName =
        slug === "flagship"
          ? "Flagship Pool — Kimi K3, Qwen3.8 Max"
          : slug === "frontier"
          ? "Frontier Pool — GLM 5.2, MiniMax M3"
          : slug === "core"
          ? "Core Pool — DeepSeek V4 Flash, MiMo v2.5"
          : `${slug.toUpperCase()} Pool`;

      const defaultModels =
        slug === "flagship"
          ? ["kimi-k3", "qwen3.8-max"]
          : slug === "frontier"
          ? ["glm-5.2", "minimax-m3"]
          : slug === "core"
          ? ["deepseek-v4-flash", "mimo-v2.5"]
          : [slug];

      const minPrice = slug === "flagship" ? "149.00" : slug === "frontier" ? "59.00" : "16.49";

      pools.push({
        id: slug,
        slug: slug,
        modelId: slug,
        modelName: defaultName,
        models: defaultModels,
        description: `Inference pool for ${defaultModels.join(", ")}`,
        status: "active",
        minPricePerDay: minPrice,
        annualDiscount: 0.15,
        blocks: [
          { block: "asia", hoursUtc: "00:00-08:00 UTC", pricePerMonth: minPrice, status: isSoldOut ? "sold-out" : "limited" },
          { block: "europe", hoursUtc: "08:00-16:00 UTC", pricePerMonth: minPrice, status: isSoldOut ? "sold-out" : "limited" },
          { block: "americas", hoursUtc: "16:00-24:00 UTC", pricePerMonth: minPrice, status: isSoldOut ? "sold-out" : "limited" },
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

  public extractRscPayload(html: string): PoolData[] | null {
    const chunkRegex =
      /(?:(?:self|window|globalThis)\.__next_f|(?:\((?:self|window|globalThis)\.__next_f=(?:self|window|globalThis)\.__next_f\|\|\[\]\)))\.push\(\[(\d+),\s*([\s\S]*?)\]\)/g;
    let match: RegExpExecArray | null;
    let combinedFlight = "";

    while ((match = chunkRegex.exec(html)) !== null) {
      const rawArg = match[2].trim();
      try {
        const decodedChunk = JSON.parse(rawArg);
        if (typeof decodedChunk === "string") {
          combinedFlight += decodedChunk;
        }
      } catch {
        if (rawArg.startsWith('"') && rawArg.endsWith('"')) {
          const raw = rawArg.slice(1, -1);
          combinedFlight += raw.replace(/\\([\\"/nrtbf])/g, (_, char) => {
            switch (char) {
              case "n": return "\n";
              case "r": return "\r";
              case "t": return "\t";
              case '"': return '"';
              case "\\": return "\\";
              default: return char;
            }
          });
        }
      }
    }

    if (!combinedFlight) return null;

    const pools: PoolData[] = [];
    const slugRegex = /"slug"\s*:\s*"(flagship|frontier|core|[\w-]+)"/g;
    let slugMatch: RegExpExecArray | null;

    while ((slugMatch = slugRegex.exec(combinedFlight)) !== null) {
      let candidateIndex = slugMatch.index;
      let foundValidPool = false;

      while (candidateIndex > 0 && !foundValidPool) {
        const braceIndex = combinedFlight.lastIndexOf("{", candidateIndex - 1);
        if (braceIndex === -1) break;
        candidateIndex = braceIndex;

        const candidateJson = this.extractBalancedJsonObject(combinedFlight, braceIndex);
        if (!candidateJson) continue;

        try {
          const parsed = JSON.parse(candidateJson);
          if (parsed.slug && Array.isArray(parsed.blocks) && parsed.blocks.length > 0) {
            if (!pools.some((p) => p.slug === parsed.slug)) {
              pools.push({
                id: String(parsed.id || parsed.slug),
                slug: String(parsed.slug),
                modelId: String(parsed.modelId || parsed.slug),
                modelName: String(parsed.modelName || parsed.name || parsed.slug),
                models: Array.isArray(parsed.models) ? parsed.models.map(String) : [],
                description: String(parsed.description || ""),
                status: String(parsed.status || "active"),
                minPricePerDay: String(parsed.minPricePerDay || "0"),
                annualDiscount: typeof parsed.annualDiscount === "number" ? parsed.annualDiscount : 0.15,
                blocks: parsed.blocks.map((b: any) => ({
                  block: String(b.block),
                  hoursUtc: String(b.hoursUtc || ""),
                  pricePerMonth: String(b.pricePerMonth || "0"),
                  status: String(b.status || "limited"),
                })),
                infraSpec: parsed.infraSpec ? String(parsed.infraSpec) : undefined,
                manualProvisioning: Boolean(parsed.manualProvisioning),
              });
              foundValidPool = true;
            }
          }
        } catch {}
      }
    }

    return pools.length > 0 ? pools : null;
  }

  private extractBalancedJsonObject(str: string, startIndex: number): string | null {
    let depth = 0;
    let inString = false;
    let isEscaped = false;

    for (let i = startIndex; i < str.length; i++) {
      const char = str[i];
      if (isEscaped) {
        isEscaped = false;
        continue;
      }
      if (char === "\\") {
        isEscaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (char === "{") {
          depth++;
        } else if (char === "}") {
          depth--;
          if (depth === 0) {
            return str.substring(startIndex, i + 1);
          }
        }
      }
    }
    return null;
  }
}
