import { Bot, session, InlineKeyboard } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { BotContext, SessionData } from "../types/context.js";
import { UserDAO } from "../db/dao/users.js";
import { SubscriptionDAO } from "../db/dao/subscriptions.js";
import { PoolStateDAO } from "../db/dao/poolState.js";
import { NotificationLogDAO } from "../db/dao/notificationLogs.js";
import { SlotHistoryDAO } from "../db/dao/slotHistory.js";
import { ScraperOrchestrator } from "../engine/scraperOrchestrator.js";
import { ProxyPool } from "../proxy/proxyPool.js";
import {
  createMainMenuHierarchy,
  renderDashboardText,
  renderHelpText,
} from "./menus/mainDashboard.js";
import { renderSubscriptionsText } from "./menus/subscriptions.js";
import { createStartHandler } from "./handlers/start.js";
import { createLanguageHandler } from "./handlers/language.js";
import { createAdminHandler, renderAdminText, createAdminKeyboard } from "./handlers/admin.js";
import {
  renderBroadcastStagingText,
  renderBroadcastPromptText,
  renderBroadcastPreview,
  renderBroadcastPreflight,
  renderBroadcastModalConfirm,
  getOrCreateBroadcastSession,
  resetBroadcastSession,
} from "./handlers/adminBroadcast.js";
import { extractMessageContent } from "./notifier/telegramEntitySerializer.js";
import { UserActivitySyncer } from "./notifier/userActivitySyncer.js";
import { createBackupHandler, createUsersExportHandler, createHistoryExportHandler } from "./handlers/backup.js";
import { NotificationDispatcher } from "./notifier/dispatcher.js";
import { config, isUserAdmin } from "../config/env.js";
import {
  translate,
  resolveDefaultLanguage,
  getLanguageFlag,
  escapeHtml,
  SupportedLanguage,
} from "../i18n/index.js";

import { ActiveDashboardDAO } from "../db/dao/activeDashboards.js";
import { DonationDAO } from "../db/dao/donations.js";
import { NotificationOutboxDAO } from "../db/dao/notificationOutbox.js";
import { LiveDashboardManager } from "./liveSync/liveDashboardManager.js";
import { ActiveDashboardRegistry } from "./liveSync/dashboardRegistry.js";
import { icon } from "./views/iconTheme.js";
import { renderDonateText } from "./views/donateView.js";
import { safeEditMessageText } from "./views/common.js";

