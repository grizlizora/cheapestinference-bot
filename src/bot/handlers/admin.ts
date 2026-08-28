import crypto from "node:crypto";
import { InlineKeyboard } from "grammy";
import { BotContext } from "../../types/context.js";
import { UserDAO } from "../../db/dao/users.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { ScraperOrchestrator } from "../../engine/scraperOrchestrator.js";
import { ProxyPool } from "../../proxy/proxyPool.js";
import { config, isUserAdmin } from "../../config/env.js";
import { escapeHtml } from "../../i18n/index.js";
import { icon } from "../views/iconTheme.js";

interface FailedClaimRecord {
  count: number;
  lockedUntil: number;
  lastAttemptAt: number;
}

const failedClaimAttempts = new Map<number, FailedClaimRecord>();

function cleanExpiredLockouts(now: number): void {
  if (failedClaimAttempts.size > 20) {
    for (const [id, rec] of failedClaimAttempts.entries()) {
      if (
        (rec.lockedUntil > 0 && now > rec.lockedUntil) ||
        (rec.lockedUntil === 0 && now - (rec.lastAttemptAt || 0) > 15 * 60 * 1000)
      ) {
        failedClaimAttempts.delete(id);
      }
    }
  }
}

function isTimingSafeSha256Match(input: string, target: string): boolean {
  if (!input || !target) return false;
  const hashA = crypto.createHash("sha256").update(input.trim()).digest();
  const hashB = crypto.createHash("sha256").update(target.trim()).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

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
    ? `${icon("nav_language")} Tor Active (${proxyStatus.available}/${proxyStatus.total} alive)`
    : proxyStatus.total > 0
    ? `${icon("nav_language")} Proxies (${proxyStatus.available}/${proxyStatus.total} alive)`
    : `${icon("pool_frontier")} Direct Fast-Path`;

  const adminUser = ctx.from ? userDao.getByTelegramId(ctx.from.id) : undefined;
  const newUsersEnabled = (adminUser?.notify_admin_new_users ?? 1) === 1;

  const usersIcon = `<tg-emoji emoji-id="5372926953978341366">👥</tg-emoji>`;
  const spiderIcon = `<tg-emoji emoji-id="5445149053853637789">🕷</tg-emoji>`;
  const brainRamIcon = icon("pool_core");
  const onText = ctx.lang === "uk" ? `УВІМКНЕНО ${icon("toggle_on")}` : ctx.lang === "ru" ? `ВКЛЮЧЕНО ${icon("toggle_on")}` : `ENABLED ${icon("toggle_on")}`;
  const offText = ctx.lang === "uk" ? `ВИМКНЕНО ${icon("toggle_off")}` : ctx.lang === "ru" ? `ВЫКЛЮЧЕНО ${icon("toggle_off")}` : `DISABLED ${icon("toggle_off")}`;

  const statusOrb = scraperTelemetry.consecutiveFailures === 0 ? icon("status_available") : icon("status_partially_available");
  const statusLabel = scraperTelemetry.consecutiveFailures === 0 ? "HEALTHY" : "DEGRADED";

  const adminHeader = ctx.lang === "uk"
    ? "<b>Панель адміністратора & Телеметрія</b>"
    : ctx.lang === "ru"
    ? "<b>Панель администратора & Телеметрия</b>"
    : "<b>Admin Panel & Telemetry</b>";

  const statusTitle = ctx.lang === "uk" ? "Статус системи" : ctx.lang === "ru" ? "Статус системы" : "System Status";
  const uptimeTitle = ctx.lang === "uk" ? "Аптайм" : ctx.lang === "ru" ? "Аптайм" : "Uptime";
  const usersTitle = ctx.lang === "uk" ? "Користувачі" : ctx.lang === "ru" ? "Пользователи" : "Users";
  const totalLabel = ctx.lang === "uk" ? "Всього зареєстровано" : ctx.lang === "ru" ? "Всего зарегистрировано" : "Total registered";
  const activeLabel = ctx.lang === "uk" ? "Активних спостерігачів" : ctx.lang === "ru" ? "Активных наблюдателей" : "Active observers";
  const blockedLabel = ctx.lang === "uk" ? "Заблокували бота" : ctx.lang === "ru" ? "Заблокировали бота" : "Blocked bot";
  const subsLabel = ctx.lang === "uk" ? "Активних правил підписок" : ctx.lang === "ru" ? "Активных правил подписок" : "Active subscription rules";
  const scraperTitle = ctx.lang === "uk" ? "Скрейпер & Anti-Ban" : ctx.lang === "ru" ? "Скрейпер & Anti-Ban" : "Scraper & Anti-Ban";
  const pollLabel = ctx.lang === "uk" ? "Останнє опитування" : ctx.lang === "ru" ? "Последний опрос" : "Last poll";
  const latencyLabel = ctx.lang === "uk" ? "Затримка" : ctx.lang === "ru" ? "Задержка" : "Latency";
  const sourceLabel = ctx.lang === "uk" ? "Джерело даних" : ctx.lang === "ru" ? "Источник данных" : "Data source";
  const errorsLabel = ctx.lang === "uk" ? "Помилок поспіль" : ctx.lang === "ru" ? "Ошибок подряд" : "Consecutive errors";
  const proxyLabel = ctx.lang === "uk" ? "Режим Tor / Проксі" : ctx.lang === "ru" ? "Режим Tor / Прокси" : "Tor / Proxy Mode";
  const memoryLabel = ctx.lang === "uk" ? "Пам'ять процесу" : ctx.lang === "ru" ? "Память процесса" : "Process memory";
  const newUsersLabel = ctx.lang === "uk" ? "Сповіщення про нових користувачів" : ctx.lang === "ru" ? "Уведомления о новых пользователях" : "New user alerts";

  return `${icon("nav_chart")} ${adminHeader}\n\n` +
    `${statusOrb} <b>${statusTitle}:</b> ${statusLabel} ${statusOrb}\n` +
    `${icon("nav_clock")} <b>${uptimeTitle}:</b> ${uptimeStr}\n\n` +
    `${usersIcon} <b>${usersTitle}:</b>\n` +
    `• ${totalLabel}: <b>${userStats.total}</b>\n` +
    `• ${activeLabel}: <b>${userStats.active}</b>\n` +
    `• ${blockedLabel}: <b>${userStats.blocked}</b>\n` +
    `• ${subsLabel}: <b>${activeSubs}</b>\n\n` +
    `${spiderIcon} <b>${scraperTitle}:</b>\n` +
    `• ${pollLabel}: <b>${lastScrapeStr}</b> (${latencyLabel}: ${scraperTelemetry.lastScrapeLatencyMs}мс)\n` +
    `• ${sourceLabel}: <code>${escapeHtml(scraperTelemetry.lastSource || "N/A")}</code>\n` +
    `• ${errorsLabel}: <b>${scraperTelemetry.consecutiveFailures}</b>\n` +
    `• ${proxyLabel}: <b>${proxyModeStr}</b>\n\n` +
    `${brainRamIcon} <b>${memoryLabel}:</b> <b>${memUsageMb} MB</b>\n` +
    `${icon("notify_bell_on")} <b>${newUsersLabel}:</b> ${newUsersEnabled ? onText : offText}`;
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
    .text(ctx.t("admin.btn_export_users"), "admin_export_users")
    .row()
    .text(ctx.t("admin.btn_export_history"), "admin_export_history")
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

    // Check if user is attempting to claim admin via secret (/admin <SECRET>)
    const match = (ctx as any).match;
    if (typeof match === "string" && match.trim().length > 0) {
      const secretAttempt = match.trim();
      const tgId = ctx.from.id;
      const now = Date.now();
      cleanExpiredLockouts(now);
      const attemptRecord = failedClaimAttempts.get(tgId) || { count: 0, lockedUntil: 0, lastAttemptAt: now };
      attemptRecord.lastAttemptAt = now;

      if (now < attemptRecord.lockedUntil) {
        await ctx.reply("⛔ Too many failed attempts. Please try again in 15 minutes.", { parse_mode: "HTML" });
        return;
      }

      const matchesBotToken = isTimingSafeSha256Match(secretAttempt, config.BOT_TOKEN);
      const matchesAdminSecret = config.ADMIN_SECRET
        ? isTimingSafeSha256Match(secretAttempt, config.ADMIN_SECRET)
        : false;

      if (matchesBotToken || matchesAdminSecret) {
        userDao.setAdmin(tgId, true);
        failedClaimAttempts.delete(tgId);
        await ctx.reply(ctx.t("admin.claim_success"), { parse_mode: "HTML" });
      } else {
        attemptRecord.count += 1;
        if (attemptRecord.count >= 3) {
          attemptRecord.lockedUntil = now + 15 * 60 * 1000;
        }
        failedClaimAttempts.set(tgId, attemptRecord);
      }
    }

    if (!isUserAdmin(ctx.from.id, userDao, ctx.from.username)) {
      await ctx.reply(ctx.t("admin.unauthorized", { telegram_id: String(ctx.from.id) }), {
        parse_mode: "HTML",
      });
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
