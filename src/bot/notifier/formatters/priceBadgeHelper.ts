/**
 * src/bot/notifier/formatters/priceBadgeHelper.ts
 * Price Analytics, Badges, Region Mapping and Sanitization Utilities
 */

import { PriceAnalyticsPayload } from "../../../types/domain.js";
import { translate, SupportedLanguage, stripLeadingEmoji } from "../../../i18n/index.js";
import { icon } from "../../views/iconTheme.js";

const REGEX_DASH_SPLIT = /\s*—\s*|\s*–\s*|\s+-\s+/;
const REGEX_NON_NUMERIC = /[^0-9.-]/g;

export function cleanPoolTitle(poolName: string, poolSlug?: string): string {
  if (!poolName) {
    if (poolSlug === "flagship") return "Flagship Pool";
    if (poolSlug === "core") return "Core Pool";
    if (poolSlug === "frontier") return "Frontier Pool";
    return "Pool";
  }
  const cleaned = poolName.split(REGEX_DASH_SPLIT)[0].trim();
  return cleaned || poolName;
}

export function cleanPriceString(val: string | number | undefined | null): string {
  if (val === undefined || val === null || val === "") return "0";
  if (typeof val === "number") {
    if (isNaN(val) || Object.is(val, -0) || val === 0) return "0";
    return val % 1 === 0 ? val.toFixed(0) : val.toFixed(2);
  }
  const cleaned = String(val).replace(/,/g, "").replace(REGEX_NON_NUMERIC, "");
  const num = parseFloat(cleaned);
  if (isNaN(num) || Object.is(num, -0) || num === 0) return "0";
  return num % 1 === 0 ? num.toFixed(0) : num.toFixed(2);
}

export function formatPriceDeltaBadge(
  delta: number,
  pct: number,
  lang: SupportedLanguage
): string {
  if (!Number.isFinite(delta) || !Number.isFinite(pct)) return "";
  const roundedDelta = Math.round(Math.abs(delta) * 100) / 100;
  if (roundedDelta === 0) return "";
  const currencyMonth = translate(lang, "common.currency_month") || "mo";
  const absDelta = Number.isInteger(roundedDelta) ? roundedDelta.toFixed(0) : roundedDelta.toFixed(2);
  const roundedPct = Math.round(Math.abs(pct) * 10) / 10;
  const absPct = Number.isInteger(roundedPct) ? roundedPct.toFixed(0) : roundedPct.toFixed(1);

  if (delta < 0) {
    const raw = stripLeadingEmoji(translate(lang, "alerts.price_discount_badge", {
      delta: absDelta,
      percentage: absPct,
      currency_month: currencyMonth,
    }));
    return `${icon("status_available")} ${raw}`;
  } else {
    const raw = stripLeadingEmoji(translate(lang, "alerts.price_increase_badge", {
      delta: absDelta,
      percentage: absPct,
      currency_month: currencyMonth,
    }));
    return `${icon("status_sold_out")} ${raw}`;
  }
}

export function formatPriceRatingBadge(
  pa: PriceAnalyticsPayload | undefined,
  currentPrice: number,
  lang: SupportedLanguage
): string {
  if (!pa || pa.rating === "insufficient_data" || pa.sampleCount < 3) return "";
  const currStr = currentPrice % 1 === 0 ? currentPrice.toFixed(0) : currentPrice.toFixed(2);
  const avgStr =
    pa.avgPrice != null ? (pa.avgPrice % 1 === 0 ? pa.avgPrice.toFixed(0) : pa.avgPrice.toFixed(2)) : "";

  if (pa.rating === "all_time_low") {
    const rawText = stripLeadingEmoji(translate(lang, "alerts.price_all_time_low") || `Історичний мінімум! Найнижча ціна ($${currStr})`);
    return `${icon("price_all_time_low")} ${rawText.startsWith("<b>") ? rawText : `<b>${rawText}</b>`}`;
  }
  if (pa.rating === "below_average" && pa.avgPrice != null) {
    const rawText = stripLeadingEmoji(translate(lang, "alerts.price_below_average", { current: currStr, avg: avgStr }) || `Нижче середнього ($${currStr} vs сер. $${avgStr})`);
    return `${icon("event_price_drop")} ${rawText.startsWith("<b>") ? rawText : `<b>${rawText}</b>`}`;
  }
  if (pa.rating === "above_average" && pa.avgPrice != null) {
    const rawText = stripLeadingEmoji(translate(lang, "alerts.price_above_average", { current: currStr, avg: avgStr }) || `Вище середнього ($${currStr} vs сер. $${avgStr})`);
    return `${icon("event_price_hike")} ${rawText.startsWith("<b>") ? rawText : `<b>${rawText}</b>`}`;
  }
  if (pa.rating === "fair" && pa.avgPrice != null) {
    const rawText = stripLeadingEmoji(translate(lang, "alerts.price_fair_value") || "Стандартна ціна (в межах норми)");
    return `${icon("price_fair")} ${rawText.startsWith("<b>") ? rawText : `<b>${rawText}</b>`}`;
  }
  return "";
}

export function resolveBlockName(eventBlock: string, lang: SupportedLanguage): string {
  const translated = translate(lang, `common.block_${eventBlock}`);
  if (translated && translated !== `common.block_${eventBlock}`) {
    return translated;
  }
  if (eventBlock === "ALL") {
    return translate(lang, "common.block_ALL") || "All Blocks";
  }
  return eventBlock;
}

export function getRegionIcon(block: string): string {
  const lower = (block || "").toLowerCase();
  if (lower.includes("asia") || lower.includes("азія") || lower.includes("азия")) {
    return icon("region_asia");
  }
  if (lower.includes("europe") || lower.includes("європа") || lower.includes("европа")) {
    return icon("region_europe");
  }
  if (lower.includes("america") || lower.includes("америка")) {
    return icon("region_americas");
  }
  return icon("nav_language");
}
