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
} from "./menus/mainDashboard.js";
import { renderSubscriptionsText } from "./menus/subscriptions.js";
import { createStartHandler } from "./handlers/start.js";
import { createLanguageHandler } from "./handlers/language.js";
import { createAdminHandler, renderAdminText, createAdminKeyboard } from "./handlers/admin.js";
import { createBackupHandler } from "./handlers/backup.js";
import { NotificationDispatcher } from "./notifier/dispatcher.js";
import { config, isUserAdmin } from "../config/env.js";
import {
  translate,
  resolveDefaultLanguage,
  getLanguageFlag,
  escapeHtml,
  SupportedLanguage,
} from "../i18n/index.js";

import { LiveDashboardManager } from "./liveSync/liveDashboardManager.js";
import { ActiveDashboardRegistry } from "./liveSync/dashboardRegistry.js";

export function createTelegramBot(
  token: string,
  userDao: UserDAO,
  subDao: SubscriptionDAO,
  poolStateDao: PoolStateDAO,
  logDao: NotificationLogDAO,
  scraper: ScraperOrchestrator,
  proxyPool: ProxyPool,
  historyDao?: SlotHistoryDAO
): { bot: Bot<BotContext>; dispatcher: NotificationDispatcher; liveDashboardManager: LiveDashboardManager } {
  const bot = new Bot<BotContext>(token, {
    client: config.TELEGRAM_API_ROOT
      ? {
          apiRoot: config.TELEGRAM_API_ROOT,
        }
      : undefined,
  });
  const resolvedHistoryDao = historyDao;

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

  // 4. Shared Notification Dispatcher with In-Memory Inverted Index
  const dispatcher = new NotificationDispatcher(
    bot,
    userDao,
    logDao,
    resolvedHistoryDao
  );

  // Helper function: Admin verification guard
  const requireAdmin = async (ctx: BotContext): Promise<boolean> => {
    if (!isUserAdmin(ctx.from?.id, userDao)) {
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

        // Register in In-Memory Inverted Index immediately
        dispatcher.getInvertedIndex().upsertUserProfile({
          userId: user.id,
          telegramId: user.telegram_id,
          language: lang,
          isMuted: false,
          isActive: true,
          notifyAvailableGlobal: true,
          notifySoldOutGlobal: false,
          notifyModelsGlobal: true,
          notifyPricesGlobal: true,
          lastActiveAt: now,
        });
      } else {
        // Throttled DB disk touch (every 5 mins) to eliminate SQLite write serialization
        const inMemoryProfile = dispatcher.getInvertedIndex().getProfileByTgId(ctx.from.id);
        const lastTouch = inMemoryProfile?.lastDbTouchAt || 0;
        if (now - lastTouch > 5 * 60 * 1000) {
          userDao.touchLastActive(ctx.from.id);
          if (inMemoryProfile) inMemoryProfile.lastDbTouchAt = now;
        }
        dispatcher.getInvertedIndex().updateUserPreferences(ctx.from.id, { lastActiveAt: now });

        if (user.is_active === 0) {
          userDao.reactivateUser(ctx.from.id);
          user.is_active = 1;
          dispatcher.getInvertedIndex().updateUserPreferences(ctx.from.id, { isActive: true });
        }
      }

      ctx.user = user;
      ctx.lang = (user.language as SupportedLanguage) || "en";

      // 6. Notify Admins on New User Registration (if enabled)
      if (isBrandNew) {
        const userStats = userDao.getUserStats();
        const usernameStr = ctx.from.username ? `@${escapeHtml(ctx.from.username)}` : "—";
        const langFlag = getLanguageFlag(ctx.lang);
        const allAdminIds = userDao.getAllAdminTelegramIds(config.ADMIN_USER_IDS);

        for (const adminId of allAdminIds) {
          const adminUser = userDao.getByTelegramId(adminId);
          const adminLang = (adminUser?.language as SupportedLanguage) || "uk";
          const wantsAlerts = (adminUser?.notify_admin_new_users ?? 1) === 1;

          if (wantsAlerts) {
            const adminMsg = translate(adminLang, "admin.new_user_alert", {
              first_name: escapeHtml(ctx.from.first_name),
              username: usernameStr,
              telegram_id: ctx.from.id,
              language: langFlag,
              total_users: userStats.total,
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
  const activeDashboardRegistry = new ActiveDashboardRegistry();

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
  const { mainDashboardMenu, poolDetailMenu, subscriptionsMenu, languageMenu } =
    createMainMenuHierarchy(
      poolStateDao,
      userDao,
      subDao,
      dispatcher.getInvertedIndex(),
      resolvedHistoryDao,
      scraper,
      activeDashboardRegistry
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

  bot.command("admin", createAdminHandler(userDao, subDao, scraper, proxyPool));
  bot.command("stats", createAdminHandler(userDao, subDao, scraper, proxyPool));
  bot.command("backup", createBackupHandler(userDao.db, userDao, subDao));

  // 11. Admin Interactive Callback Handlers (Protected by requireAdmin)
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
    const keyboard = new InlineKeyboard().url(
      ctx.t("common.btn_contact_author"),
      "https://t.me/grizlizora"
    );
    await ctx.reply(
      ctx.t("help_text", { telegram_id: String(ctx.from?.id || "N/A") }),
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
    if (!isUserAdmin(ctx.from.id, userDao)) {
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

  // Wire Scraper diff_events to dispatcher
  scraper.on("diff_events", async (events) => {
    try {
      await dispatcher.handleDiffEvents(events);
    } catch (err: any) {
      console.error("❌ [NotificationDispatcher] Error handling diff events:", err?.message || err);
    }
  });

  return { bot, dispatcher, liveDashboardManager };
}
