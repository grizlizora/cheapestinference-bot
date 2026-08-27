/**
 * src/bot/views/dashboardView.ts
 * Pure Dashboard Presentation & Status Formatting
 */

import { BotContext } from "../../types/context.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { ScraperOrchestrator } from "../../engine/scraperOrchestrator.js";
import { escapeHtml, formatRelativeTime } from "../../i18n/index.js";
import { clampMessageText } from "./common.js";

export interface PoolBadgeInfo {
  icon: "🟢" | "🟡" | "🔴";
  shortStatus: string;
  statusBadgeKey: string;
}

export function computePoolBadgeInfo(availableCount: number, totalBlocks: number): PoolBadgeInfo {
  const total = totalBlocks || 3;
  if (availableCount >= total && total > 0) {
    return { icon: "🟢", shortStatus: `${availableCount}/${total}`, statusBadgeKey: "common.status_available" };
  } else if (availableCount > 0) {
    return { icon: "🟡", shortStatus: `${availableCount}/${total}`, statusBadgeKey: "common.status_partially_available" };
  } else {
    return { icon: "🔴", shortStatus: `${availableCount}/${total}`, statusBadgeKey: "common.status_sold_out" };
  }
}

export function renderDashboardText(
  ctx: BotContext,
  poolStateDao: PoolStateDAO,
  historyDao?: SlotHistoryDAO,
  scraper?: ScraperOrchestrator
): string {
  const summaries = poolStateDao.getPoolSummaries();
  const telemetry = scraper?.getTelemetry();
  const lastVerified = poolStateDao.getLastVerified();
  const lastVerifiedTs = telemetry?.lastScrapeTimestamp || lastVerified?.timestamp;

  let updatedAtStr = "";
  if (lastVerifiedTs && lastVerifiedTs > 0) {
    const utcDateStr = new Date(lastVerifiedTs).toISOString().replace("T", " ").substring(0, 19) + " UTC";
    const elapsedText = formatRelativeTime(lastVerifiedTs, ctx.lang);
    updatedAtStr = `${utcDateStr} (${elapsedText})`;
  } else {
    updatedAtStr = new Date().toISOString().replace("T", " ").substring(0, 19) + " UTC";
  }

  if (telemetry && telemetry.consecutiveFailures > 0) {
    updatedAtStr +=
      ctx.lang === "uk"
        ? ` ⚠️ [затримка мережі, спроба ${telemetry.consecutiveFailures}]`
        : ctx.lang === "ru"
        ? ` ⚠️ [задержка сети, попытка ${telemetry.consecutiveFailures}]`
        : ` ⚠️ [network delay, retry ${telemetry.consecutiveFailures}]`;
  }

  if (summaries.length === 0) {
    return ctx.t("menu.dashboard_title", {
      pool_summaries: ctx.t("menu.loading_data"),
      updated_at: updatedAtStr,
    });
  }

  const poolSummariesText = summaries
    .map((p) => {
      const badgeInfo = computePoolBadgeInfo(p.available_count, p.total_blocks);
      const statusBadge = ctx.t(badgeInfo.statusBadgeKey);
      const rawModels = (p.models || []).slice(0, 10).join(", ");
      const modelsText = escapeHtml(rawModels) || ctx.t("common.custom_models");

      return ctx.t("menu.pool_summary_card", {
        pool_name: escapeHtml(p.name),
        status_badge: statusBadge,
        models: modelsText,
        min_price: p.min_price,
        available_count: p.available_count,
        total_blocks: p.total_blocks || 3,
        url: `https://cheapestinference.com/pools/${p.slug}`,
      });
    })
    .join("\n\n");

  const rendered = ctx.t("menu.dashboard_title", {
    pool_summaries: poolSummariesText,
    updated_at: updatedAtStr,
  });

  return clampMessageText(rendered);
}

export function renderSettingsText(ctx: BotContext): string {
  const langNames: Record<string, string> = {
    uk: "Українська 🇺🇦",
    en: "English 🇬🇧",
    ru: "Русский 🇷🇺",
  };
  const currentLang = langNames[ctx.lang] || ctx.lang;

  return ctx.t("settings.title", {
    current_lang: currentLang,
    telegram_id: String(ctx.from?.id || "N/A"),
  });
}
