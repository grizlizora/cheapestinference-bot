import { BotContext } from "../../types/context.js";
import { UserDAO } from "../../db/dao/users.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { ScraperOrchestrator } from "../../engine/scraperOrchestrator.js";
import { ProxyPool } from "../../proxy/proxyPool.js";
import { config } from "../../config/env.js";

export function createAdminHandler(
  userDao: UserDAO,
  subDao: SubscriptionDAO,
  scraper: ScraperOrchestrator,
  proxyPool: ProxyPool
) {
  return async (ctx: BotContext) => {
    if (!ctx.from) return;

    // Check if user is in admin list (or if admin list is empty, allow all in dev)
    const isAdmin =
      config.ADMIN_USER_IDS.length === 0 ||
      config.ADMIN_USER_IDS.includes(ctx.from.id);

    if (!isAdmin) {
      await ctx.reply(ctx.t("admin.unauthorized"));
      return;
    }

    const userStats = userDao.getUserStats();
    const activeSubs = subDao.getTotalActiveSubscriptions();
    const scraperTelemetry = scraper.getTelemetry();
    const proxyStatus = proxyPool.getStatus();

    const uptimeSec = Math.floor(process.uptime());
    const hours = Math.floor(uptimeSec / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    const seconds = uptimeSec % 60;
    const uptimeStr = `${hours}h ${minutes}m ${seconds}s`;

    const lastScrapeAgo =
      scraperTelemetry.lastScrapeTimestamp > 0
        ? Math.round((Date.now() - scraperTelemetry.lastScrapeTimestamp) / 1000)
        : -1;

    const memUsageMb = +(process.memoryUsage().rss / 1024 / 1024).toFixed(1);

    const hasTor = proxyStatus.proxies.some((p) => p.type === "tor");
    const proxyModeStr = hasTor
      ? `🧅 Tor Active (${proxyStatus.available}/${proxyStatus.total} alive)`
      : proxyStatus.total > 0
      ? `🌐 Proxies (${proxyStatus.available}/${proxyStatus.total} alive)`
      : "⚡ Direct Connection";

    const text = ctx.t("admin.stats_title", {
      status: scraperTelemetry.consecutiveFailures === 0 ? "HEALTHY 🟢" : "DEGRADED 🟡",
      uptime: uptimeStr,
      total_users: userStats.total,
      active_users: userStats.active,
      blocked_users: userStats.blocked,
      active_subscriptions: activeSubs,
      last_scrape_ago: lastScrapeAgo >= 0 ? lastScrapeAgo : "N/A",
      latency: scraperTelemetry.lastScrapeLatencyMs,
      source: scraperTelemetry.lastSource,
      consecutive_failures: scraperTelemetry.consecutiveFailures,
      proxy_status: proxyModeStr,
      memory_mb: memUsageMb,
    });

    await ctx.reply(text, { parse_mode: "HTML" });
  };
}
