import { Menu } from "@grammyjs/menu";
import { BotContext } from "../../types/context.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { UserDAO } from "../../db/dao/users.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { SubscriberInvertedIndex } from "../notifier/subscriberIndex.js";
import { AvailabilityIntelligenceEngine } from "../../engine/intelligenceEngine.js";
import { createLanguageMenu } from "./language.js";
import { createPoolDetailMenu, renderPoolDetailText } from "./poolDetail.js";
import { createSubscriptionsMenu, renderSubscriptionsText } from "./subscriptions.js";
import { escapeHtml, formatRelativeTime } from "../../i18n/index.js";

import { ScraperOrchestrator } from "../../engine/scraperOrchestrator.js";

/**
 * Safely edit message text ignoring Telegram 400 "message is not modified"
 */
export async function safeEditMessageText(
  ctx: BotContext,
  text: string,
  extra: any = { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
) {
  try {
    const finalExtra = { ...extra };
    await ctx.editMessageText(text, finalExtra);
  } catch (err: any) {
    if (
      err?.description?.includes("message is not modified") ||
      err?.message?.includes("message is not modified")
    ) {
      return;
    }
    console.warn("⚠️ [Menu] Safe editMessageText warning:", err?.message || err);
  }
}

export function createMainMenuHierarchy(
  poolStateDao: PoolStateDAO,
  userDao: UserDAO,
  subDao: SubscriptionDAO,
  invertedIndex: SubscriberInvertedIndex,
  historyDao?: SlotHistoryDAO,
  scraper?: ScraperOrchestrator
) {
  const languageMenu = createLanguageMenu(userDao, poolStateDao, invertedIndex, historyDao, scraper, subDao);
  const { poolDetailMenu, poolSettingsMenu } = createPoolDetailMenu(poolStateDao, subDao, invertedIndex, historyDao, scraper);
  const subscriptionsMenu = createSubscriptionsMenu(subDao, userDao, poolStateDao, invertedIndex, historyDao, scraper);

  const helpMenu = new Menu<BotContext>("help-menu")
    .url(
      (ctx) => ctx.t("common.btn_contact_author"),
      "https://t.me/grizlizora"
    )
    .row()
    .text(
      (ctx) => ctx.t("common.back"),
      async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        await safeEditMessageText(ctx, renderDashboardText(ctx, poolStateDao, historyDao, scraper));
        return ctx.menu.nav("main-dashboard-menu");
      }
    );

  const mainDashboardMenu = new Menu<BotContext>("main-dashboard-menu")
    .dynamic((ctx, range) => {
      const summaries = poolStateDao.getPoolSummaries();
      const pools =
        summaries.length > 0
          ? summaries.map((s) => ({
              slug: s.slug,
              name: s.name,
              availableCount: s.available_count,
              totalBlocks: s.total_blocks || 3,
            }))
          : [
              { slug: "flagship", name: "Flagship", availableCount: 0, totalBlocks: 3 },
              { slug: "frontier", name: "Frontier", availableCount: 0, totalBlocks: 3 },
              { slug: "core", name: "Core", availableCount: 0, totalBlocks: 3 },
            ];

      for (const pool of pools) {
        let icon = "🔴";
        if (pool.availableCount >= pool.totalBlocks && pool.totalBlocks > 0) {
          icon = "🟢";
        } else if (pool.availableCount > 0) {
          icon = "🟡";
        } else {
          icon = "🔴";
        }

        range
          .text(`${icon} ${pool.name}`, async (c) => {
            await c.answerCallbackQuery().catch(() => {});
            c.session.tempPoolSlug = pool.slug;
            await safeEditMessageText(
              c,
              renderPoolDetailText(c, poolStateDao, historyDao, scraper)
            );
            return c.menu.nav("pool-detail-menu");
          })
          .row();
      }
    })
    .text(
      (ctx) => ctx.t("menu.btn_subscriptions"),
      async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        await safeEditMessageText(ctx, renderSubscriptionsText(ctx, subDao));
        return ctx.menu.nav("subscriptions-menu");
      }
    )
    .row()
    .text(
      (ctx) => ctx.t("common.refresh"),
      async (ctx) => {
        await ctx.answerCallbackQuery({
          text: ctx.lang === "uk" ? "🔄 Оновлюю дані з сайту..." : ctx.lang === "ru" ? "🔄 Обновляю данные с сайта..." : "🔄 Refreshing data from site...",
          show_alert: false,
        }).catch(() => {});
        if (scraper) {
          await scraper.forceRefresh(3000);
        }
        await safeEditMessageText(ctx, renderDashboardText(ctx, poolStateDao, historyDao, scraper));
        try {
          ctx.menu.update();
        } catch {}
      }
    )
    .text(
      (ctx) => ctx.t("common.help"),
      async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        await safeEditMessageText(ctx, ctx.t("help_text", { telegram_id: String(ctx.from?.id || "N/A") }));
        return ctx.menu.nav("help-menu");
      }
    )
    .row()
    .text(
      (ctx) => ctx.t("menu.btn_language"),
      async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        await safeEditMessageText(ctx, ctx.t("onboarding.welcome_title"));
        return ctx.menu.nav("language-menu");
      }
    );

  // Register submenus into hierarchy
  mainDashboardMenu.register(poolDetailMenu);
  mainDashboardMenu.register(subscriptionsMenu);
  mainDashboardMenu.register(languageMenu);
  mainDashboardMenu.register(helpMenu);

  return { mainDashboardMenu, languageMenu, poolDetailMenu, poolSettingsMenu, subscriptionsMenu, helpMenu };
}

export function renderDashboardText(
  ctx: BotContext,
  poolStateDao: PoolStateDAO,
  historyDao?: SlotHistoryDAO,
  scraper?: ScraperOrchestrator
): string {
  const summaries = poolStateDao.getPoolSummaries();

  const lastVerifiedTs = scraper?.getTelemetry().lastScrapeTimestamp || poolStateDao.getLastVerified()?.timestamp;
  let updatedAtStr = "";
  if (lastVerifiedTs && lastVerifiedTs > 0) {
    const utcDateStr = new Date(lastVerifiedTs).toISOString().replace("T", " ").substring(0, 19) + " UTC";
    const elapsedText = formatRelativeTime(lastVerifiedTs, ctx.lang);
    updatedAtStr = `${utcDateStr} (${elapsedText})`;
  } else {
    updatedAtStr = new Date().toISOString().replace("T", " ").substring(0, 19) + " UTC";
  }

  const telemetry = scraper?.getTelemetry();
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
      const total = p.total_blocks || 3;
      let statusBadge: string;
      if (p.available_count >= total && total > 0) {
        statusBadge = ctx.t("common.status_available");
      } else if (p.available_count > 0) {
        statusBadge = ctx.t("common.status_partially_available");
      } else {
        statusBadge = ctx.t("common.status_sold_out");
      }

      return ctx.t("menu.pool_summary_card", {
        pool_name: escapeHtml(p.name),
        status_badge: statusBadge,
        models: escapeHtml(p.models.join(", ")) || ctx.t("common.custom_models"),
        min_price: p.min_price,
        available_count: p.available_count,
        total_blocks: p.total_blocks || 3,
        url: `https://cheapestinference.com/pools/${p.slug}`,
      });
    })
    .join("\n\n");

  return ctx.t("menu.dashboard_title", {
    pool_summaries: poolSummariesText,
    updated_at: updatedAtStr,
  });
}
