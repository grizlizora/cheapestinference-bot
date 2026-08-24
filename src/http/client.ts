import { Dispatcher, Agent, ProxyAgent, request } from "undici";
import { SocksClient } from "socks";
import zlib from "node:zlib";
import tls from "node:tls";
import { ProxyPool } from "../proxy/proxyPool.js";

export interface HttpRequestOptions {
  url: string;
  etag?: string;
  lastModified?: string;
  isHtmlFallback?: boolean;
  timeoutMs?: number;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  etag?: string;
  lastModified?: string;
  latencyMs: number;
  usedProxy: string | null;
}

export class RobustHttpClient {
  private dispatchers = new Map<string, Dispatcher>();
  private directAgent: Agent;

  constructor(private readonly proxyPool: ProxyPool) {
    this.directAgent = new Agent({
      connect: { timeout: 10_000 },
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 120_000,
      pipelining: 1,
    });
  }

  private getOrCreateDispatcher(proxyUrl: string | null, timeoutMs: number): Dispatcher {
    if (!proxyUrl) return this.directAgent;
    if (this.dispatchers.has(proxyUrl)) {
      return this.dispatchers.get(proxyUrl)!;
    }

    let dispatcher: Dispatcher;

    if (proxyUrl.startsWith("socks5")) {
      const parsed = new URL(proxyUrl);
      dispatcher = new Agent({
        connect: (opts, callback) => {
          SocksClient.createConnection({
            proxy: {
              host: parsed.hostname,
              port: parseInt(parsed.port, 10) || 1080,
              type: 5,
              userId: parsed.username ? decodeURIComponent(parsed.username) : undefined,
              password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
            },
            command: "connect",
            destination: {
              host: opts.hostname,
              port: parseInt(opts.port, 10) || (opts.protocol === "https:" ? 443 : 80),
            },
            timeout: timeoutMs,
          })
            .then((info) => {
              if (opts.protocol === "https:") {
                const tlsSocket = tls.connect({
                  socket: info.socket,
                  servername: opts.servername || opts.hostname,
                  rejectUnauthorized: true,
                });
                tlsSocket.on("secureConnect", () => callback(null, tlsSocket));
                tlsSocket.on("error", (err) => callback(err, null));
              } else {
                callback(null, info.socket);
              }
            })
            .catch((err) => callback(err, null));
        },
        keepAliveTimeout: 30_000,
        keepAliveMaxTimeout: 60_000,
      });
    } else {
      dispatcher = new ProxyAgent({
        uri: proxyUrl,
        connect: { timeout: timeoutMs },
        keepAliveTimeout: 30_000,
        keepAliveMaxTimeout: 60_000,
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
      headers["Sec-Fetch-Site"] = "same-origin";
      headers["Referer"] = "https://cheapestinference.com/pools";
      headers["Origin"] = "https://cheapestinference.com";
    }

    if (etag) headers["If-None-Match"] = etag;
    if (lastModified) headers["If-Modified-Since"] = lastModified;

    return headers;
  }

  private decompressBody(buffer: Buffer, encoding?: string): string {
    if (!encoding || buffer.length === 0) return buffer.toString("utf-8");
    const enc = encoding.toLowerCase().trim();
    try {
      if (enc === "gzip" || enc === "x-gzip") {
        return zlib.gunzipSync(buffer).toString("utf-8");
      } else if (enc === "br") {
        return zlib.brotliDecompressSync(buffer).toString("utf-8");
      } else if (enc === "deflate") {
        return zlib.inflateSync(buffer).toString("utf-8");
      }
    } catch {
      // Fallback to raw string if decompression throws
    }
    return buffer.toString("utf-8");
  }

  public async get(opts: HttpRequestOptions): Promise<HttpResponse> {
    const proxyUrl = this.proxyPool.getNextProxyUrl();
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const startTime = Date.now();
    const dispatcher = this.getOrCreateDispatcher(proxyUrl, timeoutMs);
    const headers = this.getBrowserHeaders(!!opts.isHtmlFallback, opts.etag, opts.lastModified);

    try {
      const res = await request(opts.url, {
        method: "GET",
        headers,
        dispatcher,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });

      const latencyMs = Date.now() - startTime;
      const rawBuffer = Buffer.from(await res.body.arrayBuffer());
      const contentEncoding = res.headers["content-encoding"] as string | undefined;
      const bodyText = this.decompressBody(rawBuffer, contentEncoding);

      const responseEtag =
        typeof res.headers["etag"] === "string" ? res.headers["etag"] : undefined;
      const responseLastModified =
        typeof res.headers["last-modified"] === "string"
          ? res.headers["last-modified"]
          : undefined;

      if (res.statusCode >= 200 && res.statusCode < 400) {
        this.proxyPool.reportSuccess(proxyUrl, latencyMs);
      } else {
        await this.proxyPool.reportFailure(proxyUrl, res.statusCode);
      }

      return {
        statusCode: res.statusCode,
        headers: res.headers as Record<string, string | string[] | undefined>,
        body: bodyText,
        etag: responseEtag,
        lastModified: responseLastModified,
        latencyMs,
        usedProxy: proxyUrl,
      };
    } catch (err: any) {
      await this.proxyPool.reportFailure(proxyUrl, 500);
      throw err;
    }
  }
}
