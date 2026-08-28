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
  const totalBlocks = blocks.length || 3;

  let subscribedCount = 0;
  if (subDao.hasSubscription(ctx.user.id, "ALL", "ALL") || subDao.hasSubscription(ctx.user.id, slug, "ALL")) {
    subscribedCount = totalBlocks;
  } else {
    for (const b of blocks) {
      if (subDao.hasSubscription(ctx.user.id, slug, b.block_id)) {
        subscribedCount++;
      }
    }
  }

  const capacityBar = renderCapacityBar(subscribedCount, totalBlocks, "html");

  let statusWord = "";
  if (subscribedCount === totalBlocks) {
    statusWord = ctx.lang === "uk" ? "Увімкнено" : ctx.lang === "ru" ? "Включено" : "Enabled";
  } else if (subscribedCount > 0) {
    statusWord = ctx.lang === "uk" ? "Частково" : ctx.lang === "ru" ? "Частично" : "Partial";
  } else {
    statusWord = ctx.lang === "uk" ? "Вимкнено" : ctx.lang === "ru" ? "Выключено" : "Disabled";
  }

  const blocksUnit = ctx.lang === "uk" ? "блоків" : ctx.lang === "ru" ? "блоков" : "blocks";
  const rank = POOL_RANKS[slug];
  const poolTitle = rank?.tierName[ctx.lang] || blocks[0]?.pool_name || slug.toUpperCase();

  const onText = ctx.lang === "uk" ? `Увімкнено ${icon("toggle_on")}` : ctx.lang === "ru" ? `Включено ${icon("toggle_on")}` : `Enabled ${icon("toggle_on")}`;
  const offText = ctx.lang === "uk" ? `Вимкнено ${icon("toggle_off")}` : ctx.lang === "ru" ? `Выключено ${icon("toggle_off")}` : `Disabled ${icon("toggle_off")}`;

  const headerTitle = ctx.lang === "uk"
    ? `<b>Фільтри сповіщень • ${escapeHtml(poolTitle)}</b>`
    : ctx.lang === "ru"
    ? `<b>Фильтры уведомлений • ${escapeHtml(poolTitle)}</b>`
    : `<b>Notification Filters • ${escapeHtml(poolTitle)}</b>`;

  const subStatusLabel = ctx.lang === "uk" ? "Підписка на кластер" : ctx.lang === "ru" ? "Подписка на кластер" : "Cluster Subscription";

  const categoriesHeader = ctx.lang === "uk" ? "Категорії сповіщень:" : ctx.lang === "ru" ? "Категории уведомлений:" : "Event Categories:";
  const dropsLabel = ctx.lang === "uk" ? "Вільні слоти (Drops)" : ctx.lang === "ru" ? "Свободные слоты (Drops)" : "Available Slots (Drops)";
  const soldLabel = ctx.lang === "uk" ? "Розпродано (Sold Out)" : ctx.lang === "ru" ? "Распродано (Sold Out)" : "Sold Out";
  const modelsLabel = ctx.lang === "uk" ? "Оновлення моделей" : ctx.lang === "ru" ? "Обновления моделей" : "Model Updates";
  const pricesLabel = ctx.lang === "uk" ? "Зміна цін та знижок" : ctx.lang === "ru" ? "Изменение цен и скидок" : "Price & Discount Changes";

  return `${icon("nav_settings")} ${headerTitle}\n\n` +
    `${icon("notify_bell_on")} <b>${subStatusLabel}:</b> [ ${capacityBar} ] <b>${statusWord}</b> <i>(${subscribedCount}/${totalBlocks} ${blocksUnit})</i>\n\n` +
    `<b>${categoriesHeader}</b>\n` +
    `• ${icon("event_slot_drop")} ${dropsLabel}: ${flags.available ? onText : offText}\n` +
    `• ${icon("event_slot_sold")} ${soldLabel}: ${flags.soldOut ? onText : offText}\n` +
    `• ${icon("ai_robot")} ${modelsLabel}: ${flags.models ? onText : offText}\n` +
    `• ${icon("price_tag")} ${pricesLabel}: ${flags.prices ? onText : offText}`;
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

  if (!blocks || blocks.length === 0) {
    return ctx.t("pool_detail.no_data", { pool_slug: slug.toUpperCase() });
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
  const currencyMonth = ctx.t("common.currency_month") || "mo";
  const freeLabel = ctx.lang === "uk" ? "вільні" : ctx.lang === "ru" ? "свободно" : "free";

  const blocksList = blocks
    .map((b) => {
      const shift = getShiftPersonification(b.block_id, ctx.lang);
      const hoursLocal = formatBlockHoursWithLocal(b.block_id, b.hours_utc, ctx.lang);
      const cleanPrice = String(b.price_month).replace(/(\.00|\.0)$/, "");
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

      let row = `${shift.icon} <b>${shift.name}</b> <i>(${shift.shiftName})</i>\n` +
        `• <code>${hoursLocal}</code>\n` +
        `• ${statusIcon} <b>${rawStatusText}</b> — <b>$${cleanPrice}/${currencyMonth}</b>`;

      if (isAvailable && smart?.predictionTip) {
        row += `\n  ${smart.predictionTip}`;
      } else if (!isAvailable && smart?.etaTip) {
        row += `\n  ${smart.etaTip}`;
      }

      return row;
    })
    .join("\n\n");

  const parseNum = (v: string) => parseFloat(String(v).replace(/[^0-9.-]/g, "")) || 0;
  const prices = blocks.map((b) => parseNum(b.price_month)).filter((p) => p > 0);
  const minPrice = prices.length > 0 ? Math.min(...prices).toFixed(2) : "0.00";
  const minPriceDay = (parseFloat(minPrice) / 30).toFixed(2);

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
    `• ${capacityLabel}: [ ${capacityBar} ] <i>(${availableCount}/${totalBlocks} ${freeLabel})</i>\n\n` +
    `${icon("ai_robot")} <b>${modelsLabel}</b>\n` +
    `${modelsList || "  • Custom open-weights models"}\n\n` +
    `${icon("price_money")} <b>${costLabel}</b>\n` +
    `• ${baseLabel} <b>$${minPrice}/${currencyMonth}</b> (~$${minPriceDay}/${dayLabel})\n` +
    `• ${discountLabel} <b>${annualDiscountPct}%</b>\n\n` +
    `${icon("nav_clock")} <b>${blocksLabel}</b>\n` +
    `${blocksList}\n\n` +
    `${icon("nav_link")} <a href="https://cheapestinference.com/pools/${slug}"><b>${urlText}</b></a>\n\n` +
    `${icon("nav_clock")} <i>${ctx.lang === "uk" ? "Дані перевірено" : ctx.lang === "ru" ? "Данные проверены" : "Verified at"}: ${footerStr}</i>`;

  return clampMessageText(fullText);
}
