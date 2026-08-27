import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import { RobustHttpClient } from "../src/http/client.js";
import { ProxyPool } from "../src/proxy/proxyPool.js";

describe("RobustHttpClient", () => {
  const proxyPool = new ProxyPool(undefined, true);
  const client = new RobustHttpClient(proxyPool);

  it("should correctly decompress gzip payloads", async () => {
    const rawText = JSON.stringify({ success: true, test: "gzip_payload" });
    const gzipped = zlib.gzipSync(Buffer.from(rawText));

    const decompressed = await (client as any).decompressBodyAsync(gzipped, "gzip");
    expect(decompressed).toBe(rawText);
    expect(JSON.parse(decompressed).test).toBe("gzip_payload");
  });

  it("should correctly decompress brotli payloads", async () => {
    const rawText = JSON.stringify({ success: true, test: "brotli_payload" });
    const brotlied = zlib.brotliCompressSync(Buffer.from(rawText));

    const decompressed = await (client as any).decompressBodyAsync(brotlied, "br");
    expect(decompressed).toBe(rawText);
    expect(JSON.parse(decompressed).test).toBe("brotli_payload");
  });

  it("should correctly decompress deflate payloads", async () => {
    const rawText = JSON.stringify({ success: true, test: "deflate_payload" });
    const deflated = zlib.deflateSync(Buffer.from(rawText));

    const decompressed = await (client as any).decompressBodyAsync(deflated, "deflate");
    expect(decompressed).toBe(rawText);
    expect(JSON.parse(decompressed).test).toBe("deflate_payload");
  });

  it("should fallback to raw deflate decompression on raw deflate streams", async () => {
    const rawText = JSON.stringify({ success: true, test: "raw_deflate_payload" });
    const rawDeflated = zlib.deflateRawSync(Buffer.from(rawText));

    const decompressed = await (client as any).decompressBodyAsync(rawDeflated, "deflate");
    expect(decompressed).toBe(rawText);
    expect(JSON.parse(decompressed).test).toBe("raw_deflate_payload");
  });

  it("should generate proper Chrome 128 browser headers with same-site and Priority", () => {
    const headers = (client as any).getBrowserHeaders(false, '"etag-123"', 'Wed, 21 Oct 2026 07:28:00 GMT');
    expect(headers["User-Agent"]).toContain("Chrome/128.0.0.0");
    expect(headers["sec-ch-ua"]).toContain('"Chromium";v="128"');
    expect(headers["Sec-Fetch-Site"]).toBe("same-site");
    expect(headers["Priority"]).toBe("u=1, i");
    expect(headers["If-None-Match"]).toBe('"etag-123"');
    expect(headers["If-Modified-Since"]).toBe('Wed, 21 Oct 2026 07:28:00 GMT');

    const htmlHeaders = (client as any).getBrowserHeaders(true);
    expect(htmlHeaders["Priority"]).toBe("u=0, i");
    expect(htmlHeaders["Sec-Fetch-Mode"]).toBe("navigate");
  });

  it("should cache DNS resolutions and handle raw IP addresses", async () => {
    const { InMemoryDnsCache } = await import("../src/http/dnsCache.js");
    const dnsCache = new InMemoryDnsCache(60);

    // Raw IP should resolve immediately
    const ipRes = await dnsCache.resolve("127.0.0.1");
    expect(ipRes).toEqual([{ address: "127.0.0.1", family: 4 }]);

    // Localhost lookup
    const localRes = await dnsCache.resolve("localhost");
    expect(localRes.length).toBeGreaterThan(0);
    expect([4, 6]).toContain(localRes[0].family);

    // Warm hit from cache
    const cachedRes = await dnsCache.resolve("localhost");
    expect(cachedRes).toEqual(localRes);
  });
});
