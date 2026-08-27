import http from "node:http";
import { ScraperOrchestrator } from "../engine/scraperOrchestrator.js";
import { ProxyPool } from "../proxy/proxyPool.js";

export function createHealthServer(
  port: number,
  scraper: ScraperOrchestrator,
  proxyPool: ProxyPool
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
        const telemetry = scraper.getTelemetry();
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
      pathname === "/" ||
      pathname === "/ping" ||
      pathname === "/live"
    ) {
      try {
        const telemetry = scraper.getTelemetry();
        const proxyStatus = proxyPool.getStatus();

        // Return HTTP 200 for process liveness to prevent destructive restart loops on Render / HF Spaces
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
