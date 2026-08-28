/**
 * src/server/health.ts
 * High-Availability Health Check, Prometheus Metrics & Render Always-On Keep-Alive Server
 */

import http from "node:http";
import { ScraperOrchestrator } from "../engine/scraperOrchestrator.js";
import { ProxyPool } from "../proxy/proxyPool.js";

export function createHealthServer(
  port: number,
  scraper?: ScraperOrchestrator,
  proxyPool?: ProxyPool
): http.Server {
  const server = http.createServer((req, res) => {
    const rawUrl = req.url || "/";
    const pathname = rawUrl.split("?")[0].replace(/\/+$/, "") || "/";

    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
      res.writeHead(405, {
        "Content-Type": "text/plain",
        "Allow": "GET, HEAD, OPTIONS",
      });
      res.end("Method Not Allowed");
      return;
    }

    // Handle CORS Preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (pathname === "/metrics") {
      try {
        const telemetry = scraper ? scraper.getTelemetry() : { totalScrapes: 0, lastScrapeLatencyMs: 0, consecutiveFailures: 0 };
        const mem = process.memoryUsage();
        const metrics = [
          "# HELP bot_uptime_seconds Bot process uptime in seconds",
          "# TYPE bot_uptime_seconds gauge",
          `bot_uptime_seconds ${Math.floor(process.uptime())}`,
          "# HELP bot_memory_heap_used_bytes V8 Heap memory used in bytes",
          "# TYPE bot_memory_heap_used_bytes gauge",
          `bot_memory_heap_used_bytes ${mem.heapUsed}`,
          "# HELP bot_memory_rss_bytes Process RSS memory in bytes",
          "# TYPE bot_memory_rss_bytes gauge",
          `bot_memory_rss_bytes ${mem.rss}`,
          "# HELP scraper_scrapes_total Total number of scrape cycles performed",
          "# TYPE scraper_scrapes_total counter",
          `scraper_scrapes_total ${telemetry.totalScrapes}`,
          "# HELP scraper_last_latency_ms Latency of the last scrape in milliseconds",
          "# TYPE scraper_last_latency_ms gauge",
          `scraper_last_latency_ms ${telemetry.lastScrapeLatencyMs}`,
          "# HELP scraper_consecutive_failures Consecutive scrape failure count",
          "# TYPE scraper_consecutive_failures gauge",
          `scraper_consecutive_failures ${telemetry.consecutiveFailures}`,
        ].join("\n") + "\n";

        res.writeHead(200, {
          "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate",
        });
        res.end(metrics);
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Error collecting metrics: ${err.message}`);
      }
      return;
    }

    if (
      pathname === "/health" ||
      pathname === "/healthz" ||
      pathname === "/" ||
      pathname === "/ping" ||
      pathname === "/live" ||
      pathname === "/status" ||
      pathname === "/ready" ||
      pathname === "/readyz" ||
      pathname === "/api/health"
    ) {
      try {
        const telemetry = scraper
          ? scraper.getTelemetry()
          : { lastScrapeTimestamp: 0, lastScrapeLatencyMs: 0, lastSource: "init", consecutiveFailures: 0, totalScrapes: 0 };
        const proxyStatus = proxyPool ? proxyPool.getStatus() : { activeMode: "direct", directOk: true };

        const isDegraded = telemetry.consecutiveFailures > 0;
        const statusCode = 200;

        res.writeHead(statusCode, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
          "Surrogate-Control": "no-store",
          "CDN-Cache-Control": "no-store",
          "Cloudflare-CDN-Cache-Control": "no-store",
          "Pragma": "no-cache",
          "Expires": "0",
          "Connection": "close",
          "Access-Control-Allow-Origin": "*",
        });

        if (req.method === "HEAD") {
          res.end();
          return;
        }

        const payload = {
          status: isDegraded ? "degraded" : "healthy",
          uptimeSeconds: Math.floor(process.uptime()),
          timestamp: new Date().toISOString(),
          memoryUsageMb: {
            rss: +(process.memoryUsage().rss / 1024 / 1024).toFixed(1),
            heapUsed: +(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1),
          },
          scraper: {
            lastScrapeTimestamp: telemetry.lastScrapeTimestamp,
            lastLatencyMs: telemetry.lastScrapeLatencyMs,
            lastSource: telemetry.lastSource,
            consecutiveFailures: telemetry.consecutiveFailures,
            totalScrapes: telemetry.totalScrapes,
          },
          proxy: proxyStatus,
        };

        res.end(JSON.stringify(payload, null, 2));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", error: err.message }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`🌐 [HealthServer] Ping server listening on 0.0.0.0:${port}`);
  });

  return server;
}

/**
 * Autonomous Internal Keep-Alive Self-Ping Timer
 * Periodically pings the bot's own public HTTP endpoint to guarantee Render / container stay awake 24/7.
 */
export function startKeepAliveSelfPing(healthPort: number): NodeJS.Timeout | undefined {
  const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL;
  if (!externalUrl && process.env.NODE_ENV !== "production") return undefined;

  const targetUrl = externalUrl
    ? `${externalUrl.replace(/\/+$/, "")}/ping`
    : `http://127.0.0.1:${healthPort}/ping`;

  console.log(`🛡️ [KeepAlive] Redundant self-ping initialized targeting: ${targetUrl}`);

  // Ping every 9 minutes (well below Render's 15m idle sleep threshold)
  const timer = setInterval(async () => {
    try {
      const res = await fetch(targetUrl, {
        method: "HEAD",
        headers: {
          "User-Agent": "CheapestInference-Internal-KeepAlive/1.0",
          "Cache-Control": "no-cache",
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        console.log(`💓 [KeepAlive] Internal keep-alive ping succeeded (${res.status})`);
      }
    } catch (err: any) {
      console.warn(`⚠️ [KeepAlive] Internal keep-alive probe warning: ${err.message}`);
    }
  }, 9 * 60 * 1000);

  timer.unref();
  return timer;
}
