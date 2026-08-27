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

    // 4. Fallback: Cheerio DOM & Schema.org Extraction
    const $ = cheerio.load(res.body);
    const pools: PoolData[] = [];

    // Attempt to extract structured schema.org or data attributes if present
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).text());
        if (json && Array.isArray(json.itemListElement)) {
          // Process structured microdata
        }
      } catch {}
    });

    if (pools.length === 0) {
      throw new Error("Unable to extract valid pool data from HTML response (RSC flight stream and SSR snapshots unavailable)");
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
    let combinedFlight = "";
    const pushPrefixRegex = /(?:(?:self|window|globalThis)\.__next_f|(?:\((?:self|window|globalThis)\.__next_f=(?:self|window|globalThis)\.__next_f\|\|\[\]\)))\.push\(\[\d+,\s*/g;
    let match: RegExpExecArray | null;

    while ((match = pushPrefixRegex.exec(html)) !== null) {
      const startIndex = match.index + match[0].length;
      const firstChar = html[startIndex];

      if (firstChar === '"') {
        let inEscape = false;
        let endIndex = -1;
        for (let i = startIndex + 1; i < html.length; i++) {
          if (inEscape) {
            inEscape = false;
            continue;
          }
          if (html[i] === "\\") {
            inEscape = true;
            continue;
          }
          if (html[i] === '"') {
            endIndex = i;
            break;
          }
        }
        if (endIndex !== -1) {
          const stringLiteral = html.substring(startIndex, endIndex + 1);
          try {
            const decoded = JSON.parse(stringLiteral);
            if (typeof decoded === "string") {
              combinedFlight += decoded;
            }
          } catch {
            const raw = stringLiteral.slice(1, -1);
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
