import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { createHealthServer } from "../src/server/health.js";
import { ProxyPool } from "../src/proxy/proxyPool.js";

function createMockHttp() {
  const req = new EventEmitter() as any;
  req.method = "GET";
  req.url = "/health";

  let statusCode = 200;
  let headers: Record<string, string> = {};
  let body = "";

  const res = {
    writeHead: (code: number, h?: Record<string, string>) => {
      statusCode = code;
      if (h) headers = { ...headers, ...h };
      return res;
    },
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
      return res;
    },
    end: (chunk?: string) => {
      if (chunk) body += chunk;
    },
    getStatusCode: () => statusCode,
    getHeaders: () => headers,
    getBody: () => body,
  } as any;

  return { req, res };
}

describe("HealthServer Request Handler", () => {
  const mockScraper: any = {
    getTelemetry: () => ({
      lastScrapeTimestamp: Date.now(),
      lastScrapeLatencyMs: 150,
      lastSource: "api",
      consecutiveFailures: 0,
      totalScrapes: 42,
    }),
  };
  const proxyPool = new ProxyPool(undefined, true);
  const server = createHealthServer(0, mockScraper, proxyPool);
  // Get request handler function
  const handler = (server as any).listeners("request")[0];

  it("should respond 200 with anti-CDN headers for /health", () => {
    const { req, res } = createMockHttp();
    req.url = "/health";

    handler(req, res);

    expect(res.getStatusCode()).toBe(200);
    expect(res.getHeaders()["Cache-Control"]).toContain("no-store");
    expect(res.getHeaders()["Pragma"]).toBe("no-cache");

    const data = JSON.parse(res.getBody());
    expect(data.status).toBe("healthy");
    expect(data.scraper.totalScrapes).toBe(42);
  });

  it("should correctly handle query parameters (UptimeRobot cache buster)", () => {
    const { req, res } = createMockHttp();
    req.url = `/health?t=${Date.now()}&source=uptimerobot`;

    handler(req, res);

    expect(res.getStatusCode()).toBe(200);
    const data = JSON.parse(res.getBody());
    expect(data.status).toBe("healthy");
  });

  it("should correctly handle trailing slashes (/health/ and /ping)", () => {
    const { req: req1, res: res1 } = createMockHttp();
    req1.url = "/health/";
    handler(req1, res1);
    expect(res1.getStatusCode()).toBe(200);

    const { req: req2, res: res2 } = createMockHttp();
    req2.url = "/ping";
    handler(req2, res2);
    expect(res2.getStatusCode()).toBe(200);
  });

  it("should support HEAD requests without payload", () => {
    const { req, res } = createMockHttp();
    req.method = "HEAD";
    req.url = "/health";

    handler(req, res);

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toBe("");
  });

  it("should respond 404 for unknown endpoints", () => {
    const { req, res } = createMockHttp();
    req.url = "/unknown-path";

    handler(req, res);

    expect(res.getStatusCode()).toBe(404);
    expect(res.getBody()).toBe("Not Found");
  });
});
