/**
 * src/bot/views/poolDetailView.ts
 * Pure Pool Detail Presentation & Intelligence Formatters
 */

import { BotContext } from "../../types/context.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { AvailabilityIntelligenceEngine } from "../../engine/intelligenceEngine.js";
import { ScraperOrchestrator } from "../../engine/scraperOrchestrator.js";
import { escapeHtml, formatRelativeTime, stripLeadingEmoji } from "../../i18n/index.js";
import { clampMessageText, formatMonitoringFooter } from "./common.js";

import { icon, getRegionalGlobeIcon } from "./iconTheme.js";
import { formatBlockHoursWithLocal, getShiftPersonification } from "./timezoneHelper.js";
import { POOL_RANKS } from "./poolRanks.js";
import { renderCapacityBar } from "./capacityBar.js";

export const DEFAULT_BLOCK_IDS = ["asia", "europe", "americas"];
export const DEFAULT_BLOCK_HOURS: Record<string, string> = {
  asia: "00:00 – 08:00 UTC",
  europe: "08:00 – 16:00 UTC",
  americas: "16:00 – 24:00 UTC",
};

export function getBlockIcon(blockId: string): string {
  return getRegionalGlobeIcon(blockId);
}

export function renderPoolSettingsText(
  ctx: BotContext,
  poolStateDao: PoolStateDAO,
  subDao: SubscriptionDAO
): string {
  const slug = ctx.session?.tempPoolSlug || "flagship";
  const flags = subDao.getPoolFlags(ctx.user.id, slug);
  const blocks = poolStateDao.getPoolBlocks(slug);
  const poolName = blocks[0]?.pool_name || slug.toUpperCase();

  const onText = ctx.lang === "uk" ? `УВІМКНЕНО ${icon("toggle_on")}` : ctx.lang === "ru" ? `ВКЛЮЧЕНО ${icon("toggle_on")}` : `ENABLED ${icon("toggle_on")}`;
  const offText = ctx.lang === "uk" ? `ВИМКНЕНО ${icon("toggle_off")}` : ctx.lang === "ru" ? `ВЫКЛЮЧЕНО ${icon("toggle_off")}` : `DISABLED ${icon("toggle_off")}`;

  const headerTitle = ctx.lang === "uk"
    ? `<b>Фільтри сповіщень • ${escapeHtml(poolName)}</b>\n\nНалаштуйте, які саме події ви хочете отримувати для тарифу <b>${escapeHtml(poolName)}</b>:`
    : ctx.lang === "ru"
    ? `<b>Фильтры уведомлений • ${escapeHtml(poolName)}</b>\n\nНастройте, какие именно события вы хотите получать для тарифа <b>${escapeHtml(poolName)}</b>:`
    : `<b>Notification Filters • ${escapeHtml(poolName)}</b>\n\nConfigure which events you want to receive for <b>${escapeHtml(poolName)}</b>:`;

  const dropsLabel = ctx.lang === "uk" ? "Вільні слоти (Drops)" : ctx.lang === "ru" ? "Свободные слоты (Drops)" : "Available Slots (Drops)";
  const soldLabel = ctx.lang === "uk" ? "Розпродано (Sold Out)" : ctx.lang === "ru" ? "Распродано (Sold Out)" : "Sold Out";
  const modelsLabel = ctx.lang === "uk" ? "Оновлення моделей" : ctx.lang === "ru" ? "Обновления моделей" : "Model Updates";
  const pricesLabel = ctx.lang === "uk" ? "Зміна цін та знижок" : ctx.lang === "ru" ? "Изменение цен и скидок" : "Price & Discount Changes";
  const subStatusLabel = ctx.lang === "uk" ? "Статус підписки на пул" : ctx.lang === "ru" ? "Статус подписки на пул" : "Pool Subscription Status";

  let poolIcon = icon("pool_generic");
  if (slug.includes("flagship")) poolIcon = icon("pool_flagship");
  else if (slug.includes("core")) poolIcon = icon("pool_core");
  else if (slug.includes("frontier")) poolIcon = icon("pool_frontier");

  const poolStatus = flags.isSubscribed ? onText : offText;

  return `${icon("nav_settings")} ${headerTitle}\n\n` +
    `• ${icon("event_slot_drop")} ${dropsLabel}: ${flags.available ? onText : offText}\n` +
    `• ${icon("event_slot_sold")} ${soldLabel}: ${flags.soldOut ? onText : offText}\n` +
    `• ${icon("event_batch_drop")} ${modelsLabel}: ${flags.models ? onText : offText}\n` +
    `• ${icon("price_tag")} ${pricesLabel}: ${flags.prices ? onText : offText}\n\n` +
    `${icon("pool_generic")} <b>${subStatusLabel}:</b> ${poolStatus}`;
}

