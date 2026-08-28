import { Menu } from "@grammyjs/menu";
import { BotContext } from "../../types/context.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { UserDAO } from "../../db/dao/users.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { SubscriberInvertedIndex } from "../notifier/subscriberIndex.js";
import { createLanguageMenu } from "./language.js";
import { createPoolDetailMenu } from "./poolDetail.js";
import { createSubscriptionsMenu, renderSubscriptionsText } from "./subscriptions.js";
import { ScraperOrchestrator } from "../../engine/scraperOrchestrator.js";
import { ProxyPool } from "../../proxy/proxyPool.js";
import { NotificationDispatcher } from "../notifier/dispatcher.js";
import { isUserAdmin } from "../../config/env.js";
import { renderAdminText } from "../handlers/admin.js";
import { createBackupHandler, createUsersExportHandler, createHistoryExportHandler } from "../handlers/backup.js";
import { ActiveDashboardRegistry } from "../liveSync/dashboardRegistry.js";

// Re-export presentation functions from view layer for 100% backward compatibility
export { renderDashboardText, renderSettingsText, computePoolBadgeInfo } from "../views/dashboardView.js";
export { safeEditMessageText } from "../views/common.js";
import { renderDashboardText, renderSettingsText, computePoolBadgeInfo } from "../views/dashboardView.js";
import { renderPoolDetailText } from "../views/poolDetailView.js";
import { safeEditMessageText } from "../views/common.js";

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
        if (!isUserAdmin(ctx.from?.id, userDao, ctx.from?.username)) {
          ctx.answerCallbackQuery({ text: ctx.t("admin.unauthorized", { telegram_id: String(ctx.from?.id || 0) }), show_alert: true }).catch(() => {});
          return;
        }
        const newVal = userDao.toggleAdminNewUsers(ctx.from!.id);
        ctx.answerCallbackQuery(
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
        if (!isUserAdmin(ctx.from?.id, userDao, ctx.from?.username) || !dispatcher) {
          ctx.answerCallbackQuery({ text: ctx.t("admin.unauthorized", { telegram_id: String(ctx.from?.id || 0) }), show_alert: true }).catch(() => {});
          return;
        }
        ctx.answerCallbackQuery({ text: ctx.t("admin.toast_test_alert_sent"), show_alert: false }).catch(() => {});
        await dispatcher.sendTestAlert(ctx.from!.id, ctx.lang, "slot");
      }
    )
    .row()
    .text(
      (ctx) => ctx.t("admin.btn_export_users"),
      async (ctx) => {
        if (!isUserAdmin(ctx.from?.id, userDao, ctx.from?.username)) {
          ctx.answerCallbackQuery({ text: ctx.t("admin.unauthorized", { telegram_id: String(ctx.from?.id || 0) }), show_alert: true }).catch(() => {});
          return;
        }
        ctx.answerCallbackQuery().catch(() => {});
        await createUsersExportHandler(userDao.db, userDao, subDao)(ctx);
      }
    )
    .row()
    .text(
      (ctx) => ctx.t("admin.btn_export_history"),
      async (ctx) => {
        if (!isUserAdmin(ctx.from?.id, userDao, ctx.from?.username)) {
          ctx.answerCallbackQuery({ text: ctx.t("admin.unauthorized", { telegram_id: String(ctx.from?.id || 0) }), show_alert: true }).catch(() => {});
          return;
        }
        ctx.answerCallbackQuery().catch(() => {});
        await createHistoryExportHandler(userDao.db, userDao)(ctx);
      }
    )
    .row()
    .text(
      (ctx) => ctx.t("admin.btn_backup"),
      async (ctx) => {
        if (!isUserAdmin(ctx.from?.id, userDao, ctx.from?.username)) {
          ctx.answerCallbackQuery({ text: ctx.t("admin.unauthorized", { telegram_id: String(ctx.from?.id || 0) }), show_alert: true }).catch(() => {});
          return;
        }
        ctx.answerCallbackQuery().catch(() => {});
        await createBackupHandler(userDao.db, userDao, subDao)(ctx);
      }
    )
    .row()
    .text(
      (ctx) => ctx.t("common.refresh"),
      async (ctx) => {
        if (!isUserAdmin(ctx.from?.id, userDao, ctx.from?.username)) {
          ctx.answerCallbackQuery({ text: ctx.t("admin.unauthorized", { telegram_id: String(ctx.from?.id || 0) }), show_alert: true }).catch(() => {});
          return;
        }
        ctx.answerCallbackQuery({ text: ctx.t("common.refreshed_toast"), show_alert: false }).catch(() => {});
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
      (ctx) =>
        (ctx.user.is_muted ?? 0) === 1
          ? ctx.t("subscriptions.btn_toggle_sound_off")
          : ctx.t("subscriptions.btn_toggle_sound_on"),
      async (ctx) => {
        const val = userDao.toggleMute(ctx.from!.id);
        ctx.user.is_muted = val;
        invertedIndex.updateUserPreferences(ctx.from!.id, {
          isMuted: val === 1,
        });
        const toast =
          val === 1
            ? ctx.t("subscriptions.toast_sound_muted")
            : ctx.t("subscriptions.toast_sound_enabled");
        ctx.answerCallbackQuery(toast).catch(() => {});
        await safeEditMessageText(ctx, renderSettingsText(ctx));
      }
    )
    .row()
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
      for (const pool of summaries) {
        const badge = computePoolBadgeInfo(pool.available_count, pool.total_blocks);
        range
          .text(`${badge.icon} ${pool.name} [${badge.shortStatus}]`, async (c) => {
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
        const startTime = Date.now();
        ctx.answerCallbackQuery({
          text: ctx.t("common.refreshed_toast"),
          show_alert: false,
        }).catch(() => {});
        if (scraper) {
          await scraper.forceRefresh(3000);
        }
        const telemetry = scraper?.getTelemetry();
        const scrapeLatency = telemetry?.lastScrapeLatencyMs || 0;
        const rendered = renderDashboardText(ctx, poolStateDao, historyDao, scraper);
        const tgStartTime = Date.now();
        await safeEditMessageText(ctx, rendered);
        const tgEditLatency = Date.now() - tgStartTime;
        const totalE2E = Date.now() - startTime;
        const username = ctx.from?.username ? `@${ctx.from.username}` : `ID:${ctx.from?.id}`;
        const proxyTag = telemetry?.lastUsedProxy
          ? (telemetry.lastUsedProxy.includes("9050") ? "🧅 Tor SOCKS5" : "🌐 Proxy")
          : "⚡ Direct";
        console.log(`🔄 [Manual Refresh] User ${username} on Dashboard -> Scrape: ${scrapeLatency}ms (${proxyTag}) | TG Edit: ${tgEditLatency}ms | Total E2E: ${totalE2E}ms (source: ${telemetry?.lastSource || "cache"})`);
        if (ctx.chat) {
          const msgId = ctx.callbackQuery?.message?.message_id;
          if (msgId) {
            dashboardRegistry?.register(ctx.chat.id, msgId, ctx.user.id, ctx.lang, "dashboard");
          }
        }
        try { ctx.menu.update(); } catch {}
      }
    )
    .row()
    .text(
      (ctx) => ctx.t("menu.btn_settings"),
      async (ctx) => {
        ctx.answerCallbackQuery().catch(() => {});
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
