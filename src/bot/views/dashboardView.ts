import { BotContext } from "../../types/context.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { ScraperOrchestrator } from "../../engine/scraperOrchestrator.js";
import { escapeHtml, formatRelativeTime, stripLeadingEmoji } from "../../i18n/index.js";
import { clampMessageText, formatMonitoringFooter } from "./common.js";
import { icon, getRawUnicode, IconKey } from "./iconTheme.js";

export interface PoolBadgeInfo {
  icon: string;
  iconHtml: string;
  shortStatus: string;
  statusBadgeKey: string;
  iconKey: IconKey;
}

export function computePoolBadgeInfo(availableCount: number, totalBlocks: number): PoolBadgeInfo {
  const total = totalBlocks || 3;
  let iconKey: IconKey = "status_sold_out";
  let statusBadgeKey = "common.status_sold_out";

  if (availableCount >= total && total > 0) {
    iconKey = "status_available";
    statusBadgeKey = "common.status_available";
  } else if (availableCount > 0) {
    iconKey = "status_partially_available";
    statusBadgeKey = "common.status_partially_available";
  }

  return {
    icon: getRawUnicode(iconKey),
    iconHtml: icon(iconKey),
    shortStatus: `${availableCount}/${total}`,
    statusBadgeKey,
    iconKey,
  };
}

export function renderDashboardText(
  ctx: BotContext,
  poolStateDao: PoolStateDAO,
  historyDao?: SlotHistoryDAO,
  scraper?: ScraperOrchestrator,
  lastUserInteractionAt?: number
): string {
  const summaries = poolStateDao.getPoolSummaries();
  const telemetry = scraper?.getTelemetry();
  const lastVerified = poolStateDao.getLastVerified();
  const lastVerifiedTs = telemetry?.lastScrapeTimestamp || lastVerified?.timestamp;

  const updatedAtStr = formatMonitoringFooter(
    lastVerifiedTs,
    ctx.lang,
    lastUserInteractionAt,
    telemetry?.consecutiveFailures || 0
  );

  if (summaries.length === 0) {
    return ctx.t("menu.dashboard_title", {
      pool_summaries: ctx.t("menu.loading_data"),
      updated_at: updatedAtStr,
    });
  }

  const poolSummariesText = summaries
    .map((p) => {
      const badgeInfo = computePoolBadgeInfo(p.available_count, p.total_blocks);
      const textKey = `${badgeInfo.statusBadgeKey}_text`;
      const directText = ctx.t(textKey);
      const rawStatusText = (directText && directText !== textKey)
        ? directText
        : stripLeadingEmoji(ctx.t(badgeInfo.statusBadgeKey));
      const statusBadge = `${badgeInfo.iconHtml} ${rawStatusText}`;
      const rawModels = (p.models || []).slice(0, 10).join(", ");
      const modelsText = escapeHtml(rawModels) || ctx.t("common.custom_models");

      let poolIcon = icon("pool_generic");
      if (p.slug.includes("flagship")) poolIcon = icon("pool_flagship");
      else if (p.slug.includes("core")) poolIcon = icon("pool_core");
      else if (p.slug.includes("frontier")) poolIcon = icon("pool_frontier");

      const statusLabel = ctx.lang === "uk" ? "Статус" : ctx.lang === "ru" ? "Статус" : "Status";
      const blocksFreeText = ctx.lang === "uk" ? "блоків вільно" : ctx.lang === "ru" ? "блоков свободно" : "blocks free";
      const modelsLabel = ctx.lang === "uk" ? "Моделі" : ctx.lang === "ru" ? "Модели" : "Models";
      const basePriceLabel = ctx.lang === "uk" ? "Базовий тариф: від" : ctx.lang === "ru" ? "Базовый тариф: от" : "Base price: from";
      const urlText = ctx.lang === "uk" ? "Сторінка тарифу на сайті" : ctx.lang === "ru" ? "Страница тарифа на сайте" : "Plan page on website";

      return `${poolIcon} <b>${escapeHtml(p.name)}</b>\n` +
        `• ${statusLabel}: ${statusBadge} <i>(${p.available_count}/${p.total_blocks || 3} ${blocksFreeText})</i>\n` +
        `• ${modelsLabel}: <code>${modelsText}</code>\n` +
        `• ${basePriceLabel} <b>$${p.min_price}/міс</b>\n` +
        `${icon("nav_link")} <a href="https://cheapestinference.com/pools/${p.slug}">${urlText}</a>`;
    })
    .join("\n\n");

  const dashboardHeader = ctx.lang === "uk"
    ? "<b>CheapestInference — Моніторинг слотів</b>\n\nАктуальний стан тарифів та регіональних блоків:"
    : ctx.lang === "ru"
    ? "<b>CheapestInference — Мониторинг слотов</b>\n\nАктуальное состояние тарифов и региональных блоков:"
    : "<b>CheapestInference — Slot Monitoring</b>\n\nActual status of compute pools and regional blocks:";
  const updatedLabel = ctx.lang === "uk" ? "Останнє оновлення" : ctx.lang === "ru" ? "Последнее обновление" : "Last updated";

  const rendered = `${icon("nav_chart")} ${dashboardHeader}\n\n` +
    `${poolSummariesText}\n\n` +
    `${icon("nav_clock")} <i>${updatedLabel}: ${updatedAtStr}</i>`;

  return clampMessageText(rendered);
}

export function renderSettingsText(ctx: BotContext): string {
  const flagUk = `<tg-emoji emoji-id="5447309366568953338">🇺🇦</tg-emoji>`;
  const flagEn = `<tg-emoji emoji-id="5202196682497859879">🇬🇧</tg-emoji>`;
  const flagRu = `<tg-emoji emoji-id="5449408995691341691">🇷🇺</tg-emoji>`;

  const langNames: Record<string, string> = {
    uk: `Українська ${flagUk}`,
    en: `English ${flagEn}`,
    ru: `Русский ${flagRu}`,
  };
  const currentLang = langNames[ctx.lang] || ctx.lang;

  const headerTitle = ctx.lang === "uk"
    ? "<b>Налаштування бота</b>\n\nКеруйте мовою інтерфейсу, переглядайте довідку та контакти."
    : ctx.lang === "ru"
    ? "<b>Настройки бота</b>\n\nУправляйте языком интерфейса, просматривайте справку и контакты."
    : "<b>Bot Settings</b>\n\nManage interface language, view help guides, and contacts.";

  const langLabel = ctx.lang === "uk" ? "Поточна мова" : ctx.lang === "ru" ? "Текущий язык" : "Current language";
  const idLabel = ctx.lang === "uk" ? "Ваш Telegram ID" : ctx.lang === "ru" ? "Ваш Telegram ID" : "Your Telegram ID";

  const rendered = `${icon("nav_settings")} ${headerTitle}\n\n` +
    `${icon("nav_language")} ${langLabel}: <b>${currentLang}</b>\n` +
    `🆔 ${idLabel}: <code>${ctx.from?.id || "N/A"}</code>`;

  return clampMessageText(rendered);
}
