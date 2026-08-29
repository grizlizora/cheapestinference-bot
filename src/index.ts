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
import { ActiveDashboardDAO } from "./db/dao/activeDashboards.js";
import { DatabaseMaintenanceManager } from "./db/maintenance.js";
import { tursoCloudSync } from "./db/tursoSync.js";
import { createTelegramBot } from "./bot/index.js";
import { createHealthServer, startKeepAliveSelfPing } from "./server/health.js";

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
  if (tursoCloudSync.isEnabled()) {
    console.log(`☁️ [TursoSync] Cloud Sync is active: ${tursoCloudSync.getUrl()}`);
    await tursoCloudSync.initRemoteSchema();
    await tursoCloudSync.pullStateFromTurso(db);
  } else {
    console.log(`ℹ️ [TursoSync] Turso Cloud Sync is inactive (TURSO_AUTH_TOKEN is not configured). Operating on local SQLite SSD.`);
  }
  const userDao = new UserDAO(db);
  userDao.syncAdminsFromConfig(config.ADMIN_USER_IDS, config.ADMIN_USERNAMES);
  const subDao = new SubscriptionDAO(db);
  const poolStateDao = new PoolStateDAO(db);
  const notificationLogDao = new NotificationLogDAO(db);
  const slotHistoryDao = new SlotHistoryDAO(db);
  const catalogHistoryDao = new CatalogHistoryDAO(db);
  const activeDashboardDao = new ActiveDashboardDAO(db);

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
  } else {
    console.log("⚡ [Proxy] Tor is disabled. Using proxy pool / direct connection mode.");
  }

  const proxyPool = new ProxyPool(
    torManager,
    config.ALLOW_DIRECT_FALLBACK,
    config.PROXY_LIST,
    config.CF_WORKER_URL
  );

  // 3. Initialize HTTP Client & Scraping Engines
  const httpClient = new RobustHttpClient(proxyPool, config.CF_WORKER_SECRET);
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
      ? hb.usedProxy.startsWith("worker:")
        ? `🏎️ CF Worker`
        : hb.usedProxy.includes("9050")
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

  // 5. Start Fast-Path Health Server Early (Eliminates 503 during cold boots & container restarts)
  const healthServer = createHealthServer(config.PORT, scraper, proxyPool);
  startKeepAliveSelfPing(config.PORT);

  // 6. Initialize Telegram Bot & Persistent Dashboard Manager
  const { bot, dispatcher, liveDashboardManager } = createTelegramBot(
    config.BOT_TOKEN,
    userDao,
    subDao,
    poolStateDao,
    notificationLogDao,
    scraper,
    proxyPool,
    slotHistoryDao,
    activeDashboardDao
  );
  const runner = run(bot);
  console.log("🤖 [Bot] Telegram bot is active and listening for updates.");

  // 7. Perform Tor Verification & Initial Warmup Scrape
  if (torManager) {
    console.log("🧅 [Tor] Waiting for Tor consensus & circuit bootstrap...");
    await torManager.waitUntilBootstrapped(15_000).catch(() => {});
    const isTorReady = await torManager.isSocksReady();
    if (isTorReady) {
      console.log(`🧅 [Tor] Tor SOCKS5 proxy connected at ${config.TOR_SOCKS_HOST}:${config.TOR_SOCKS_PORT}`);
    } else {
      console.warn(`⚠️ [Tor] Tor SOCKS5 proxy standby. Running with direct/worker failover.`);
    }
  }

  // Pre-warm HTTP socket connections for both JSON API and HTML origins
  await httpClient.warmUp([
    "https://api.cheapestinference.com/api/pools",
    "https://cheapestinference.com/pools",
  ]).catch(() => {});

  console.log("🔍 [Warmup] Performing initial scrape to establish baseline catalog...");
  try {
    await scraper.poll();
  } catch (err: any) {
    console.warn(`⚠️ [Warmup] Initial scrape encountered error (${err.message}). Scraper loop will retry.`);
  }

  // Immediately refresh any restored live dashboards with fresh startup data
  liveDashboardManager.handleDataChanged();

  // 8. Start Scraper Periodic Loop
  scraper.start();

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
    await tursoCloudSync.close().catch(() => {});
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
