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

    if (pathname === "/health" || pathname === "/" || pathname === "/ping") {
      const telemetry = scraper.getTelemetry();
      const proxyStatus = proxyPool.getStatus();

      const isHealthy = telemetry.consecutiveFailures < 5;
      const statusCode = isHealthy ? 200 : 503;

      res.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
        "Connection": "close",
      });

      if (req.method === "HEAD") {
        res.end();
        return;
      }

      const payload = {
        status: telemetry.consecutiveFailures === 0 ? "healthy" : "degraded",
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
