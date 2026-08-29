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
): { bot: Bot<BotContext>; dispatcher: NotificationDispatcher; liveDashboardManager: LiveDashboardManager; donationDao: DonationDAO; outboxDao: NotificationOutboxDAO } {
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

  // Helper function: Admin verification guard
  const requireAdmin = async (ctx: BotContext): Promise<boolean> => {
    if (!isUserAdmin(ctx.from?.id, userDao, ctx.from?.username)) {
      const plainUnauthorized =
        ctx.lang === "uk"
          ? `⛔ Доступ обмежено. Команда лише для адміністраторів.\nВаш Telegram ID: ${ctx.from?.id || "N/A"}`
          : ctx.lang === "ru"
          ? `⛔ Доступ ограничен. Команда только для администраторов.\nВаш Telegram ID: ${ctx.from?.id || "N/A"}`
          : `⛔ Access restricted to administrators only.\nYour Telegram ID: ${ctx.from?.id || "N/A"}`;

      await ctx.answerCallbackQuery({
        text: plainUnauthorized,
        show_alert: true,
      }).catch(() => {});
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

        // Throttled DB disk touch (every 5 mins) to eliminate SQLite write serialization
        const lastTouch = inMemoryProfile?.lastDbTouchAt || 0;
        if (now - lastTouch > 5 * 60 * 1000) {
          userDao.touchLastActive(ctx.from.id);
          if (inMemoryProfile) inMemoryProfile.lastDbTouchAt = now;
        }
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
        }
      }

      ctx.user = user;
      ctx.lang = (user.language as SupportedLanguage) || "en";

      // 6. Notify Admins on New User Registration (if enabled & user is NOT an admin)
      if (isBrandNew && !isUserAdmin(ctx.from.id, userDao, ctx.from.username)) {
        const userStats = userDao.getUserStats();
        const usernameStr = ctx.from.username ? `@${escapeHtml(ctx.from.username)}` : "—";
        const langFlag = getLanguageFlag(ctx.lang);
        const allAdminIds = userDao.getAllAdminTelegramIds(config.ADMIN_USER_IDS);

        for (const adminId of allAdminIds) {
          if (adminId === ctx.from.id) continue;

          const adminUser = userDao.getByTelegramId(adminId);
          const wantsAlerts = (adminUser?.notify_admin_new_users ?? 1) === 1;

          if (wantsAlerts) {
            const userIcon = `<tg-emoji emoji-id="5373012449597335010">👤</tg-emoji>`;
            const idIcon = `<tg-emoji emoji-id="5422683699130933153">🪪</tg-emoji>`;
            const usersIcon = `<tg-emoji emoji-id="5372926953978341366">👥</tg-emoji>`;
            const langIcon = `<tg-emoji emoji-id="5399898266265475100">🌐</tg-emoji>`;
            const flagMap: Record<string, string> = {
              uk: `Українська <tg-emoji emoji-id="5447309366568953338">🇺🇦</tg-emoji>`,
              en: `English <tg-emoji emoji-id="5202196682497859879">🇬🇧</tg-emoji>`,
              ru: `Русский <tg-emoji emoji-id="5449408995691341691">🇷🇺</tg-emoji>`,
            };
            const langStr = flagMap[ctx.lang] || ctx.lang;

            const adminMsg = `${userIcon} <b>Новий користувач у боті!</b>\n\n` +
              `• <b>Ім'я:</b> <code>${escapeHtml(ctx.from.first_name)}</code>\n` +
              `• <b>Username:</b> ${usernameStr}\n` +
              `• ${idIcon} <b>Telegram ID:</b> <code>${ctx.from.id}</code>\n` +
              `• ${langIcon} <b>Мова інтерфейсу:</b> ${langStr}\n` +
              `• ${usersIcon} <b>Всього користувачів:</b> <code>${userStats.total}</code>`;

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
      dispatcher
    );

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

  bot.command("admin", createAdminHandler(userDao, subDao, scraper, proxyPool, dispatcher.getInvertedIndex()));
  bot.command("stats", createAdminHandler(userDao, subDao, scraper, proxyPool, dispatcher.getInvertedIndex()));
  bot.command("backup", createBackupHandler(userDao.db, userDao, subDao));
  bot.command("export_users", createUsersExportHandler(userDao.db, userDao, subDao));
  bot.command("export_history", createHistoryExportHandler(userDao.db, userDao));

  // 11. Admin Interactive Callback Handlers (Protected by requireAdmin)
  bot.callbackQuery("admin_open_dashboard", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.answerCallbackQuery().catch(() => {});
    const msgId = ctx.callbackQuery?.message?.message_id;
    if (ctx.chat && msgId) {
      activeDashboardRegistry.register(ctx.chat.id, msgId, ctx.user.id, ctx.lang, "dashboard");
    }
    const rendered = renderDashboardText(ctx, poolStateDao, historyDao, scraper);
    await safeEditMessageText(ctx, rendered, { reply_markup: mainDashboardMenu });
  });

  bot.callbackQuery("admin_toggle_new_users", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const newVal = userDao.toggleAdminNewUsers(ctx.from!.id);
    const toast =
      newVal === 1
        ? ctx.t("admin.toast_new_users_on")
        : ctx.t("admin.toast_new_users_off");
    await ctx.answerCallbackQuery(toast).catch(() => {});
    const text = renderAdminText(ctx, userDao, subDao, scraper, proxyPool);
    const keyboard = createAdminKeyboard(ctx, userDao);
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard }).catch(() => {});
  });

  bot.callbackQuery("admin_refresh", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.answerCallbackQuery({ text: ctx.t("common.refreshed_toast"), show_alert: false }).catch(() => {});
    const text = renderAdminText(ctx, userDao, subDao, scraper, proxyPool);
    const keyboard = createAdminKeyboard(ctx, userDao);
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard }).catch(() => {});
  });

  bot.callbackQuery("admin_export_users", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.answerCallbackQuery().catch(() => {});
    await createUsersExportHandler(userDao.db, userDao, subDao)(ctx);
  });

  bot.callbackQuery("admin_export_history", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.answerCallbackQuery().catch(() => {});
    await createHistoryExportHandler(userDao.db, userDao)(ctx);
  });

  bot.callbackQuery("admin_backup", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.answerCallbackQuery().catch(() => {});
    await createBackupHandler(userDao.db, userDao, subDao)(ctx);
  });

  bot.callbackQuery("admin_test_alert", async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.answerCallbackQuery({ text: ctx.t("admin.toast_test_alert_sent"), show_alert: false }).catch(() => {});
    await dispatcher.sendTestAlert(ctx.from!.id, ctx.lang, "slot");
  });

  bot.command("help", async (ctx) => {
    const keyboard = new InlineKeyboard()
      .url(ctx.t("help.btn_open_site"), "https://cheapestinference.com/pools")
      .row()
      .url(ctx.t("help.btn_github"), "https://github.com/grizlizora/cheapestinference-bot");
    await ctx.reply(
      renderHelpText(ctx),
      {
        parse_mode: "HTML",
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      }
    );
  });

  // Test notification command (Admin Only)
  bot.command("testalert", async (ctx) => {
    if (!ctx.from) return;
    if (!isUserAdmin(ctx.from.id, userDao, ctx.from.username)) {
      await ctx.reply(
        ctx.t("admin.unauthorized", { telegram_id: String(ctx.from.id) }),
        { parse_mode: "HTML" }
      );
      return;
    }

    await ctx.reply(ctx.t("admin.test_alert_sending"), {
      parse_mode: "HTML",
    });

    await dispatcher.sendTestAlert(ctx.from.id, ctx.lang, "slot");
  });

  // Localized command scopes in Telegram UI
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

  // 12. Telegram Stars (XTR) Payment Handlers
  bot.on("pre_checkout_query", async (ctx) => {
    try {
      await ctx.answerPreCheckoutQuery(true);
    } catch (err) {
      console.error("❌ [Telegram Stars Pre-Checkout Error]:", err);
      await ctx.answerPreCheckoutQuery(false, {
        error_message:
          ctx.lang === "uk"
            ? "Помилка обробки платежу. Спробуйте знову."
            : ctx.lang === "ru"
            ? "Ошибка обработки платежа. Попробуйте снова."
            : "Payment processing error. Please retry.",
      }).catch(() => {});
    }
  });

  bot.on("message:successful_payment", async (ctx) => {
    const payment = ctx.message?.successful_payment;
    if (!payment || !ctx.from) return;

    const stars = payment.total_amount;
    const chargeId = payment.telegram_payment_charge_id;
    const providerChargeId = payment.provider_payment_charge_id;

    console.log(
      `⭐ [Telegram Stars Payment Received] User @${ctx.from.username || ctx.from.id} (${ctx.from.id}) paid ${stars} Stars! Charge ID: ${chargeId}`
    );

    // 1. Persist to SQLite & Turso cloud sync atomically
    resolvedDonationDao.recordDonation(
      ctx.user.id,
      ctx.from.id,
      stars,
      chargeId,
      providerChargeId
    );

    // 2. Synchronize Inverted Index RAM priority immediately
    dispatcher.getInvertedIndex().addDonationStars(ctx.from.id, stars);

    const userTotalStars = resolvedDonationDao.getUserTotalDonated(ctx.user.id);

    // 3. Send personal gratitude message
    const thanksTitle = ctx.t("donate.thanks_title");
    const thanksBody = ctx.t("donate.thanks_body", {
      stars: String(stars),
      total_stars: String(userTotalStars),
    });
    const thanksText = `${icon("coffee")} ${thanksTitle}\n\n${thanksBody}`;

    await ctx.reply(thanksText, { parse_mode: "HTML" }).catch(() => {});

    // 4. Notify admins about received donation
    const allAdmins = userDao.getAllAdminTelegramIds(config.ADMIN_USER_IDS);
    const userName = ctx.from.username
      ? `@${ctx.from.username}`
      : `${escapeHtml(ctx.from.first_name || "")}`;

    for (const adminTgId of allAdmins) {
      const adminRecord = userDao.getByTelegramId(adminTgId);
      if (adminRecord && adminRecord.notify_admin_new_users === 1) {
        const adminText = translate(adminRecord.language, "donate.admin_alert", {
          user_name: userName,
          telegram_id: String(ctx.from.id),
          stars: String(stars),
          total_stars: String(userTotalStars),
          charge_id: chargeId,
        });
        await bot.api.sendMessage(adminTgId, adminText, { parse_mode: "HTML" }).catch(() => {});
      }
    }
  });

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
      // Remove inline keyboard to prevent double clicks
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});

      const title = ctx.t("donate.invoice_title", { stars: String(stars) });
      const desc = ctx.t("donate.invoice_desc", { stars: String(stars) });
      const payload = JSON.stringify({
        userId: ctx.user.id,
        telegramId: ctx.from.id,
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

    const profile = dispatcher.getInvertedIndex().getProfileByTgId(ctx.from.id);
    const totalStars = profile?.totalDonatedStars || 0;
    await safeEditMessageText(ctx, renderDonateText(ctx, totalStars), { reply_markup: donateMenu });
  });

  // Wire Scraper diff_events to dispatcher
  scraper.on("diff_events", async (events) => {
    try {
      await dispatcher.handleDiffEvents(events);
    } catch (err: any) {
      console.error("❌ [NotificationDispatcher] Error handling diff events:", err?.message || err);
    }
  });

  return { bot, dispatcher, liveDashboardManager, donationDao: resolvedDonationDao, outboxDao: resolvedOutboxDao };
}
