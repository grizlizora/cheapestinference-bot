import { Bot, session, InlineKeyboard } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import Database from "better-sqlite3";
import { BotContext, SessionData } from "../types/context.js";
import { UserDAO } from "../db/dao/users.js";
import { SubscriptionDAO } from "../db/dao/subscriptions.js";
import { PoolStateDAO } from "../db/dao/poolState.js";
import { NotificationLogDAO } from "../db/dao/notificationLogs.js";
import { SlotHistoryDAO } from "../db/dao/slotHistory.js";
import { ScraperOrchestrator } from "../engine/scraperOrchestrator.js";
import { ProxyPool } from "../proxy/proxyPool.js";
import { NotificationDispatcher } from "./notifier/dispatcher.js";
import { createMainMenu, renderDashboardText } from "./menus/mainDashboard.js";
import { renderSubscriptionsText } from "./menus/subscriptions.js";
import { createStartHandler } from "./handlers/start.js";
import { createLanguageHandler } from "./handlers/language.js";
import { createAdminHandler } from "./handlers/admin.js";
import { translate, SupportedLanguage } from "../i18n/index.js";
import { config } from "../config/env.js";

export function createTelegramBot(
  token: string,
  db: Database.Database,
  scraper: ScraperOrchestrator,
  proxyPool: ProxyPool,
  historyDao?: SlotHistoryDAO
) {
  const userDao = new UserDAO(db);
  const subDao = new SubscriptionDAO(db);
  const poolStateDao = new PoolStateDAO(db);
  const logDao = new NotificationLogDAO(db);
  const resolvedHistoryDao = historyDao || new SlotHistoryDAO(db);

  const bot = new Bot<BotContext>(token);

  // 1. Auto-retry for 429 and transient errors
  bot.api.config.use(autoRetry());

  // 2. Session middleware
  bot.use(
    session({
      initial: (): SessionData => ({}),
    })
  );

  // 3. User Authentication & i18n Injection Middleware
  bot.use(async (ctx, next) => {
    if (!ctx.from) return next();

    let user = userDao.getByTelegramId(ctx.from.id);
    const isNew = !user;

    if (!user) {
      const detectedLang: SupportedLanguage = ctx.from.language_code?.startsWith("uk")
        ? "uk"
        : ctx.from.language_code?.startsWith("ru")
        ? "ru"
        : "uk";

      user = userDao.upsertUser({
        telegram_id: ctx.from.id,
        username: ctx.from.username || null,
        first_name: ctx.from.first_name || "User",
        language: detectedLang,
      });
    }

    ctx.user = user;
    ctx.lang = user.language || "uk";
    ctx.isNewUser = isNew;
    ctx.t = (key: string, params?: Record<string, string | number>) =>
      translate(ctx.lang, key, params);

    await next();
  });

  // 4. Register Menus
  const { mainDashboardMenu, languageMenu, subscriptionsMenu } = createMainMenu(
    poolStateDao,
    subDao,
    userDao,
    resolvedHistoryDao
  );
  bot.use(mainDashboardMenu);

  // 5. Register Commands
  bot.command(
    "start",
    createStartHandler(userDao, poolStateDao, languageMenu, mainDashboardMenu, resolvedHistoryDao)
  );

  bot.command("menu", async (ctx) => {
    await ctx.reply(renderDashboardText(ctx, poolStateDao, resolvedHistoryDao), {
      reply_markup: mainDashboardMenu,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  bot.command("dashboard", async (ctx) => {
    await ctx.reply(renderDashboardText(ctx, poolStateDao, resolvedHistoryDao), {
      reply_markup: mainDashboardMenu,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  bot.command("alerts", async (ctx) => {
    await ctx.reply(renderSubscriptionsText(ctx, subDao), {
      reply_markup: subscriptionsMenu,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  bot.command("language", createLanguageHandler(languageMenu));

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

  // 6. Test notification command (Admin Only, direct to caller)
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

    const dispatcher = new NotificationDispatcher(
      bot,
      subDao,
      userDao,
      logDao,
      resolvedHistoryDao
    );
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

  // Register command list in Telegram UI
  bot.api
    .setMyCommands([
      { command: "start", description: "Launch or refresh the main dashboard" },
      { command: "menu", description: "Open slot availability dashboard" },
      { command: "alerts", description: "Manage slot subscriptions & sound" },
      { command: "language", description: "Change language / Змінити мову" },
      { command: "help", description: "How the bot works & author contact" },
      { command: "stats", description: "Platform telemetry & status (Admin)" },
    ])
    .catch((err) => console.warn("Failed to set Telegram commands:", err));

  // 7. Notification Dispatcher wired to Scraper diff_events
  const dispatcher = new NotificationDispatcher(
    bot,
    subDao,
    userDao,
    logDao,
    resolvedHistoryDao
  );
  scraper.on("diff_events", (events) => {
    dispatcher.handleDiffEvents(events);
  });

  return { bot, userDao, subDao, poolStateDao, logDao, historyDao: resolvedHistoryDao, dispatcher };
}
