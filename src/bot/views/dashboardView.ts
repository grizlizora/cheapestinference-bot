import { BotContext } from "../../types/context.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { ScraperOrchestrator } from "../../engine/scraperOrchestrator.js";
import { escapeHtml, formatRelativeTime } from "../../i18n/index.js";
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
      const rawStatusText = ctx.t(badgeInfo.statusBadgeKey).replace(/^[🟢🟡🔴]\s*/, "");
      const statusBadge = `${badgeInfo.iconHtml} ${rawStatusText}`;
      const rawModels = (p.models || []).slice(0, 10).join(", ");
      const modelsText = escapeHtml(rawModels) || ctx.t("common.custom_models");

      const card = ctx.t("menu.pool_summary_card", {
        pool_name: escapeHtml(p.name),
        status_badge: statusBadge,
        models: modelsText,
        min_price: p.min_price,
        available_count: p.available_count,
        total_blocks: p.total_blocks || 3,
        url: `https://cheapestinference.com/pools/${p.slug}`,
      });

      // Elevate pool box icon to animated custom emoji if available
      return card.replace(/^📦\s*/, `${icon("pool_generic")} `);
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
