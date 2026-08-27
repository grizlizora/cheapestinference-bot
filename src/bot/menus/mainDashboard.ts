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

import { ProxyPool } from "../../proxy/proxyPool.js";
import { NotificationDispatcher } from "../notifier/dispatcher.js";
import { isUserAdmin } from "../../config/env.js";
import { renderAdminText } from "../handlers/admin.js";
import { createBackupHandler } from "../handlers/backup.js";
import { ActiveDashboardRegistry } from "../liveSync/dashboardRegistry.js";

export function createMainMenuHierarchy(
  poolStateDao: PoolStateDAO,
  userDao: UserDAO,
  subDao: SubscriptionDAO,
  invertedIndex: SubscriberInvertedIndex,
  historyDao?: SlotHistoryDAO,
  scraper?: ScraperOrchestrator,
  dashboardRegistry?: ActiveDashboardRegistry,
  proxyPool?: ProxyPool,
  dispatcher?: NotificationDispatcher
) {
  const languageMenu = createLanguageMenu(userDao, poolStateDao, invertedIndex, historyDao, scraper, subDao, dashboardRegistry);
  const { poolDetailMenu, poolSettingsMenu } = createPoolDetailMenu(poolStateDao, subDao, invertedIndex, historyDao, scraper, dashboardRegistry);
  const subscriptionsMenu = createSubscriptionsMenu(subDao, userDao, poolStateDao, invertedIndex, historyDao, scraper, dashboardRegistry);

  const adminMenu = new Menu<BotContext>("admin-menu")
    .text(
      (ctx) => {
        const adminUser = ctx.from ? userDao.getByTelegramId(ctx.from.id) : undefined;
        const newUsersEnabled = (adminUser?.notify_admin_new_users ?? 1) === 1;
        return newUsersEnabled
          ? ctx.t("admin.btn_toggle_new_users_on")
          : ctx.t("admin.btn_toggle_new_users_off");
      },
      async (ctx) => {
        if (!isUserAdmin(ctx.from?.id, userDao, ctx.from?.username)) return;
        const newVal = userDao.toggleAdminNewUsers(ctx.from!.id);
        await ctx.answerCallbackQuery(
          newVal === 1 ? ctx.t("admin.toast_new_users_on") : ctx.t("admin.toast_new_users_off")
        ).catch(() => {});
        if (scraper && proxyPool) {
          await safeEditMessageText(ctx, renderAdminText(ctx, userDao, subDao, scraper, proxyPool));
        }
        try { ctx.menu.update(); } catch {}
      }
    )
    .row()
    .text(
      (ctx) => ctx.t("admin.btn_test_alert"),
      async (ctx) => {
        if (!isUserAdmin(ctx.from?.id, userDao, ctx.from?.username) || !dispatcher) return;
        await ctx.answerCallbackQuery({ text: ctx.t("admin.toast_test_alert_sent"), show_alert: false }).catch(() => {});
        await dispatcher.sendTestAlert(ctx.from!.id, ctx.lang, "slot");
      }
    )
    .text(
      (ctx) => ctx.t("admin.btn_backup"),
      async (ctx) => {
        if (!isUserAdmin(ctx.from?.id, userDao, ctx.from?.username)) return;
        await ctx.answerCallbackQuery().catch(() => {});
        await createBackupHandler(userDao.db, userDao, subDao)(ctx);
      }
    )
    .row()
    .text(
      (ctx) => ctx.t("common.refresh"),
      async (ctx) => {
        if (!isUserAdmin(ctx.from?.id, userDao, ctx.from?.username)) return;
        await ctx.answerCallbackQuery({ text: ctx.t("common.refreshed_toast"), show_alert: false }).catch(() => {});
        if (scraper && proxyPool) {
          await safeEditMessageText(ctx, renderAdminText(ctx, userDao, subDao, scraper, proxyPool));
        }
        try { ctx.menu.update(); } catch {}
      }
    )
    .row()
    .text(
      (ctx) => ctx.t("common.back"),
      async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        if (ctx.chat) {
          dashboardRegistry?.updateView(ctx.chat.id, "settings");
        }
        await safeEditMessageText(ctx, renderSettingsText(ctx));
        return ctx.menu.nav("settings-menu");
      }
    );

  const settingsMenu = new Menu<BotContext>("settings-menu")
    .dynamic((ctx, range) => {
      if (isUserAdmin(ctx.from?.id, userDao, ctx.from?.username)) {
        range
          .text(
            (c) => c.t("settings.btn_admin"),
            async (c) => {
              await c.answerCallbackQuery().catch(() => {});
              if (c.chat) {
                dashboardRegistry?.updateView(c.chat.id, "admin");
              }
              if (scraper && proxyPool) {
                await safeEditMessageText(c, renderAdminText(c, userDao, subDao, scraper, proxyPool));
              }
              return c.menu.nav("admin-menu");
            }
          )
          .row();
      }
    })
    .text(
      (ctx) => ctx.t("settings.btn_language"),
      async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        (ctx.session as any).fromSettings = true;
        if (ctx.chat) {
          dashboardRegistry?.updateView(ctx.chat.id, "other");
        }
        await safeEditMessageText(ctx, ctx.t("onboarding.change_language_prompt"));
        return ctx.menu.nav("language-menu");
      }
    )
    .row()
    .text(
      (ctx) => ctx.t("settings.btn_help"),
      async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        if (ctx.chat) {
          dashboardRegistry?.updateView(ctx.chat.id, "other");
        }
        await safeEditMessageText(ctx, ctx.t("help_text", { telegram_id: String(ctx.from?.id || "N/A") }));
        return ctx.menu.nav("help-menu");
      }
    )
    .row()
    .url(
      (ctx) => ctx.t("settings.btn_contact_author"),
      "https://t.me/grizlizora"
    )
    .row()
    .text(
      (ctx) => ctx.t("common.back"),
      async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        if (ctx.chat) {
          dashboardRegistry?.updateView(ctx.chat.id, "dashboard");
        }
        await safeEditMessageText(ctx, renderDashboardText(ctx, poolStateDao, historyDao, scraper));
        return ctx.menu.nav("main-dashboard-menu");
      }
    );

  const helpMenu = new Menu<BotContext>("help-menu")
    .url(
      (ctx) => ctx.t("settings.btn_contact_author"),
      "https://t.me/grizlizora"
    )
    .row()
    .text(
      (ctx) => ctx.t("common.back"),
      async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        if (ctx.chat) {
          dashboardRegistry?.updateView(ctx.chat.id, "settings");
        }
        await safeEditMessageText(ctx, renderSettingsText(ctx));
        return ctx.menu.nav("settings-menu");
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
            if (c.chat) {
              dashboardRegistry?.updateView(c.chat.id, "pool_detail", pool.slug);
            }
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
      (ctx) => ctx.t("common.refresh"),
      async (ctx) => {
        await ctx.answerCallbackQuery({
          text: ctx.t("common.refreshed_toast"),
          show_alert: false,
        }).catch(() => {});
        if (scraper) {
          await scraper.forceRefresh(3000);
        }
        const rendered = renderDashboardText(ctx, poolStateDao, historyDao, scraper);
        await safeEditMessageText(ctx, rendered);
        if (ctx.chat) {
          const msgId = ctx.callbackQuery?.message?.message_id;
          if (msgId) {
            dashboardRegistry?.register(ctx.chat.id, msgId, ctx.user.id, ctx.lang, "dashboard");
          }
        }
        try {
          ctx.menu.update();
        } catch {}
      }
    )
    .row()
    .text(
      (ctx) => ctx.t("menu.btn_settings"),
      async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        if (ctx.chat) {
          dashboardRegistry?.updateView(ctx.chat.id, "settings");
        }
        await safeEditMessageText(ctx, renderSettingsText(ctx));
        return ctx.menu.nav("settings-menu");
      }
    );

  // Register submenus into hierarchy
  settingsMenu.register(helpMenu);
  settingsMenu.register(languageMenu);
  settingsMenu.register(adminMenu);
  mainDashboardMenu.register(poolDetailMenu);
  mainDashboardMenu.register(subscriptionsMenu);
  mainDashboardMenu.register(settingsMenu);

  return { mainDashboardMenu, languageMenu, poolDetailMenu, poolSettingsMenu, subscriptionsMenu, helpMenu, settingsMenu, adminMenu };
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
