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

  const onText = ctx.t("subscriptions.filter_on");
  const offText = ctx.t("subscriptions.filter_off");

  return ctx.t("pool_settings.title", {
    pool_name: escapeHtml(poolName),
    avail_status: flags.available ? onText : offText,
    sold_status: flags.soldOut ? onText : offText,
    model_status: flags.models ? onText : offText,
    price_status: flags.prices ? onText : offText,
    pool_status: flags.isSubscribed
      ? ctx.t("subscriptions.global_enabled")
      : ctx.t("subscriptions.global_disabled"),
  });
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
      const blockName = ctx.t(`common.block_${b.block_id}`) || b.block_id;
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

      const blockIcon = getBlockIcon(b.block_id);

      let row = ctx.t("pool_detail.block_row", {
        block_icon: blockIcon,
        block_name: blockName,
        hours_utc: b.hours_utc,
        status_badge: statusBadge,
        price: b.price_month,
      });

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
    .join("\n");

  const parseNum = (v: string) => parseFloat(String(v).replace(/[^0-9.-]/g, "")) || 0;
  const prices = blocks.map((b) => parseNum(b.price_month)).filter((p) => p > 0);
  const minPriceNum = prices.length > 0 ? Math.min(...prices) : parseNum(first.min_price_day);
  const minPrice = minPriceNum > 0 ? minPriceNum.toFixed(2) : "0.00";
  const minPriceDay = minPriceNum > 0 ? (minPriceNum / 30).toFixed(2) : "0.00";

  const telemetry = scraper?.getTelemetry();
  const lastVerified = poolStateDao.getLastVerified();
  const lastVerifiedTs = telemetry?.lastScrapeTimestamp || lastVerified?.timestamp;

  const monitoringText = formatMonitoringFooter(
    lastVerifiedTs,
    ctx.lang,
    lastUserInteractionAt,
    telemetry?.consecutiveFailures || 0
  );
  const timeFooter = `\n\n${icon("nav_clock")} <i>${ctx.lang === "uk" ? "Дані перевірено" : ctx.lang === "ru" ? "Данные проверены" : "Verified at"}: ${monitoringText}</i>`;

  let specificPoolIcon = icon("pool_generic");
  if (slug.includes("flagship")) specificPoolIcon = icon("pool_flagship");
  else if (slug.includes("core")) specificPoolIcon = icon("pool_core");
  else if (slug.includes("frontier")) specificPoolIcon = icon("pool_frontier");

  const descLabel = ctx.lang === "uk" ? "Опис:" : ctx.lang === "ru" ? "Описание:" : "Description:";
  const modelsLabel = ctx.lang === "uk" ? "Включені моделі (безліміт):" : ctx.lang === "ru" ? "Включенные модели (безлимит):" : "Included Models (unlimited):";
  const costLabel = ctx.lang === "uk" ? "Вартість:" : ctx.lang === "ru" ? "Стоимость:" : "Pricing:";
  const baseLabel = ctx.lang === "uk" ? "Базовий тариф: від" : ctx.lang === "ru" ? "Базовый тариф: от" : "Base rate: from";
  const dayLabel = ctx.lang === "uk" ? "день" : ctx.lang === "ru" ? "день" : "day";
  const discountLabel = ctx.lang === "uk" ? "Знижка при оплаті за рік:" : ctx.lang === "ru" ? "Скидка при оплате за год:" : "Annual discount:";
  const blocksLabel = ctx.lang === "uk" ? "Регіональні 8-годинні блоки (UTC):" : ctx.lang === "ru" ? "Региональные 8-часовые блоки (UTC):" : "Regional 8-hour blocks (UTC):";
  const linkLabel = ctx.lang === "uk" ? "Офіційне посилання:" : ctx.lang === "ru" ? "Официальная ссылка:" : "Official link:";
  const annualDiscountPct = Math.round((first.annual_discount || 0.15) * 100);

  const fullText = `${specificPoolIcon} <b>${escapeHtml(first.pool_name)}</b>\n\n` +
    `${icon("event_tier_update")} <b>${descLabel}</b>\n` +
    `<i>${escapeHtml(first.description || "Unlimited AI inference pool")}</i>\n\n` +
    `${icon("ai_robot")} <b>${modelsLabel}</b>\n` +
    `${modelsList || "  • Custom open-weights models"}\n\n` +
    `${icon("price_money")} <b>${costLabel}</b>\n` +
    `• ${baseLabel} <b>$${minPrice}/міс</b> (~$${minPriceDay}/${dayLabel})\n` +
    `• ${discountLabel} <b>${annualDiscountPct}%</b>\n\n` +
    `${icon("nav_clock")} <b>${blocksLabel}</b>\n` +
    `${blocksList}\n\n` +
    `${icon("nav_link")} <b>${linkLabel}</b> <a href="https://cheapestinference.com/pools/${slug}">https://cheapestinference.com/pools/${slug}</a>`;

  return clampMessageText(`${fullText}${timeFooter}`);
}
