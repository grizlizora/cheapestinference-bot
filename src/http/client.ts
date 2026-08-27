/**
 * src/http/client.ts
 * Robust Multi-Tier HTTP Client (Worker -> Direct -> Tor) with Non-Blocking Decompression
 */

import { Dispatcher, request } from "undici";
import zlib from "node:zlib";
import util from "node:util";
import { ProxyPool } from "../proxy/proxyPool.js";
import { UndiciDispatcherPool } from "./undiciAgent.js";

export { UndiciDispatcherPool };

const gunzipAsync = util.promisify(zlib.gunzip);
const brotliDecompressAsync = util.promisify(zlib.brotliDecompress);
const inflateAsync = util.promisify(zlib.inflate);
const inflateRawAsync = util.promisify(zlib.inflateRaw);

export interface HttpRequestOptions {
  url: string;
  etag?: string;
  lastModified?: string;
  isHtmlFallback?: boolean;
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  etag?: string;
  lastModified?: string;
  latencyMs: number;
  usedProxy: string | null;
  finalUrl: string;
}

export class RobustHttpClient {
  private readonly dispatcherPool: UndiciDispatcherPool;
  private readonly workerSecret?: string;

  constructor(
    private readonly proxyPool: ProxyPool,
    workerSecret?: string
  ) {
    this.workerSecret = workerSecret;
    this.dispatcherPool = new UndiciDispatcherPool();
    this.proxyPool.setHttpClient(this);
  }

  public invalidateDispatcher(proxyUrl: string): void {
    this.dispatcherPool.invalidate(proxyUrl);
  }

  public async warmUp(urls: string[]): Promise<void> {
    await Promise.allSettled(
      urls.map((url) =>
        this.get({
          url,
          timeoutMs: 3_000,
          etag: '"warmup-probe"',
        }).catch(() => {})
      )
    );
  }

  public destroy(): void {
    this.dispatcherPool.destroy();
  }

  private getBrowserHeaders(
    isHtml: boolean,
    etag?: string,
    lastModified?: string
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "sec-ch-ua": '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
      DNT: "1",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9,uk;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      Priority: isHtml ? "u=0, i" : "u=1, i",
    };

    if (isHtml) {
      headers["Accept"] =
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";
      headers["Sec-Fetch-Dest"] = "document";
      headers["Sec-Fetch-Mode"] = "navigate";
      headers["Sec-Fetch-Site"] = "none";
      headers["Sec-Fetch-User"] = "?1";
      headers["Upgrade-Insecure-Requests"] = "1";
    } else {
      headers["Accept"] = "application/json, text/plain, */*";
      headers["Sec-Fetch-Dest"] = "empty";
      headers["Sec-Fetch-Mode"] = "cors";
      headers["Sec-Fetch-Site"] = "same-site";
      headers["Referer"] = "https://cheapestinference.com/pools";
      headers["Origin"] = "https://cheapestinference.com";
    }

    if (etag) headers["If-None-Match"] = etag;
    if (lastModified) headers["If-Modified-Since"] = lastModified;

