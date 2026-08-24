import { Menu } from "@grammyjs/menu";
import { BotContext } from "../../types/context.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { UserDAO } from "../../db/dao/users.js";
import { createLanguageMenu } from "./language.js";
import { createPoolDetailMenu, renderPoolDetailText } from "./poolDetail.js";
import { createSubscriptionsMenu, renderSubscriptionsText } from "./subscriptions.js";

export async function safeEditMessageText(
  ctx: BotContext,
  text: string,
  extra?: any
): Promise<boolean> {
  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...extra,
    });
    return true;
  } catch (err: any) {
    if (err?.description?.includes("message is not modified")) {
      return false;
    }
    throw err;
  }
}

export function createMainMenu(
  poolStateDao: PoolStateDAO,
  subDao: SubscriptionDAO,
  userDao: UserDAO
) {
  const languageMenu = createLanguageMenu(userDao, poolStateDao);
  const poolDetailMenu = createPoolDetailMenu(poolStateDao, subDao);
  const subscriptionsMenu = createSubscriptionsMenu(subDao, userDao, poolStateDao);

  const helpMenu = new Menu<BotContext>("help-menu")
    .url((ctx) => ctx.t("common.btn_contact_author"), "https://t.me/grizlizora")
    .row()
    .back(
      (ctx) => ctx.t("common.back"),
      async (ctx) => {
        await safeEditMessageText(ctx, renderDashboardText(ctx, poolStateDao));
      }
    );

  const mainDashboardMenu = new Menu<BotContext>("main-dashboard")
    .dynamic((ctx, range) => {
      const summaries = poolStateDao.getPoolSummaries();
      const pools =
        summaries.length > 0
          ? summaries
          : [
              { slug: "flagship", name: "Flagship" },
              { slug: "frontier", name: "Frontier" },
              { slug: "core", name: "Core" },
            ];

      for (let i = 0; i < pools.length; i++) {
        const p = pools[i];
        const icon =
          p.slug === "flagship"
            ? "🚀"
            : p.slug === "frontier"
            ? "⚡"
            : p.slug === "core"
            ? "🧠"
            : "📦";
        const label = `${icon} ${p.name}`;

        range.text(label, async (c) => {
          c.session.tempPoolSlug = p.slug;
          await safeEditMessageText(c, renderPoolDetailText(c, poolStateDao));
          return c.menu.nav("pool-detail-menu");
        });

        if (i % 2 === 1) range.row();
      }
      if (pools.length % 2 !== 0) range.row();
    })
    .text(
      (ctx) => ctx.t("menu.btn_subscriptions"),
      async (ctx) => {
        await safeEditMessageText(ctx, renderSubscriptionsText(ctx, subDao));
        return ctx.menu.nav("subscriptions-menu");
      }
    )
    .text(
      (ctx) => ctx.t("menu.btn_help"),
      async (ctx) => {
        await safeEditMessageText(ctx, ctx.t("help_text"));
        return ctx.menu.nav("help-menu");
      }
    )
    .row()
    .text(
      (ctx) => ctx.t("menu.btn_refresh"),
      async (ctx) => {
        await ctx.answerCallbackQuery({
          text: ctx.t("common.refreshed_toast"),
          show_alert: false,
        });
        await safeEditMessageText(ctx, renderDashboardText(ctx, poolStateDao));
        try {
          ctx.menu.update();
        } catch {}
      }
    )
    .text(
      (ctx) => ctx.t("menu.btn_language"),
      async (ctx) => {
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
  poolStateDao: PoolStateDAO
): string {
  const summaries = poolStateDao.getPoolSummaries();

  if (summaries.length === 0) {
    return ctx.t("menu.dashboard_title", {
      pool_summaries: ctx.t("menu.loading_data"),
      updated_at: new Date().toISOString().replace("T", " ").substring(0, 19) + " UTC",
    });
  }

  const poolSummariesText = summaries
    .map((p) => {
      const statusBadge =
        p.available_count > 0
          ? ctx.t("common.status_available")
          : ctx.t("common.status_sold_out");

      return ctx.t("menu.pool_summary_card", {
        pool_name: p.fullName || p.name,
        status_badge: statusBadge,
        models: p.models.join(", ") || "Active LLMs",
        min_price: p.min_price,
        available_count: p.available_count,
        url: `https://cheapestinference.com/pools/${p.slug}`,
      });
    })
    .join("\n\n");

  return ctx.t("menu.dashboard_title", {
    pool_summaries: poolSummariesText,
    updated_at: new Date().toISOString().replace("T", " ").substring(0, 19) + " UTC",
  });
}
