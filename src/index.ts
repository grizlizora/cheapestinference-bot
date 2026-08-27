import { run } from "@grammyjs/runner";
import { config } from "./config/env.js";
import { getDatabase, closeDatabase } from "./db/index.js";
import { TorManager } from "./proxy/torManager.js";
import { ProxyPool } from "./proxy/proxyPool.js";
import { RobustHttpClient } from "./http/client.js";
import { JsonApiEngine } from "./scrapers/jsonApiEngine.js";
import { HtmlSnapshotEngine } from "./scrapers/htmlSnapshotEngine.js";
import { SanityGuard } from "./engine/sanityGuard.js";
import { SlotDiffEngine } from "./engine/diffEngine.js";
import { ScraperOrchestrator } from "./engine/scraperOrchestrator.js";
import { PoolStateDAO } from "./db/dao/poolState.js";
import { SlotHistoryDAO } from "./db/dao/slotHistory.js";
import { CatalogHistoryDAO } from "./db/dao/catalogHistory.js";
import { UserDAO } from "./db/dao/users.js";
import { SubscriptionDAO } from "./db/dao/subscriptions.js";
import { NotificationLogDAO } from "./db/dao/notificationLogs.js";
import { DatabaseMaintenanceManager } from "./db/maintenance.js";
import { createTelegramBot } from "./bot/index.js";
import { createHealthServer } from "./server/health.js";