export function createTelegramBot(
  token: string,
  userDao: UserDAO,
  subDao: SubscriptionDAO,
  poolStateDao: PoolStateDAO,
  logDao: NotificationLogDAO,
  scraper: ScraperOrchestrator,
  proxyPool: ProxyPool,
  historyDao?: SlotHistoryDAO,
  activeDashboardDao?: ActiveDashboardDAO,
  donationDao?: DonationDAO,
  outboxDao?: NotificationOutboxDAO
): {
  bot: Bot<BotContext>;
  dispatcher: NotificationDispatcher;
  liveDashboardManager: LiveDashboardManager;
  donationDao: DonationDAO;
  outboxDao: NotificationOutboxDAO;
} {
  const bot = new Bot<BotContext>(token, {
    client: config.TELEGRAM_API_ROOT
      ? {
          apiRoot: config.TELEGRAM_API_ROOT,
        }
      : undefined,
  });
  const resolvedHistoryDao = historyDao;
  const resolvedDonationDao = donationDao || new DonationDAO(userDao.db);
  const resolvedOutboxDao = outboxDao || new NotificationOutboxDAO(userDao.db);

  // 1. Global Error Boundary
  bot.catch((err) => {
    const ctx = err.ctx;
    const errAny = err.error as any;
    const msg =
      errAny?.message ||
      errAny?.description ||
      String(err.error || "");
    if (
      msg.includes("message is not modified") ||
      msg.includes("query is too old")
    ) {
      return; // Ignore benign Telegram responses
    }
    console.error(
      `❌ [Telegram Bot Error] Error while handling update ${ctx.update.update_id}:`,
      err.error
    );
  });

  // 2. Auto-retry plugin for flood control
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));

  // 3. In-memory session middleware
  bot.use(
    session({
      initial: (): SessionData => ({}),
    })
  );

  // 4. Shared Notification Dispatcher with In-Memory Inverted Index & SQLite Outbox
  const dispatcher = new NotificationDispatcher(
    bot,
    userDao,
    logDao,
    resolvedHistoryDao,
    undefined,
    undefined,
    resolvedOutboxDao
  );

  // 4b. Debounced Trailing 30-Second Activity Syncer (Immediate RAM + 30s Debounced Disk Write)
  const userActivitySyncer = new UserActivitySyncer(userDao, dispatcher.getInvertedIndex());

  // Helper function: Admin verification guard
  const requireAdmin = async (ctx: BotContext): Promise<boolean> => {
    if (!isUserAdmin(ctx.from?.id, userDao, ctx.from?.username)) {
      const plainUnauthorized =
        ctx.lang === "uk"
          ? `⛔ Доступ обмежено. Команда лише для адміністраторів.\nВаш Telegram ID: ${ctx.from?.id || "N/A"}`
          : ctx.lang === "ru"
          ? `⛔ Доступ ограничен. Команда только для администраторов.\nВаш Telegram ID: ${ctx.from?.id || "N/A"}`
          : `⛔ Access restricted to administrators only.\nYour Telegram ID: ${ctx.from?.id || "N/A"}`;

      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: plainUnauthorized, show_alert: true }).catch(() => {});
      } else {
        await ctx.reply(plainUnauthorized).catch(() => {});
      }
      return false;
    }
    return true;
  };

  // 5. User context loader & universal language resolution
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      let user = userDao.getByTelegramId(ctx.from.id);
      let isBrandNew = false;
      const now = Date.now();

      if (!user) {
        const lang = resolveDefaultLanguage(ctx.from.language_code);
        user = userDao.upsertUser({
          telegram_id: ctx.from.id,
          username: ctx.from.username ?? null,
          first_name: ctx.from.first_name,
          language: lang,
        });
        (ctx as any).isNewUser = true;
        isBrandNew = true;

        const isAdmin = isUserAdmin(ctx.from.id, userDao, ctx.from.username);
        // Register in In-Memory Inverted Index immediately
        dispatcher.getInvertedIndex().upsertUserProfile({
          userId: user.id,
          telegramId: user.telegram_id,
          language: lang,
          isMuted: false,
          isActive: true,
          isAdmin,
          totalDonatedStars: (user as any).total_donated_stars || 0,
          notifyAvailableGlobal: true,
          notifySoldOutGlobal: false,
          notifyModelsGlobal: true,
          notifyPricesGlobal: true,
          lastActiveAt: now,
        });
      } else {
        // Self-healing: if user exists in DB but not in RAM index (e.g. edge-case cache miss or re-hydration)
        let inMemoryProfile = dispatcher.getInvertedIndex().getProfileByTgId(ctx.from.id);
        const isAdmin = (user.is_admin ?? 0) === 1 || isUserAdmin(ctx.from.id, userDao, ctx.from.username);
        if (!inMemoryProfile) {
          dispatcher.getInvertedIndex().upsertUserProfile({
            userId: user.id,
            telegramId: user.telegram_id,
            language: (user.language as SupportedLanguage) || "en",
            isMuted: (user.is_muted ?? 0) === 1,
            isActive: (user.is_active ?? 1) === 1,
            isAdmin,
            totalDonatedStars: (user as any).total_donated_stars || 0,
            notifyAvailableGlobal: (user.notify_available_global ?? 1) === 1,
            notifySoldOutGlobal: (user.notify_sold_out_global ?? 0) === 1,
            notifyModelsGlobal: (user.notify_models_global ?? 1) === 1,
            notifyPricesGlobal: (user.notify_prices_global ?? 1) === 1,
            lastActiveAt: now,
          });
          inMemoryProfile = dispatcher.getInvertedIndex().getProfileByTgId(ctx.from.id);
        }

        // 30-Second Debounced Trailing Activity Syncer (Immediate RAM + 30s Trailing Disk Write)
        userActivitySyncer.touch(ctx.from.id, now);
        dispatcher.getInvertedIndex().updateUserPreferences(ctx.from.id, {
          lastActiveAt: now,
          language: user.language as any,
          isAdmin,
          totalDonatedStars: (user as any).total_donated_stars || 0,
        });

        if (user.is_active === 0) {
          userDao.reactivateUser(ctx.from.id);
          user.is_active = 1;
          dispatcher.getInvertedIndex().updateUserPreferences(ctx.from.id, { isActive: true });
          const userSubs = subDao.getSubscriptionsForUser(user.id);
          for (const s of userSubs) {
            dispatcher.getInvertedIndex().updateSubscription(user.id, s.pool_slug, s.block_id, {
              available: s.notify_on_available === 1,
              soldOut: s.notify_on_sold_out === 1,
              models: s.notify_on_models === 1,
              prices: s.notify_on_prices === 1,
            });
          }
        }
      }

      ctx.user = user;
      ctx.lang = (user.language as SupportedLanguage) || "en";

      // 6. Notify Admins on New User Registration (if enabled & user is NOT an admin)
      if (isBrandNew && !isUserAdmin(ctx.from.id, userDao, ctx.from.username)) {
        const userStats = userDao.getUserStats();
        const usernameStr = ctx.from.username ? `@${escapeHtml(ctx.from.username)}` : "—";
        const allAdminIds = userDao.getAllAdminTelegramIds(config.ADMIN_USER_IDS);

        for (const adminId of allAdminIds) {
          if (adminId === ctx.from.id) continue;

          const adminUser = userDao.getByTelegramId(adminId);
          const wantsAlerts = (adminUser?.notify_admin_new_users ?? 1) === 1;

          if (wantsAlerts) {
            const adminLang = (adminUser?.language as SupportedLanguage) || "uk";
            const flag = getLanguageFlag(ctx.lang);
            const langStr = `${ctx.lang.toUpperCase()} ${flag}`;
            const adminMsg = translate(adminLang, "admin.new_user_alert", {
              first_name: escapeHtml(ctx.from.first_name),
              username: usernameStr,
              telegram_id: String(ctx.from.id),
              language: langStr,
              total_users: String(userStats.total),
            });

            bot.api
              .sendMessage(adminId, adminMsg, { parse_mode: "HTML" })
              .catch(() => {});
          }
        }
      }
    }
    await next();
  });

  // 7. i18n Translation helper attached to context & interaction touch
  const activeDashboardRegistry = new ActiveDashboardRegistry(activeDashboardDao);

  bot.use(async (ctx, next) => {
    ctx.t = (key: string, params?: Record<string, string | number>) => {
      return translate(ctx.lang, key, params);
    };
    if (ctx.chat?.id) {
      activeDashboardRegistry.touchInteraction(ctx.chat.id);
    }
    await next();
  });

  // 8. Register Menus
  const { mainDashboardMenu, poolDetailMenu, subscriptionsMenu, languageMenu, settingsMenu, donateMenu } =
    createMainMenuHierarchy(
      poolStateDao,
      userDao,
      subDao,
      dispatcher.getInvertedIndex(),
      resolvedHistoryDao,
      scraper,
      activeDashboardRegistry,
      proxyPool,
      dispatcher,
      userActivitySyncer
    );

  // 8b. Auto-capture & Touch Active Dashboard on any callback query interaction
  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery && ctx.chat && ctx.from) {
      const msgId = ctx.callbackQuery.message?.message_id;
      if (msgId) {
        const session = activeDashboardRegistry.get(ctx.chat.id);
        if (!session) {
          activeDashboardRegistry.register(
            ctx.chat.id,
            msgId,
            ctx.user?.id || ctx.from.id,
            ctx.lang,
            "dashboard"
          );
        } else {
          if (session.messageId !== msgId) {
            session.messageId = msgId;
          }
          activeDashboardRegistry.touchInteraction(ctx.chat.id);
        }
      }
    }
    await next();
  });

  bot.use(mainDashboardMenu);

  // 9. Live Auto-Updating Dashboard Manager
  const liveDashboardManager = new LiveDashboardManager(
    bot,
    poolStateDao,
    subDao,
    scraper,
    mainDashboardMenu,
    poolDetailMenu,
    resolvedHistoryDao,
    { registry: activeDashboardRegistry }
  );

  // Reset custom stars donation and staging states on any slash command
  bot.use(async (ctx, next) => {
    if (ctx.message?.text?.startsWith("/") && ctx.session) {
      ctx.session.waitingForCustomStars = false;
      ctx.session.pendingCustomStars = undefined;
      ctx.session.fromSettings = undefined;
      if (ctx.session.broadcast?.stage === "awaiting_text") {
        ctx.session.broadcast.stage = "idle";
      }
    }
    await next();
  });

  // 10. Command Handlers
  bot.command(
    "start",
    createStartHandler(
      userDao,
      poolStateDao,
      languageMenu,
      mainDashboardMenu,
      resolvedHistoryDao,
      subDao,
      subscriptionsMenu,
      poolDetailMenu,
      scraper,
      liveDashboardManager
    )
  );

  bot.command("menu", async (ctx) => {
    const text = renderDashboardText(ctx, poolStateDao, resolvedHistoryDao, scraper);
    const msg = await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: mainDashboardMenu,
      link_preview_options: { is_disabled: true },
    });
    if (ctx.chat && ctx.from) {
      liveDashboardManager.getRegistry().register(
        ctx.chat.id,
        msg.message_id,
        ctx.user.id,
        ctx.lang,
        "dashboard"
      );
    }
  });

  bot.command(["alerts", "subscriptions"], async (ctx) => {
    const text = renderSubscriptionsText(ctx, subDao);
    const msg = await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: subscriptionsMenu,
      link_preview_options: { is_disabled: true },
    });
    if (ctx.chat && ctx.from) {
      liveDashboardManager.getRegistry().register(
        ctx.chat.id,
        msg.message_id,
        ctx.user.id,
        ctx.lang,
        "subscriptions"
      );
    }
  });

  bot.command("language", createLanguageHandler(languageMenu));

  bot.command("help", async (ctx) => {
    const text = renderHelpText(ctx);
    const keyboard = new InlineKeyboard().text(
      ctx.t("common.back_to_menu"),
      "nav_dashboard"
    );
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
  });

  bot.command("donate", async (ctx) => {
    if (!ctx.from) return;
    const profile = dispatcher.getInvertedIndex().getProfileByTgId(ctx.from.id);
    const totalStars = profile?.totalDonatedStars || 0;
    const text = renderDonateText(ctx, totalStars);
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: donateMenu,
      link_preview_options: { is_disabled: true },
    });
  });

  bot.command(
    "admin",
    createAdminHandler(
      userDao,
      subDao,
      scraper,
      proxyPool,
      dispatcher.getInvertedIndex()
    )
  );

  bot.command("stats", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const handler = createAdminHandler(
      userDao,
      subDao,
      scraper,
      proxyPool,
      dispatcher.getInvertedIndex()
    );
    await handler(ctx);
  });

  bot.command("backup", createBackupHandler(userDao.db, userDao, subDao, userActivitySyncer));
  bot.command("export_users", createUsersExportHandler(userDao.db, userDao, subDao, userActivitySyncer));
  bot.command("export_history", createHistoryExportHandler(userDao.db, userDao));

  bot.command("testalert", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    if (!ctx.from) return;
    await dispatcher.sendTestAlert(ctx.from.id, ctx.lang, "bundle");
    await ctx.reply("🚀 Test alert dispatched!").catch(() => {});
  });

  bot.callbackQuery("nav_dashboard", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const text = renderDashboardText(ctx, poolStateDao, resolvedHistoryDao, scraper);
    await safeEditMessageText(ctx, text, {
      reply_markup: mainDashboardMenu,
      link_preview_options: { is_disabled: true },
    });
  });

  // 11. Admin Panel & Broadcast Callbacks
  bot.callbackQuery(["admin_refresh", "admin_bc_cancel"], async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!(await requireAdmin(ctx))) return;
    const text = renderAdminText(ctx, userDao, subDao, scraper, proxyPool);
    const keyboard = createAdminKeyboard(ctx, userDao);
    await safeEditMessageText(ctx, text, { reply_markup: keyboard });
  });

  bot.callbackQuery(["admin_backup", "admin_backup_sqlite"], async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!(await requireAdmin(ctx))) return;
    const handler = createBackupHandler(userDao.db, userDao, subDao, userActivitySyncer);
    await handler(ctx);
  });

  bot.callbackQuery("admin_export_users", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!(await requireAdmin(ctx))) return;
    const handler = createUsersExportHandler(userDao.db, userDao, subDao, userActivitySyncer);
    await handler(ctx);
  });

  bot.callbackQuery("admin_export_history", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!(await requireAdmin(ctx))) return;
    const handler = createHistoryExportHandler(userDao.db, userDao);
    await handler(ctx);
  });

  bot.callbackQuery("admin_toggle_new_users", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    if (!ctx.from) return;
    const newVal = userDao.toggleAdminNewUsers(ctx.from.id);
    await ctx.answerCallbackQuery({
      text: newVal === 1 ? ctx.t("admin.toast_new_users_on") : ctx.t("admin.toast_new_users_off"),
    }).catch(() => {});
    const text = renderAdminText(ctx, userDao, subDao, scraper, proxyPool);
    const keyboard = createAdminKeyboard(ctx, userDao);
    await safeEditMessageText(ctx, text, { reply_markup: keyboard });
  });

  bot.callbackQuery("admin_test_alert", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    if (!ctx.from) return;
    await ctx.answerCallbackQuery({ text: ctx.t("admin.toast_test_alert_sent") }).catch(() => {});
    await dispatcher.sendTestAlert(ctx.from.id, ctx.lang, "bundle");
  });

  bot.callbackQuery("admin_open_settings", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const text = ctx.t("settings.title", {
      current_lang: ctx.lang.toUpperCase(),
      telegram_id: String(ctx.from?.id || "N/A"),
    });
    await safeEditMessageText(ctx, text, { reply_markup: settingsMenu });
  });

  bot.callbackQuery("admin_open_dashboard", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const text = renderDashboardText(ctx, poolStateDao, resolvedHistoryDao, scraper);
    await safeEditMessageText(ctx, text, {
      reply_markup: mainDashboardMenu,
      link_preview_options: { is_disabled: true },
    });
  });

  // Admin Broadcast FSM & Callback Routers
  bot.callbackQuery(["admin_broadcast", "admin_open_broadcast", "admin_bc_hub"], async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!(await requireAdmin(ctx))) return;
    const session = getOrCreateBroadcastSession(ctx);
    session.stage = "language_select";
    const staging = renderBroadcastStagingText(ctx, userDao, dispatcher);
    await safeEditMessageText(ctx, staging.text, { reply_markup: staging.keyboard });
  });

  bot.callbackQuery(/^admin_bc_edit:([a-z]{2})$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!(await requireAdmin(ctx))) return;
    const lang = ctx.match[1] as SupportedLanguage;
    const session = getOrCreateBroadcastSession(ctx);
    session.activeEditLang = lang;
    session.stage = "awaiting_text";

    const promptText = renderBroadcastPromptText(lang, ctx);
    const cancelKb = new InlineKeyboard().text(ctx.t("common.back"), "admin_bc_hub");
    await safeEditMessageText(ctx, promptText, { reply_markup: cancelKb });
  });

  bot.callbackQuery("admin_bc_toggle_silent", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const session = getOrCreateBroadcastSession(ctx);
    session.sendSilent = !session.sendSilent;
    await ctx.answerCallbackQuery({
      text: session.sendSilent
        ? ctx.t("admin.broadcast.toast_silent_on")
        : ctx.t("admin.broadcast.toast_silent_off"),
    }).catch(() => {});
    const staging = renderBroadcastStagingText(ctx, userDao, dispatcher);
    await safeEditMessageText(ctx, staging.text, { reply_markup: staging.keyboard });
  });

  bot.callbackQuery(/^admin_bc_confirm_draft:([a-z]{2})$/, async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const lang = ctx.match[1] as SupportedLanguage;
    const session = getOrCreateBroadcastSession(ctx);
    if (session.drafts[lang]) {
      session.drafts[lang]!.isConfirmed = true;
      await ctx.answerCallbackQuery({
        text: ctx.t("admin.broadcast.toast_draft_saved", { lang: lang.toUpperCase() }),
      }).catch(() => {});
    }
    const staging = renderBroadcastStagingText(ctx, userDao, dispatcher);
    await safeEditMessageText(ctx, staging.text, { reply_markup: staging.keyboard });
  });

  bot.callbackQuery(/^admin_bc_test_self:([a-z]{2})$/, async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const lang = ctx.match[1] as SupportedLanguage;
    const session = getOrCreateBroadcastSession(ctx);
    const draft = session.drafts[lang];
    if (!draft || !ctx.from) return;
    await ctx.answerCallbackQuery({
      text: ctx.t("admin.broadcast.toast_test_sent", { lang: lang.toUpperCase() }),
    }).catch(() => {});
    if (draft.mediaType === "photo" && draft.fileId) {
      await bot.api.sendPhoto(ctx.from.id, draft.fileId, { caption: draft.htmlText, parse_mode: "HTML" }).catch(() => {});
    } else if (draft.mediaType === "video" && draft.fileId) {
      await bot.api.sendVideo(ctx.from.id, draft.fileId, { caption: draft.htmlText, parse_mode: "HTML" }).catch(() => {});
    } else {
      await bot.api.sendMessage(ctx.from.id, draft.htmlText, { parse_mode: "HTML" }).catch(() => {});
    }
  });

  bot.callbackQuery("admin_bc_test_all", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const session = getOrCreateBroadcastSession(ctx);
    if (!ctx.from) return;
    let count = 0;
    for (const lang of ["uk", "en", "ru"] as SupportedLanguage[]) {
      const draft = session.drafts[lang];
      if (draft) {
        const prefix = `[Test ${lang.toUpperCase()}]\n\n`;
        if (draft.mediaType === "photo" && draft.fileId) {
          await bot.api.sendPhoto(ctx.from.id, draft.fileId, { caption: prefix + draft.htmlText, parse_mode: "HTML" }).catch(() => {});
        } else {
          await bot.api.sendMessage(ctx.from.id, prefix + draft.htmlText, { parse_mode: "HTML" }).catch(() => {});
        }
        count++;
      }
    }
    await ctx.answerCallbackQuery({
      text: ctx.t("admin.broadcast.toast_test_all_sent", { count: String(count) }),
    }).catch(() => {});
  });

  bot.callbackQuery("admin_bc_clear", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    resetBroadcastSession(ctx);
    await ctx.answerCallbackQuery({ text: ctx.t("admin.broadcast.toast_cleared") }).catch(() => {});
    const staging = renderBroadcastStagingText(ctx, userDao, dispatcher);
    await safeEditMessageText(ctx, staging.text, { reply_markup: staging.keyboard });
  });

  bot.callbackQuery("admin_bc_staging_noop", async (ctx) => {
    await ctx.answerCallbackQuery({
      text: ctx.t("admin.broadcast.toast_noop_warning"),
      show_alert: true,
    }).catch(() => {});
  });

  bot.callbackQuery("admin_bc_preflight", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!(await requireAdmin(ctx))) return;
    const session = getOrCreateBroadcastSession(ctx);
    session.stage = "preview";
    const preflight = renderBroadcastPreflight(ctx, dispatcher);
    await safeEditMessageText(ctx, preflight.text, { reply_markup: preflight.keyboard });
  });

  bot.callbackQuery("admin_bc_modal_confirm", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!(await requireAdmin(ctx))) return;
    const modal = renderBroadcastModalConfirm(ctx, dispatcher);
    await safeEditMessageText(ctx, modal.text, { reply_markup: modal.keyboard });
  });

  bot.callbackQuery("admin_bc_execute", async (ctx) => {
    await ctx.answerCallbackQuery({ text: ctx.t("admin.broadcast.toast_broadcast_started") }).catch(() => {});
    if (!(await requireAdmin(ctx))) return;

    const session = getOrCreateBroadcastSession(ctx);
    const res = await dispatcher.dispatchBroadcastBatch(session.drafts, {
      sendSilent: session.sendSilent,
      filter: session.filter || "active_only",
    });

    resetBroadcastSession(ctx);

    const finishText = ctx.t("admin.broadcast.toast_success", { count: String(res.totalEnqueued) });
    const kb = new InlineKeyboard().text(ctx.t("common.back"), "admin_refresh");
    await safeEditMessageText(ctx, finishText, { reply_markup: kb });
  });

  // 12. Telegram Stars Payment Pipeline
  bot.on("pre_checkout_query", async (ctx) => {
    try {
      await ctx.answerPreCheckoutQuery(true);
    } catch (err: any) {
      console.error("❌ [Payment Error] pre_checkout_query answer failed:", err);
      await ctx.answerPreCheckoutQuery(false, {
        error_message: ctx.t("donate.checkout_failed"),
      }).catch(() => {});
    }
  });

  bot.on(":successful_payment", async (ctx) => {
    const payment = ctx.message?.successful_payment;
    if (!payment || !ctx.from || !ctx.user) return;

    const stars = payment.total_amount;
    const currency = payment.currency;
    const chargeId = payment.telegram_payment_charge_id;
    const providerChargeId = payment.provider_payment_charge_id;

    resolvedDonationDao.recordDonation(
      ctx.user.id,
      ctx.from.id,
      stars,
      chargeId,
      providerChargeId
    );

    userDao.addDonatedStars(ctx.user.id, stars);
    dispatcher.getInvertedIndex().addDonationStars(ctx.user.id, stars);

    const userRecord = userDao.getByTelegramId(ctx.from.id);
    const userTotalStars = userRecord?.total_donated_stars || stars;

    await ctx.reply(ctx.t("donate.success_message", { stars: String(stars), total_stars: String(userTotalStars) }), {
      parse_mode: "HTML",
    });

    const allAdmins = userDao.getAllAdminTelegramIds(config.ADMIN_USER_IDS);
    const userName = ctx.from.username
      ? `@${ctx.from.username}`
      : `${escapeHtml(ctx.from.first_name || "")}`;

    const adminNoticePromises = allAdmins.map(async (adminTgId) => {
      if (adminTgId === ctx.from?.id) return;
      const adminRecord = userDao.getByTelegramId(adminTgId);
      if (adminRecord && adminRecord.notify_admin_new_users === 1) {
        const adminText = translate(adminRecord.language, "donate.admin_alert", {
          user_name: userName,
          telegram_id: String(ctx.from?.id),
          stars: String(stars),
          total_stars: String(userTotalStars),
          charge_id: chargeId,
        });
        await bot.api.sendMessage(adminTgId, adminText, { parse_mode: "HTML" }).catch(() => {});
      }
    });

    await Promise.allSettled(adminNoticePromises);
  });

  // 12.1 Admin Broadcast Message Input Interceptor
  bot.on(
    ["message:text", "message:photo", "message:video", "message:document", "message:animation"],
    async (ctx, next) => {
      const bSession = ctx.session?.broadcast;
      if (bSession && bSession.stage === "awaiting_text" && bSession.activeEditLang) {
        if (!isUserAdmin(ctx.from?.id, userDao, ctx.from?.username)) {
          return next();
        }

        const lang = bSession.activeEditLang;
        const extracted = extractMessageContent(ctx.message);

        if (!extracted.rawText || extracted.rawText.trim().length === 0) {
          await ctx.reply(ctx.t("admin.broadcast.toast_empty_input"));
          return;
        }

        if (extracted.mediaType !== "text" && extracted.rawText.length > 1024) {
          await ctx.reply(
            ctx.t("admin.broadcast.error_caption_too_long", { len: String(extracted.rawText.length) }),
            { parse_mode: "HTML" }
          );
          return;
        }

        bSession.drafts[lang] = {
          htmlText: extracted.html,
          rawText: extracted.rawText,
          entitiesCount: extracted.entitiesCount,
          hasCustomEmoji: extracted.hasCustomEmoji,
          mediaType: extracted.mediaType,
          fileId: extracted.fileId,
          createdAt: Date.now(),
          isConfirmed: false,
        };

        bSession.stage = "preview";

        const preview = renderBroadcastPreview(ctx, lang, dispatcher);
        await ctx.reply(preview.text, {
          parse_mode: "HTML",
          reply_markup: preview.keyboard,
          link_preview_options: { is_disabled: true },
        });
        return;
      }
      return next();
    }
  );

  // 13. Custom Stars Input & Confirmation Flow
  bot.on("message:text", async (ctx, next) => {
    if (ctx.session?.waitingForCustomStars) {
      const text = ctx.message.text.trim();
      const num = parseInt(text, 10);
      if (isNaN(num) || num < 1 || num > 10000 || !/^\d+$/.test(text)) {
        const cancelKeyboard = new InlineKeyboard().text(
          ctx.t("common.back"),
          "donate_cancel_custom"
        );
        await ctx.reply(ctx.t("donate.error_invalid_custom_stars", { star_icon: icon("star") }), {
          parse_mode: "HTML",
          reply_markup: cancelKeyboard,
        });
        return;
      }

      ctx.session.waitingForCustomStars = false;
      ctx.session.pendingCustomStars = num;

      const confirmText = ctx.t("donate.confirm_custom_stars_title", { stars: String(num), star_icon: icon("star") });
      const keyboard = new InlineKeyboard()
        .text(ctx.t("donate.btn_confirm_pay"), `confirm_custom_stars:${num}`)
        .row()
        .text(ctx.t("donate.btn_cancel"), "donate_cancel_custom");

      await ctx.reply(confirmText, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      return;
    }
    return next();
  });

  bot.callbackQuery(/^confirm_custom_stars:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const stars = parseInt(ctx.match[1], 10);
    if (isNaN(stars) || stars <= 0) return;

    ctx.session.waitingForCustomStars = false;
    ctx.session.pendingCustomStars = undefined;

    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});

      const title = ctx.t("donate.invoice_title", { stars: String(stars) });
      const desc = ctx.t("donate.invoice_desc", { stars: String(stars) });
      const payload = JSON.stringify({
        userId: ctx.user.id,
        telegramId: ctx.from?.id,
        stars,
        ts: Date.now(),
      });
      await ctx.replyWithInvoice(
        title,
        desc,
        payload,
        "XTR",
        [{ label: ctx.t("donate.invoice_label", { stars: String(stars) }), amount: stars }]
      );
    } catch (err) {
      console.error("❌ [Telegram Stars Custom Invoice Error]:", err);
    }
  });

  bot.callbackQuery("donate_cancel_custom", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    ctx.session.waitingForCustomStars = false;
    ctx.session.pendingCustomStars = undefined;

    if (ctx.chat) {
      activeDashboardRegistry.updateView(ctx.chat.id, "other");
    }

    const profile = dispatcher.getInvertedIndex().getProfileByTgId(ctx.from?.id || 0);
    const totalStars = profile?.totalDonatedStars || 0;
    await safeEditMessageText(ctx, renderDonateText(ctx, totalStars), { reply_markup: donateMenu });
  });

  // 14. Wire Scraper diff_events to dispatcher
  scraper.on("diff_events", async (events) => {
    try {
      await dispatcher.handleDiffEvents(events);
    } catch (err: any) {
      console.error("❌ [NotificationDispatcher] Error handling diff events:", err?.message || err);
    }
  });

  // 15. Register Localized Bot Commands Menu in Telegram Client
  bot.api
    .setMyCommands(
      [
        { command: "start", description: "Головне меню та моніторинг слотів" },
        { command: "menu", description: "Відкрити дашборд доступності" },
        { command: "alerts", description: "Керування підписками та фільтрами" },
        { command: "language", description: "Змінити мову інтерфейсу" },
        { command: "help", description: "Інструкція та контакт автора" },
        { command: "admin", description: "Панель адміністратора & керування" },
        { command: "stats", description: "Телеметрія системи (Admin)" },
        { command: "backup", description: "Завантажити бекап бази (Admin)" },
      ],
      { language_code: "uk" }
    )
    .catch(() => {});

  bot.api
    .setMyCommands(
      [
        { command: "start", description: "Главное меню и мониторинг слотов" },
        { command: "menu", description: "Открыть дашборд доступности" },
        { command: "alerts", description: "Управление подписками и фильтрами" },
        { command: "language", description: "Сменить язык интерфейса" },
        { command: "help", description: "Инструкция и контакт автора" },
        { command: "admin", description: "Панель администратора & управление" },
        { command: "stats", description: "Телеметрия системы (Admin)" },
        { command: "backup", description: "Скачать бэкап базы (Admin)" },
      ],
      { language_code: "ru" }
    )
    .catch(() => {});

  bot.api
    .setMyCommands([
      { command: "start", description: "Main dashboard & live slot monitor" },
      { command: "menu", description: "Open slot availability dashboard" },
      { command: "alerts", description: "Manage subscriptions & alert filters" },
      { command: "language", description: "Change language / Змінити мову" },
      { command: "help", description: "How the bot works & author contact" },
      { command: "admin", description: "Administrator control panel" },
      { command: "stats", description: "System telemetry (Admin)" },
      { command: "backup", description: "Download SQLite database backup (Admin)" },
    ])
    .catch(() => {});

  return { bot, dispatcher, liveDashboardManager, donationDao: resolvedDonationDao, outboxDao: resolvedOutboxDao };
}
