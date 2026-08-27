import { Dispatcher, Agent, ProxyAgent, request } from "undici";
import { SocksClient } from "socks";
import zlib from "node:zlib";
import tls from "node:tls";
import util from "node:util";
import { ProxyPool } from "../proxy/proxyPool.js";

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

import { defaultDnsCache } from "./dnsCache.js";

export class RobustHttpClient {
  private dispatchers = new Map<string, Dispatcher>();
  private tlsSessionCache = new Map<string, Buffer>();
  private directAgent: Agent;

  constructor(private readonly proxyPool: ProxyPool) {
    this.directAgent = new Agent({
      connect: {
        timeout: 10_000,
        lookup: defaultDnsCache.lookup as any,
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 50, // 50ms instead of 250ms default on dual-stack
        keepAlive: true,
        keepAliveInitialDelay: 1000,
        noDelay: true,
      },
      keepAliveTimeout: 45_000, // Below Cloudflare 60s idle timeout
      keepAliveMaxTimeout: 55_000,
      keepAliveTimeoutThreshold: 1000,
      pipelining: 1,
      connections: 8, // Optimal memory & socket footprint
      strictContentLength: false,
    });
    this.proxyPool.setHttpClient(this);
  }

  public invalidateDispatcher(proxyUrl: string): void {
    const existing = this.dispatchers.get(proxyUrl);
    if (existing) {
      this.dispatchers.delete(proxyUrl);
      try {
        existing.destroy();
      } catch {}
    }
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
    try {
      this.directAgent.destroy();
    } catch {}
    for (const d of this.dispatchers.values()) {
      try {
        d.destroy();
      } catch {}
    }
    this.dispatchers.clear();
    this.tlsSessionCache.clear();
  }