process.on("unhandledRejection", (reason) => {
  console.error("⚠️ [Resilience] Unhandled Promise Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("❌ [Resilience] Uncaught Exception caught safely:", err);
});

async function bootstrap() {
  console.log("==================================================");
  console.log("🚀 Starting CheapestInference Telegram Monitor Bot");
  console.log("==================================================");

  // 1. Initialize SQLite Database, DAOs & Maintenance
  const db = getDatabase();
  const userDao = new UserDAO(db);
  const subDao = new SubscriptionDAO(db);
  const poolStateDao = new PoolStateDAO(db);
  const notificationLogDao = new NotificationLogDAO(db);
  const slotHistoryDao = new SlotHistoryDAO(db);
  const catalogHistoryDao = new CatalogHistoryDAO(db);

  const maintenanceManager = new DatabaseMaintenanceManager(db);
  maintenanceManager.startDailyMaintenance();
  console.log(`📦 [Database] SQLite connected & supercharged at: ${config.DB_PATH}`);

  // 2. Initialize Proxy / Tor Subsystem
  let torManager: TorManager | undefined;
  if (config.TOR_ENABLED) {
    torManager = new TorManager({
      socksHost: config.TOR_SOCKS_HOST,
      socksPort: config.TOR_SOCKS_PORT,
      controlHost: config.TOR_CONTROL_HOST,
      controlPort: config.TOR_CONTROL_PORT,
      controlPassword: config.TOR_CONTROL_PASSWORD,
    });
    const isTorReady = await torManager.isSocksReady();
    if (isTorReady) {
      console.log(`🧅 [Tor] Tor SOCKS5 proxy connected at ${config.TOR_SOCKS_HOST}:${config.TOR_SOCKS_PORT}`);
    } else {
      console.warn(`⚠️ [Tor] Tor SOCKS5 proxy not reachable on ${config.TOR_SOCKS_HOST}:${config.TOR_SOCKS_PORT}. Running with failover.`);
    }
  } else {
    console.log("⚡ [Proxy] Tor is disabled. Using proxy pool / direct connection mode.");
  }

  const proxyPool = new ProxyPool(
    torManager,
    config.ALLOW_DIRECT_FALLBACK,
    config.PROXY_LIST
  );

  // 3. Initialize HTTP Client & Scraping Engines
  const httpClient = new RobustHttpClient(proxyPool);
  const jsonApiEngine = new JsonApiEngine(httpClient);
  const htmlSnapshotEngine = new HtmlSnapshotEngine(httpClient);
  const sanityGuard = new SanityGuard();
  const diffEngine = new SlotDiffEngine(slotHistoryDao, catalogHistoryDao);
  const existingRecords = poolStateDao.getAll();
  if (existingRecords.length > 0) {
    diffEngine.bootstrapFromDao(existingRecords);
  }

  // 4. Initialize Scraper Orchestrator
  const scraper = new ScraperOrchestrator(
    jsonApiEngine,
    htmlSnapshotEngine,
    diffEngine,
    sanityGuard,
    poolStateDao,
    {
      minIntervalSec: config.SCRAPE_MIN_INTERVAL_SEC,
      maxIntervalSec: config.SCRAPE_MAX_INTERVAL_SEC,
      maxBackoffSec: config.SCRAPE_MAX_BACKOFF_SEC,
    }
  );

  scraper.on("heartbeat", (hb: any) => {
    const proxyTag = hb.usedProxy
      ? hb.usedProxy.includes("9050")
        ? "🧅 Tor SOCKS5"
        : `🌐 Proxy (${hb.usedProxy})`
      : "⚡ Direct (DNS Cache)";
    const modTag = hb.modified ? "🔥 MODIFIED" : "static";
    console.log(`💓 [Heartbeat] Scraped from '${hb.source}' via ${proxyTag} in ${hb.latencyMs}ms (${modTag})`);
  });

  scraper.on("warn", (msg) => {
    console.warn(`⚠️ [Scraper Warning] ${msg}`);
  });

  scraper.on("error", (err) => {
    console.error(`❌ [Scraper Error] ${err.message}`);
  });

  // 5. Initialize Telegram Bot & Notification Dispatcher (Hydrates InvertedIndex & Attaches diff_events listener)
  const { bot, dispatcher, liveDashboardManager } = createTelegramBot(
    config.BOT_TOKEN,
    userDao,
    subDao,
    poolStateDao,
    notificationLogDao,
    scraper,
    proxyPool,
    slotHistoryDao
  );
  const runner = run(bot);
  console.log("🤖 [Bot] Telegram bot is active and listening for updates.");

  // 6. Perform Initial Warmup Scrape & Socket Pre-warming
  if (torManager) {
    console.log("🧅 [Tor] Waiting for Tor consensus & circuit bootstrap...");
    await torManager.waitUntilBootstrapped(15_000).catch(() => {});
  }

  // Pre-warm HTTP socket connections
  await httpClient.warmUp(["https://cheapestinference.com/pools", "https://cheapestinference.com/api/pools"]).catch(() => {});

  console.log("🔍 [Warmup] Performing initial scrape to establish baseline catalog...");
  try {
    await scraper.poll();
  } catch (err: any) {
    console.warn(`⚠️ [Warmup] Initial scrape encountered error (${err.message}). Scraper loop will retry.`);
  }

  // 7. Start Scraper Periodic Loop (Now safely captured by dispatcher)
  scraper.start();

  // 8. Start Lightweight HTTP Health Check Server
  const healthServer = createHealthServer(config.PORT, scraper, proxyPool);

  // 9. Process Resilience & Graceful Shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n🛑 [Shutdown] Received ${signal}. Stopping services gracefully...`);

    const forceTimeout = setTimeout(() => {
      console.error("⚠️ [Shutdown] Graceful drain timed out. Forcing process exit.");
      process.exit(1);
    }, 5000);
    forceTimeout.unref();

    scraper.stop();
    if (runner.isRunning()) {
      await runner.stop();
    }
    await dispatcher.flushPending().catch(() => {});
    notificationLogDao.close();
    httpClient.destroy();
    healthServer.close();
    closeDatabase();
    console.log("👋 [Shutdown] All services stopped. Goodbye!");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

bootstrap().catch((err) => {
  console.error("💥 Fatal startup error:", err);
  process.exit(1);
});