    return headers;
  }

  private async decompressBodyAsync(buffer: Buffer, encoding?: string | string[]): Promise<string> {
    if (!encoding || buffer.length === 0) return buffer.toString("utf-8");
    const rawEncoding = Array.isArray(encoding) ? encoding[0] : encoding;
    if (!rawEncoding || typeof rawEncoding !== "string") return buffer.toString("utf-8");
    const enc = rawEncoding.toLowerCase().trim();
    try {
      if (enc === "gzip" || enc === "x-gzip") {
        const decompressed = await gunzipAsync(buffer);
        return decompressed.toString("utf-8");
      } else if (enc === "br") {
        const decompressed = await brotliDecompressAsync(buffer);
        return decompressed.toString("utf-8");
      } else if (enc === "deflate") {
        try {
          const decompressed = await inflateAsync(buffer);
          return decompressed.toString("utf-8");
        } catch {
          const decompressed = await inflateRawAsync(buffer);
          return decompressed.toString("utf-8");
        }
      }
    } catch {}
    return buffer.toString("utf-8");
  }

  public async get(opts: HttpRequestOptions): Promise<HttpResponse> {
    const proxy = this.proxyPool.getNextProxy();
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const maxRedirects = opts.maxRedirects ?? 5;
    const startTime = Date.now();

    let currentUrl = opts.url;
    let redirectsCount = 0;
    let socketRetried = false;

    while (redirectsCount <= maxRedirects) {
      let targetRequestUrl = currentUrl;
      let dispatcher: Dispatcher;

      if (proxy.type === "worker") {
        const workerUrl = new URL(proxy.url);
        workerUrl.searchParams.set("url", currentUrl);
        targetRequestUrl = workerUrl.toString();
        dispatcher = this.dispatcherPool.getDirectDispatcher();
      } else if (proxy.type === "direct") {
        dispatcher = this.dispatcherPool.getDirectDispatcher();
      } else {
        dispatcher = this.dispatcherPool.getOrCreateDispatcher(proxy.url, timeoutMs);
      }

      try {
        const headers = this.getBrowserHeaders(
          opts.isHtmlFallback ?? false,
          opts.etag,
          opts.lastModified
        );

        if (proxy.type === "worker" && this.workerSecret) {
          headers["x-proxy-secret"] = this.workerSecret;
        }

        const combinedSignal = opts.signal
          ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs);

        const res = await request(targetRequestUrl, {
          method: "GET",
          headers,
          dispatcher,
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
          signal: combinedSignal,
        });

        const statusCode = res.statusCode;
        const latencyMs = Date.now() - startTime;
        const proxyTag = proxy.type === "worker" ? `worker:${proxy.url}` : proxy.url || null;

        if ([301, 302, 303, 307, 308].includes(statusCode)) {
          const location = res.headers["location"];
          await res.body.dump();
          if (!location || typeof location !== "string") {
            throw new Error(`Redirect with invalid location header: ${statusCode}`);
          }
          currentUrl = new URL(location, currentUrl).toString();
          redirectsCount++;
          continue;
        }

        if (statusCode === 304) {
          await res.body.dump();
          this.proxyPool.reportSuccess(proxy.url, latencyMs);
          return {
            statusCode: 304,
            headers: res.headers as any,
            body: "",
            etag: (res.headers["etag"] as string) || opts.etag,
            lastModified: (res.headers["last-modified"] as string) || opts.lastModified,
            latencyMs,
            usedProxy: proxyTag,
            finalUrl: currentUrl,
          };
        }

        if (statusCode === 403 || statusCode === 429) {
          await res.body.dump();
          await this.proxyPool.reportFailure(proxy.url, statusCode);
          throw new Error(`HTTP Error ${statusCode} via [${proxy.type.toUpperCase()}]`);
        }

        if (statusCode >= 400) {
          await res.body.dump();
          await this.proxyPool.reportFailure(proxy.url, statusCode);
          throw new Error(`HTTP Error ${statusCode} via [${proxy.type.toUpperCase()}]`);
        }

        const contentEncoding = res.headers["content-encoding"] as string | undefined;
        let bodyText: string;
        if (!contentEncoding || contentEncoding.toLowerCase() === "identity") {
          bodyText = await res.body.text();
        } else {
          const rawBuffer = Buffer.from(await res.body.arrayBuffer());
          bodyText = await this.decompressBodyAsync(rawBuffer, contentEncoding);
        }

        this.proxyPool.reportSuccess(proxy.url, latencyMs);

        return {
          statusCode,
          headers: res.headers as any,
          body: bodyText,
          etag: res.headers["etag"] as string | undefined,
          lastModified: res.headers["last-modified"] as string | undefined,
          latencyMs,
          usedProxy: proxyTag,
          finalUrl: currentUrl,
        };
      } catch (err: any) {
        const isSocketReset =
          err.code === "UND_ERR_SOCKET" ||
          err.code === "ECONNRESET" ||
          err.code === "EPIPE" ||
          err.message?.includes("other side closed");

        if (isSocketReset && !socketRetried) {
          socketRetried = true;
          if (proxy.url) this.invalidateDispatcher(proxy.url);
          continue;
        }

        if (redirectsCount > 0 && err.message.includes("Redirect")) {
          throw err;
        }
        await this.proxyPool.reportFailure(proxy.url, 500);
        throw err;
      }
    }

    throw new Error(`Exceeded maximum redirects (${maxRedirects}) for ${opts.url}`);
  }
}
