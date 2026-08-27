import { InlineKeyboard } from "grammy";
import { BotContext } from "../../types/context.js";
import { UserDAO } from "../../db/dao/users.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { ScraperOrchestrator } from "../../engine/scraperOrchestrator.js";
import { ProxyPool } from "../../proxy/proxyPool.js";
import { config, isUserAdmin } from "../../config/env.js";
import { escapeHtml } from "../../i18n/index.js";

export function renderAdminText(
  ctx: BotContext,
  userDao: UserDAO,
  subDao: SubscriptionDAO,
  scraper: ScraperOrchestrator,
  proxyPool: ProxyPool
): string {
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
  const lastScrapeStr =
    lastScrapeAgo >= 0
      ? ctx.lang === "uk"
        ? `${lastScrapeAgo}с тому`
        : ctx.lang === "ru"
        ? `${lastScrapeAgo}с назад`
        : `${lastScrapeAgo}s ago`
      : "N/A";

  const memUsageMb = +(process.memoryUsage().rss / 1024 / 1024).toFixed(1);

  const hasTor = proxyStatus.proxies.some((p) => p.type === "tor");
  const proxyModeStr = hasTor
    ? `🧅 Tor Active (${proxyStatus.available}/${proxyStatus.total} alive)`
    : proxyStatus.total > 0
    ? `🌐 Proxies (${proxyStatus.available}/${proxyStatus.total} alive)`
    : "⚡ Direct Connection";

  const adminUser = ctx.from ? userDao.getByTelegramId(ctx.from.id) : undefined;
  const newUsersEnabled = (adminUser?.notify_admin_new_users ?? 1) === 1;

  return ctx.t("admin.stats_title", {
    status: scraperTelemetry.consecutiveFailures === 0 ? "HEALTHY 🟢" : "DEGRADED 🟡",
    uptime: uptimeStr,
    total_users: userStats.total,
    active_users: userStats.active,
    blocked_users: userStats.blocked,
    active_subscriptions: activeSubs,
    last_scrape_ago: lastScrapeStr,
    latency: scraperTelemetry.lastScrapeLatencyMs,
    source: escapeHtml(scraperTelemetry.lastSource || "N/A"),
    consecutive_failures: scraperTelemetry.consecutiveFailures,
    proxy_status: proxyModeStr,
    memory_mb: memUsageMb,
    new_users_status: newUsersEnabled ? ctx.t("subscriptions.filter_on") : ctx.t("subscriptions.filter_off"),
  });
}

export function createAdminKeyboard(ctx: BotContext, userDao: UserDAO): InlineKeyboard {
  const adminUser = ctx.from ? userDao.getByTelegramId(ctx.from.id) : undefined;
  const newUsersEnabled = (adminUser?.notify_admin_new_users ?? 1) === 1;

  return new InlineKeyboard()
    .text(
      newUsersEnabled
        ? ctx.t("admin.btn_toggle_new_users_on")
        : ctx.t("admin.btn_toggle_new_users_off"),
      "admin_toggle_new_users"
    )
    .row()
    .text(ctx.t("admin.btn_backup"), "admin_backup")
    .row()
    .text(ctx.t("admin.btn_test_alert"), "admin_test_alert")
    .row()
    .text(ctx.t("common.refresh"), "admin_refresh");
}

export function createAdminHandler(
  userDao: UserDAO,
  subDao: SubscriptionDAO,
  scraper: ScraperOrchestrator,
  proxyPool: ProxyPool
) {
  return async (ctx: BotContext) => {
    if (!ctx.from) return;

    if (!isUserAdmin(ctx.from.id)) {
      await ctx.reply(ctx.t("admin.unauthorized"));
      return;
    }

    const text = renderAdminText(ctx, userDao, subDao, scraper, proxyPool);
    const keyboard = createAdminKeyboard(ctx, userDao);

    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  };
}