  private getOrCreateDispatcher(proxyUrl: string | null, timeoutMs: number): Dispatcher {
    if (!proxyUrl) return this.directAgent;
    let dispatcher = this.dispatchers.get(proxyUrl);
    if (dispatcher) return dispatcher;

    // Bound dispatchers map to max 10 entries to prevent memory growth on Tor rotation
    if (this.dispatchers.size >= 10) {
      const oldestKey = this.dispatchers.keys().next().value;
      if (oldestKey) {
        this.invalidateDispatcher(oldestKey);
      }
    }

    const parsed = new URL(proxyUrl);
    if (parsed.protocol.startsWith("socks")) {
      const host = parsed.hostname;
      const port = parseInt(parsed.port, 10) || 1080;
      const user = parsed.username || undefined;
      const pass = parsed.password || undefined;

      dispatcher = new Agent({
        connect: (opts: any, callback: any) => {
          const destHost = opts.hostname || opts.host;
          const destPort =
            opts.port && parseInt(opts.port, 10) > 0
              ? parseInt(opts.port, 10)
              : opts.protocol === "http:"
              ? 80
              : 443;

          const client = new SocksClient({
            proxy: {
              host,
              port,
              type: 5,
              userId: user,
              password: pass,
            },
            command: "connect",
            destination: {
              host: destHost,
              port: destPort,
            },
            timeout: Math.min(timeoutMs, 6_000),
          });

          let isHandshakeComplete = false;

          // Always listen to error on client to prevent unhandled EventEmitter exception on timeout
          client.on("error", (err: any) => {
            if (!isHandshakeComplete) {
              isHandshakeComplete = true;
              callback(err, null);
            }
          });

          client.on("established", (info) => {
            info.socket.setNoDelay(true);

            if (opts.protocol === "https:" || destPort === 443) {
              const cachedSession = this.tlsSessionCache.get(destHost);
              const tlsSocket = tls.connect({
                socket: info.socket,
                servername: opts.servername || destHost,
                rejectUnauthorized: true,
                ALPNProtocols: ["http/1.1"],
                session: cachedSession,
              });
              tlsSocket.setNoDelay(true);

              // Capture TLS session ticket for 1-RTT / 0-RTT resumption
              tlsSocket.on("session", (sessionBuffer: Buffer) => {
                this.tlsSessionCache.set(destHost, sessionBuffer);
              });

              const tlsTimeout = Math.min(timeoutMs, 5_000);
              tlsSocket.setTimeout(tlsTimeout, () => {
                if (!isHandshakeComplete) {
                  isHandshakeComplete = true;
                  info.socket.destroy();
                  tlsSocket.destroy(new Error("TLS Handshake Timeout over SOCKS5"));
                  callback(new Error("TLS Handshake Timeout over SOCKS5"), null);
                }
              });

              tlsSocket.once("secureConnect", () => {
                if (!isHandshakeComplete) {
                  isHandshakeComplete = true;
                  tlsSocket.setTimeout(0);
                  callback(null, tlsSocket);
                }
              });
              tlsSocket.on("error", (err) => {
                if (!isHandshakeComplete) {
                  isHandshakeComplete = true;
                  info.socket.destroy();
                  callback(err, null);
                }
              });
              info.socket.on("error", (err) => {
                if (!isHandshakeComplete) {
                  isHandshakeComplete = true;
                  tlsSocket.destroy();
                  callback(err, null);
                }
              });
            } else {
              isHandshakeComplete = true;
              callback(null, info.socket);
            }
          });

          client.connect();
        },
        keepAliveTimeout: 45_000,
        keepAliveMaxTimeout: 55_000,
        keepAliveTimeoutThreshold: 1000,
        connections: 8,
        strictContentLength: false,
      });
    } else {
      dispatcher = new ProxyAgent({
        uri: proxyUrl,
        connect: { timeout: timeoutMs },
        keepAliveTimeout: 45_000,
        keepAliveMaxTimeout: 55_000,
        connections: 8,
      });
    }

    this.dispatchers.set(proxyUrl, dispatcher);
    return dispatcher;
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
      "Priority": isHtml ? "u=0, i" : "u=1, i",
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

  /**
   * Asynchronous non-blocking body decompression (prevents V8 event loop freezes on 100-300KB payloads)
   */
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
    } catch {
      // Fallback to raw string
    }
    return buffer.toString("utf-8");
  }

  public async get(opts: HttpRequestOptions): Promise<HttpResponse> {
    const proxyUrl = this.proxyPool.getNextProxyUrl();
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const maxRedirects = opts.maxRedirects ?? 5;
    const startTime = Date.now();

    let currentUrl = opts.url;
    let redirectsCount = 0;
    let socketRetried = false;

    while (redirectsCount <= maxRedirects) {
      const dispatcher = this.getOrCreateDispatcher(proxyUrl, timeoutMs);
      try {
        const headers = this.getBrowserHeaders(
          opts.isHtmlFallback ?? false,
          opts.etag,
          opts.lastModified
        );

        const res = await request(currentUrl, {
          method: "GET",
          headers,
          dispatcher,
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
          signal: AbortSignal.timeout(timeoutMs),
        });

        const statusCode = res.statusCode;
        const latencyMs = Date.now() - startTime;

        // Handle Redirects
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

        // Handle 304 Not Modified
        if (statusCode === 304) {
          await res.body.dump();
          this.proxyPool.reportSuccess(proxyUrl, latencyMs);
          return {
            statusCode: 304,
            headers: res.headers as any,
            body: "",
            etag: (res.headers["etag"] as string) || opts.etag,
            lastModified: (res.headers["last-modified"] as string) || opts.lastModified,
            latencyMs,
            usedProxy: proxyUrl,
            finalUrl: currentUrl,
          };
        }

        // Fast path for errors: 403 Forbidden / 429 Too Many Requests
        if (statusCode === 403 || statusCode === 429) {
          await res.body.dump();
          this.proxyPool.reportFailure(proxyUrl, statusCode);
          throw new Error(`HTTP Error ${statusCode} via proxy ${proxyUrl || "DIRECT"}`);
        }

        if (statusCode >= 400) {
          await res.body.dump();
          this.proxyPool.reportFailure(proxyUrl, statusCode);
          throw new Error(`HTTP Error ${statusCode}`);
        }

        // Decompress body asynchronously without stalling main thread
        const rawBuffer = Buffer.from(await res.body.arrayBuffer());
        const contentEncoding = res.headers["content-encoding"] as string | undefined;
        const bodyText = await this.decompressBodyAsync(rawBuffer, contentEncoding);

        this.proxyPool.reportSuccess(proxyUrl, latencyMs);

        return {
          statusCode,
          headers: res.headers as any,
          body: bodyText,
          etag: res.headers["etag"] as string | undefined,
          lastModified: res.headers["last-modified"] as string | undefined,
          latencyMs,
          usedProxy: proxyUrl,
          finalUrl: currentUrl,
        };
      } catch (err: any) {
        // Transparent single-shot retry on dead keep-alive socket
        const isSocketReset =
          err.code === "UND_ERR_SOCKET" ||
          err.code === "ECONNRESET" ||
          err.code === "EPIPE" ||
          err.message?.includes("other side closed");

        if (isSocketReset && !socketRetried) {
          socketRetried = true;
          if (proxyUrl) this.invalidateDispatcher(proxyUrl);
          continue;
        }

        if (redirectsCount > 0 && err.message.includes("Redirect")) {
          throw err;
        }
        this.proxyPool.reportFailure(proxyUrl, 500);
        throw err;
      }
    }

    throw new Error(`Exceeded maximum redirects (${maxRedirects}) for ${opts.url}`);
  }
}
