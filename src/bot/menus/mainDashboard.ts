import { Menu } from "@grammyjs/menu";
import { BotContext } from "../../types/context.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { UserDAO } from "../../db/dao/users.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { AvailabilityIntelligenceEngine } from "../../engine/intelligenceEngine.js";
import { createLanguageMenu } from "./language.js";
import { createPoolDetailMenu, renderPoolDetailText } from "./poolDetail.js";
import { createSubscriptionsMenu, renderSubscriptionsText } from "./subscriptions.js";

/**
 * Safely edit message text ignoring Telegram 400 "message is not modified"
 */
export async function safeEditMessageText(
  ctx: BotContext,
  text: string,
  extra: any = { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
) {
  try {
    await ctx.editMessageText(text, extra);
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
  historyDao?: SlotHistoryDAO
) {
  const languageMenu = createLanguageMenu(userDao, poolStateDao, historyDao);
  const poolDetailMenu = createPoolDetailMenu(poolStateDao, subDao, historyDao);
  const subscriptionsMenu = createSubscriptionsMenu(subDao, userDao, poolStateDao, historyDao);

  const helpMenu = new Menu<BotContext>("help-menu")
    .url(
      (ctx) => ctx.t("common.btn_contact_author"),
      "https://t.me/grizlizora"
    )
    .row()
    .back(
      (ctx) => ctx.t("common.back"),
      async (ctx) => {
        await ctx.answerCallbackQuery();
        await safeEditMessageText(ctx, renderDashboardText(ctx, poolStateDao, historyDao));
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
              available: s.available_count > 0,
              isLimited: s.blocks.some((b) => b.status === "limited"),
            }))
          : [
              { slug: "flagship", name: "Flagship", available: false, isLimited: false },
              { slug: "frontier", name: "Frontier", available: false, isLimited: false },
              { slug: "core", name: "Core", available: false, isLimited: false },
            ];

      for (const pool of pools) {
        const icon = pool.available ? (pool.isLimited ? "🟡" : "🟢") : "🔴";
        range
          .text(`${icon} ${pool.name}`, async (c) => {
            await c.answerCallbackQuery();
            c.session.tempPoolSlug = pool.slug;
            await safeEditMessageText(
              c,
              renderPoolDetailText(c, poolStateDao, historyDao)
            );
            return c.menu.nav("pool-detail-menu");
          })
          .row();
      }
    })
    .text(
      (ctx) => ctx.t("menu.btn_subscriptions"),
      async (ctx) => {
        await ctx.answerCallbackQuery();
        await safeEditMessageText(ctx, renderSubscriptionsText(ctx, subDao));
        return ctx.menu.nav("subscriptions-menu");
      }
    )
    .row()
    .text(
      (ctx) => ctx.t("common.refresh"),
      async (ctx) => {
        await ctx.answerCallbackQuery({
          text: ctx.t("common.refreshed_toast"),
          show_alert: false,
        });
        await safeEditMessageText(ctx, renderDashboardText(ctx, poolStateDao, historyDao));
        try {
          ctx.menu.update();
        } catch {}
      }
    )
    .text(
      (ctx) => ctx.t("common.help"),
      async (ctx) => {
        await ctx.answerCallbackQuery();
        await safeEditMessageText(ctx, ctx.t("help_text"));
        return ctx.menu.nav("help-menu");
      }
    )
    .row()
    .text(
      (ctx) => ctx.t("menu.btn_language"),
      async (ctx) => {
        await ctx.answerCallbackQuery();
        await safeEditMessageText(ctx, ctx.t("onboarding.welcome_title"));
        return ctx.menu.nav("language-menu");
      }
    );

  // Register submenus into hierarchy
  mainDashboardMenu.register(poolDetailMenu);
  mainDashboardMenu.register(subscriptionsMenu);
  mainDashboardMenu.register(languageMenu);
  mainDashboardMenu.register(helpMenu);

  return { mainDashboardMenu, languageMenu, poolDetailMenu, subscriptionsMenu, helpMenu };
}

export function renderDashboardText(
  ctx: BotContext,
  poolStateDao: PoolStateDAO,
  historyDao?: SlotHistoryDAO
): string {
  const summaries = poolStateDao.getPoolSummaries();

  if (summaries.length === 0) {
    return ctx.t("menu.dashboard_title", {
      pool_summaries: ctx.t("menu.loading_data"),
      updated_at: new Date().toISOString().replace("T", " ").substring(0, 19) + " UTC",
    });
  }

  const intelligenceEngine = historyDao
    ? new AvailabilityIntelligenceEngine(historyDao)
    : null;

  const poolSummariesText = summaries
    .map((p) => {
      // Check if any block has special smart badges
      let statusBadge =
        p.available_count > 0
          ? ctx.t("common.status_available")
          : ctx.t("common.status_sold_out");

      if (intelligenceEngine && p.available_count > 0) {
        for (const b of p.blocks) {
          if (b.status === "limited" || b.status === "available") {
            const smart = intelligenceEngine.getSmartStatus(p.slug, b.block, b.status, ctx.lang);
            if (smart.isHot) {
              statusBadge = smart.badge;
              break;
            }
          }
        }
      }

      return ctx.t("menu.pool_summary_card", {
        pool_name: p.name,
        status_badge: statusBadge,
        models: p.models.join(", ") || "Custom models",
        min_price: p.min_price,
        available_count: p.available_count,
        total_blocks: p.total_blocks || 3,
        url: `https://cheapestinference.com/pools/${p.slug}`,
      });
    })
    .join("\n\n");

  return ctx.t("menu.dashboard_title", {
    pool_summaries: poolSummariesText,
    updated_at: new Date().toISOString().replace("T", " ").substring(0, 19) + " UTC",
  });
}
