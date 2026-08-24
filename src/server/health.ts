import http from "node:http";
import { ScraperOrchestrator } from "../engine/scraperOrchestrator.js";
import { ProxyPool } from "../proxy/proxyPool.js";

export function createHealthServer(
  port: number,
  scraper: ScraperOrchestrator,
  proxyPool: ProxyPool
): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      const telemetry = scraper.getTelemetry();
      const proxyStatus = proxyPool.getStatus();

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

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload, null, 2));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`🌐 [HealthServer] Lightweight ping server listening on port ${port}`);
  });

  return server;
}
