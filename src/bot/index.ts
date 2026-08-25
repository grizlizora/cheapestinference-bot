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
import { createAdminHandler } from "./handlers/admin.js";
import { createBackupHandler } from "./handlers/backup.js";
import { NotificationDispatcher } from "./notifier/dispatcher.js";
import { config } from "../config/env.js";
import { translate, resolveDefaultLanguage, SupportedLanguage } from "../i18n/index.js";

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

  // 1. Global Error Boundary
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

  // 4. User context loader & universal language resolution
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      let user = userDao.getByTelegramId(ctx.from.id);
      if (!user) {
        const lang = resolveDefaultLanguage(ctx.from.language_code);
        user = userDao.upsertUser({
          telegram_id: ctx.from.id,
          username: ctx.from.username ?? null,
          first_name: ctx.from.first_name,
          language: lang,
        });
        (ctx as any).isNewUser = true;
      } else if (user.is_active === 0) {
        userDao.reactivateUser(ctx.from.id);
        user.is_active = 1;
      }

      ctx.user = user;
      ctx.lang = (user.language as SupportedLanguage) || "en";
    } else {
      ctx.lang = "en";
    }

    ctx.t = (key: string, params?: Record<string, string | number>) =>
      translate(ctx.lang, key, params);

    await next();
  });

  // 5. Shared Notification Dispatcher with In-Memory Inverted Index
  const dispatcher = new NotificationDispatcher(
    bot,
    userDao,
    logDao,
    resolvedHistoryDao
  );

  // 6. Navigation Menus Hierarchy
  const { mainDashboardMenu, languageMenu, subscriptionsMenu } = createMainMenuHierarchy(
    poolStateDao,
    userDao,
    subDao,
    resolvedHistoryDao
  );
  bot.use(mainDashboardMenu);

  // 7. Command Handlers
  bot.command(
    "start",
    createStartHandler(userDao, poolStateDao, languageMenu, mainDashboardMenu, resolvedHistoryDao)
  );

  bot.command(["menu", "dashboard"], async (ctx) => {
    const text = renderDashboardText(ctx, poolStateDao, resolvedHistoryDao);
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: mainDashboardMenu,
      link_preview_options: { is_disabled: true },
    });
  });

  bot.command(["alerts", "subscriptions"], async (ctx) => {
    const text = renderSubscriptionsText(ctx, subDao);
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: subscriptionsMenu,
      link_preview_options: { is_disabled: true },
    });
  });

  bot.command("language", async (ctx) => {
    await ctx.reply(ctx.t("onboarding.welcome_title"), {
      parse_mode: "HTML",
      reply_markup: languageMenu,
      link_preview_options: { is_disabled: true },
    });
  });

  bot.command("admin", createAdminHandler(userDao, subDao, scraper, proxyPool));
  bot.command("stats", createAdminHandler(userDao, subDao, scraper, proxyPool));
  bot.command("backup", createBackupHandler(userDao.db, userDao, subDao));

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

  // Test notification command (Admin Only)
  bot.command("testalert", async (ctx) => {
    if (!ctx.from) return;
    const isAdmin =
      config.ADMIN_USER_IDS.length === 0 ||
      config.ADMIN_USER_IDS.includes(ctx.from.id);

    if (!isAdmin) {
      await ctx.reply(ctx.t("admin.unauthorized"));
      return;
    }

    await ctx.reply("🧪 <i>Dispatching test alert through high-concurrency queue...</i>", {
      parse_mode: "HTML",
    });

    await dispatcher.handleDiffEvents([
      {
        id: crypto.randomUUID(),
        type: "MODEL_UPGRADE_EVENT",
        poolSlug: "frontier",
        poolName: "Frontier Pool",
        block: "ALL",
        models: ["glm-5.3", "minimax-m3", "qwen-3.5-turbo"],
        hoursUtc: "",
        timestamp: Date.now(),
        modelUpgrade: {
          added: [{ type: "added", modelName: "qwen-3.5-turbo", family: "qwen", newVersion: "3.5" }],
          upgraded: [
            {
              type: "upgraded",
              modelName: "glm-5.3",
              previousModelName: "glm-5.2",
              family: "glm",
              oldVersion: "5.2",
              newVersion: "5.3",
              changeNote: "GLM 5.2 ➡️ GLM 5.3",
            },
          ],
          removed: [],
          allActiveModels: ["glm-5.3", "minimax-m3", "qwen-3.5-turbo"],
        },
      },
    ]);
  });

  // Localized command scopes in Telegram
  bot.api
    .setMyCommands(
      [
        { command: "start", description: "Головне меню та моніторинг слотів" },
        { command: "menu", description: "Відкрити дашборд доступності" },
        { command: "alerts", description: "Керування підписками та фільтрами" },
        { command: "language", description: "Змінити мову інтерфейсу" },
        { command: "help", description: "Інструкція та контакт автора" },
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
      { command: "stats", description: "System telemetry (Admin)" },
      { command: "backup", description: "Download SQLite database backup (Admin)" },
    ])
    .catch(() => {});

  // Wire Scraper diff_events to dispatcher
  scraper.on("diff_events", async (events) => {
    await dispatcher.handleDiffEvents(events);
  });

  return { bot, dispatcher };
}
