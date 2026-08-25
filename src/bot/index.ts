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
import { createMainMenuHierarchy, renderDashboardText } from "./menus/mainDashboard.js";
import { createStartHandler } from "./handlers/start.js";
import { createAdminHandler } from "./handlers/admin.js";
import { NotificationDispatcher } from "./notifier/dispatcher.js";
import { config } from "../config/env.js";
import { translate, SupportedLanguage } from "../i18n/index.js";

export function createTelegramBot(
  token: string,
  userDao: UserDAO,
  subDao: SubscriptionDAO,
  poolStateDao: PoolStateDAO,
  logDao: NotificationLogDAO,
  scraper: ScraperOrchestrator,
  proxyPool: ProxyPool,
  historyDao?: SlotHistoryDAO
): { bot: Bot<BotContext>; dispatcher: NotificationDispatcher } {
  const bot = new Bot<BotContext>(token);
  const resolvedHistoryDao = historyDao;

  // 1. Error Boundary
  bot.catch((err) => {
    const ctx = err.ctx;
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

  // 4. User context loader & i18n helper
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      let user = userDao.getByTelegramId(ctx.from.id);
      if (!user) {
        const lang: SupportedLanguage = ["uk", "ru", "en"].includes(ctx.from.language_code || "")
          ? (ctx.from.language_code as SupportedLanguage)
          : "uk";
        user = userDao.upsertUser({
          telegram_id: ctx.from.id,
          username: ctx.from.username ?? null,
          first_name: ctx.from.first_name,
          language: lang,
        });
      } else if (user.is_active === 0) {
        userDao.reactivateUser(ctx.from.id);
        user.is_active = 1;
      }

      ctx.user = user;
      ctx.lang = (user.language as SupportedLanguage) || "uk";
    } else {
      ctx.lang = "uk";
    }

    ctx.t = (key: string, params?: Record<string, string | number>) =>
      translate(ctx.lang, key, params);

    await next();
  });

  // 5. Shared Notification Dispatcher
  const dispatcher = new NotificationDispatcher(
    bot,
    subDao,
    userDao,
    logDao,
    resolvedHistoryDao
  );

  // 6. Navigation Menus
  const { mainDashboardMenu } = createMainMenuHierarchy(
    poolStateDao,
    userDao,
    subDao,
    resolvedHistoryDao
  );
  bot.use(mainDashboardMenu);

  // 7. Command Handlers
  bot.command("start", createStartHandler(userDao, poolStateDao, mainDashboardMenu, resolvedHistoryDao));

  bot.command(["menu", "dashboard"], async (ctx) => {
    const text = renderDashboardText(ctx, poolStateDao, resolvedHistoryDao);
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: mainDashboardMenu,
      link_preview_options: { is_disabled: true },
    });
  });

  bot.command(["alerts", "subscriptions"], async (ctx) => {
    await ctx.reply(ctx.t("subscriptions.title", {
      global_status: subDao.hasSubscription(ctx.user.id, "ALL", "ALL")
        ? ctx.t("subscriptions.global_enabled")
        : ctx.t("subscriptions.global_disabled"),
      sound_status:
        ctx.user.is_muted === 1
          ? ctx.t("subscriptions.sound_muted")
          : ctx.t("subscriptions.sound_enabled"),
    }), {
      parse_mode: "HTML",
      reply_markup: mainDashboardMenu,
    });
  });

  bot.command("language", async (ctx) => {
    await ctx.reply(ctx.t("onboarding.welcome_title"), {
      parse_mode: "HTML",
      reply_markup: mainDashboardMenu,
    });
  });

  bot.command(
    "admin",
    createAdminHandler(userDao, subDao, scraper, proxyPool)
  );

  bot.command(
    "stats",
    createAdminHandler(userDao, subDao, scraper, proxyPool)
  );

  bot.command("help", async (ctx) => {
    const keyboard = new InlineKeyboard().url(
      ctx.t("common.btn_contact_author"),
      "https://t.me/grizlizora"
    );
    await ctx.reply(ctx.t("help_text"), {
      parse_mode: "HTML",
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
  });

  // Test notification command (Admin Only, direct to caller)
  bot.command("testalert", async (ctx) => {
    if (!ctx.from) return;
    const isAdmin =
      config.ADMIN_USER_IDS.length === 0 ||
      config.ADMIN_USER_IDS.includes(ctx.from.id);

    if (!isAdmin) {
      await ctx.reply(ctx.t("admin.unauthorized"));
      return;
    }

    await ctx.reply("🧪 <i>Sending synthetic slot alert to your chat...</i>", {
      parse_mode: "HTML",
    });

    await dispatcher.sendSingleAlert(
      ctx.user.id,
      ctx.from.id,
      ctx.lang,
      ctx.user.is_muted === 1,
      {
        id: crypto.randomUUID(),
        type: "SLOT_APPEARED",
        poolSlug: "flagship",
        poolName: "Flagship Pool — Kimi K3, Qwen3.8 Max",
        block: "europe",
        models: ["kimi-k3", "qwen3.8-max"],
        hoursUtc: "08:00-16:00 UTC",
        newStatus: "limited",
        newPrice: "165.00",
        timestamp: Date.now(),
      }
    );
  });

  // Localized commands menu in Telegram UI
  bot.api
    .setMyCommands([
      { command: "start", description: "Головне меню та моніторинг слотів" },
      { command: "menu", description: "Відкрити дашборд доступності" },
      { command: "alerts", description: "Керування підписками та звуком" },
      { command: "language", description: "Змінити мову інтерфейсу" },
      { command: "help", description: "Інструкція та контакт автора" },
      { command: "stats", description: "Телеметрія системи (Admin)" },
    ], { language_code: "uk" })
    .catch(() => {});

  bot.api
    .setMyCommands([
      { command: "start", description: "Главное меню и мониторинг слотов" },
      { command: "menu", description: "Открыть дашборд доступности" },
      { command: "alerts", description: "Управление подписками и звуком" },
      { command: "language", description: "Сменить язык интерфейса" },
      { command: "help", description: "Инструкция и контакт автора" },
      { command: "stats", description: "Телеметрия системы (Admin)" },
    ], { language_code: "ru" })
    .catch(() => {});

  bot.api
    .setMyCommands([
      { command: "start", description: "Launch or refresh the main dashboard" },
      { command: "menu", description: "Open slot availability dashboard" },
      { command: "alerts", description: "Manage slot subscriptions & sound" },
      { command: "language", description: "Change language / Змінити мову" },
      { command: "help", description: "How the bot works & author contact" },
      { command: "stats", description: "Platform telemetry & status (Admin)" },
    ])
    .catch(() => {});

  // Wire Scraper diff_events to dispatcher
  scraper.on("diff_events", async (events) => {
    await dispatcher.dispatchEvents(events);
  });

  return { bot, dispatcher };
}