export function renderPoolDetailText(
  ctx: BotContext,
  poolStateDao: PoolStateDAO,
  historyDao?: SlotHistoryDAO,
  scraper?: ScraperOrchestrator,
  lastUserInteractionAt?: number
): string {
  const slug = ctx.session?.tempPoolSlug || "flagship";
  const blocks = poolStateDao.getPoolBlocks(slug);

  if (blocks.length === 0) {
    return ctx.t("pool_detail.no_data", { pool: slug.toUpperCase() });
  }

  const first = blocks[0];
  let models: string[] = [];
  try {
    models = JSON.parse(first.models_json);
  } catch {
    models = [];
  }

  // Defend against Telegram message length blowout (truncate to top 15 models)
  const maxModels = 15;
  const displayedModels = models.slice(0, maxModels);
  let modelsList = displayedModels
    .map((m) => ctx.t("pool_detail.model_item", { model_name: escapeHtml(m) }))
    .join("\n");
  if (models.length > maxModels) {
    modelsList += `\n  • <i>... +${models.length - maxModels} more</i>`;
  }

  const intelligenceEngine = historyDao ? new AvailabilityIntelligenceEngine(historyDao) : null;

  const blocksList = blocks
    .map((b) => {
      const shiftHeader = getShiftPersonification(b.block_id, ctx.lang);
      const hoursLocal = formatBlockHoursWithLocal(b.block_id, b.hours_utc, ctx.lang);
      const smart = intelligenceEngine
        ? intelligenceEngine.getSmartStatus(slug, b.block_id, b.status, ctx.lang)
        : null;

      const isAvailable = b.status === "available" || b.status === "limited";
      const statusIcon = isAvailable ? icon("status_available") : icon("status_sold_out");
      const textKey = isAvailable ? "common.status_available_text" : "common.status_sold_out_text";
      const directText = ctx.t(textKey);
      const rawStatusText = (directText && directText !== textKey)
        ? directText
        : stripLeadingEmoji(isAvailable ? ctx.t("common.status_available") : ctx.t("common.status_sold_out"));
      const statusBadge = `${statusIcon} ${rawStatusText}`;

      const timeWord = ctx.lang === "uk" ? "Час" : ctx.lang === "ru" ? "Время" : "Hours";
      const statusWord = ctx.lang === "uk" ? "Статус" : ctx.lang === "ru" ? "Статус" : "Status";
      const priceWord = ctx.lang === "uk" ? "Ціна" : ctx.lang === "ru" ? "Цена" : "Price";

      let row = `• ${shiftHeader}\n` +
        `   <b>${timeWord}:</b> <code>${hoursLocal}</code>\n` +
        `   <b>${statusWord}:</b> ${statusBadge} | <b>${priceWord}:</b> <code>$${b.price_month}/міс</code>`;

      if (isAvailable && smart?.predictionTip) {
        row += `\n   ${smart.predictionTip}`;
      } else if (!isAvailable) {
        if (smart?.etaTip) {
          row += `\n   ${smart.etaTip}`;
        } else if (smart?.collectingStatsTip) {
          row += `\n   ${smart.collectingStatsTip}`;
        }
      }

      return row;
    })
    .join("\n\n");

  const parseNum = (v: string) => parseFloat(String(v).replace(/[^0-9.-]/g, "")) || 0;
  const prices = blocks.map((b) => parseNum(b.price_month)).filter((p) => p > 0);
  const minPriceNum = prices.length > 0 ? Math.min(...prices) : parseNum(first.min_price_day);
  const minPrice = minPriceNum > 0 ? minPriceNum.toFixed(2) : "0.00";
  const minPriceDay = minPriceNum > 0 ? (minPriceNum / 30).toFixed(2) : "0.00";

  const telemetry = scraper?.getTelemetry();
  const lastVerified = poolStateDao.getLastVerified();
  const lastVerifiedTs = telemetry?.lastScrapeTimestamp || lastVerified?.timestamp;

  const footerStr = formatMonitoringFooter(
    lastVerifiedTs,
    ctx.lang,
    lastUserInteractionAt,
    telemetry?.consecutiveFailures || 0
  );

  const rank = POOL_RANKS[slug] || {
    iconsHtml: icon("pool_generic"),
    tierName: { [ctx.lang]: first.pool_name },
    tagline: { [ctx.lang]: first.description },
  };
  const rankTitle = rank.tierName[ctx.lang] || first.pool_name;

  const totalBlocks = blocks.length || 3;
  const availableCount = blocks.filter((b) => b.status === "available" || b.status === "limited").length;
  const capacityBar = renderCapacityBar(availableCount, totalBlocks, "html");

  const capacityLabel = ctx.lang === "uk" ? "Місткість кластера" : ctx.lang === "ru" ? "Вместимость кластера" : "Cluster Capacity";
  const modelsLabel = ctx.lang === "uk" ? "Включені моделі (безліміт):" : ctx.lang === "ru" ? "Включенные модели (безлимит):" : "Included Models (unlimited):";
  const costLabel = ctx.lang === "uk" ? "Вартість:" : ctx.lang === "ru" ? "Стоимость:" : "Pricing:";
  const baseLabel = ctx.lang === "uk" ? "Базовий тариф: від" : ctx.lang === "ru" ? "Базовый тариф: от" : "Base rate: from";
  const dayLabel = ctx.lang === "uk" ? "день" : ctx.lang === "ru" ? "день" : "day";
  const discountLabel = ctx.lang === "uk" ? "Знижка при оплаті за рік:" : ctx.lang === "ru" ? "Скидка при оплате за год:" : "Annual discount:";
  const blocksLabel = ctx.lang === "uk" ? "Регіональні 8-годинні зміни:" : ctx.lang === "ru" ? "Региональные 8-часовые смены:" : "Regional 8-hour shifts:";
  const urlText = ctx.lang === "uk" ? "Сторінка тарифу на сайті" : ctx.lang === "ru" ? "Страница тарифа на сайте" : "Plan page on website";
  const annualDiscountPct = Math.round((first.annual_discount || 0.15) * 100);

  const fullText = `${rank.iconsHtml} <b>${escapeHtml(rankTitle)}</b>\n` +
    `• ${capacityLabel}: [ ${capacityBar} ] <i>(${availableCount}/${totalBlocks} вільні)</i>\n\n` +
    `${icon("ai_robot")} <b>${modelsLabel}</b>\n` +
    `${modelsList || "  • Custom open-weights models"}\n\n` +
    `${icon("price_money")} <b>${costLabel}</b>\n` +
    `• ${baseLabel} <b>$${minPrice}/міс</b> (~$${minPriceDay}/${dayLabel})\n` +
    `• ${discountLabel} <b>${annualDiscountPct}%</b>\n\n` +
    `${icon("nav_clock")} <b>${blocksLabel}</b>\n` +
    `${blocksList}\n\n` +
    `${icon("nav_link")} <a href="https://cheapestinference.com/pools/${slug}"><b>${urlText}</b></a>\n\n` +
    `${icon("nav_clock")} <i>${ctx.lang === "uk" ? "Дані перевірено" : ctx.lang === "ru" ? "Данные проверены" : "Verified at"}: ${footerStr}</i>`;

  return clampMessageText(fullText);
}
