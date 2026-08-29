import { BotContext } from "../../types/context.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { ScraperOrchestrator } from "../../engine/scraperOrchestrator.js";
import { escapeHtml, formatRelativeTime, stripLeadingEmoji } from "../../i18n/index.js";
import { clampMessageText, formatMonitoringFooter } from "./common.js";
import { icon, getRawUnicode, IconKey } from "./iconTheme.js";

import { renderCapacityBar } from "./capacityBar.js";
import { POOL_RANKS } from "./poolRanks.js";
import { renderUserProfileCard } from "./userRankHelper.js";

export interface PoolBadgeInfo {
  icon: string;
  iconHtml: string;
  capacityBarUnicode: string;
  capacityBarHtml: string;
  shortStatus: string;
  statusBadgeKey: string;
  iconKey: IconKey;
}

export function computePoolBadgeInfo(availableCount: number, totalBlocks: number): PoolBadgeInfo {
  const total = totalBlocks || 3;
  const capacityBarUnicode = renderCapacityBar(availableCount, total, "unicode");
  const capacityBarHtml = renderCapacityBar(availableCount, total, "html");

  let iconKey: IconKey = "status_sold_out";
  let statusBadgeKey = "common.status_sold_out";

  if (availableCount >= total && total > 0) {
    iconKey = "status_available";
    statusBadgeKey = "common.status_available";
  } else if (availableCount > 0) {
    iconKey = "status_partially_available";
    statusBadgeKey = "common.status_partially_available";
  }

  return {
    icon: getRawUnicode(iconKey),
    iconHtml: icon(iconKey),
    capacityBarUnicode,
    capacityBarHtml,
    shortStatus: `${availableCount}/${total}`,
    statusBadgeKey,
    iconKey,
  };
}

export function renderDashboardText(
  ctx: BotContext,
  poolStateDao: PoolStateDAO,
  historyDao?: SlotHistoryDAO,
  scraper?: ScraperOrchestrator,
  lastUserInteractionAt?: number
): string {
  const summaries = poolStateDao.getPoolSummaries();
  const telemetry = scraper?.getTelemetry();
  const lastVerified = poolStateDao.getLastVerified();
  const lastVerifiedTs = telemetry?.lastScrapeTimestamp || lastVerified?.timestamp;

  const updatedAtStr = formatMonitoringFooter(
    lastVerifiedTs,
    ctx.lang,
    lastUserInteractionAt,
    telemetry?.consecutiveFailures || 0
  );

  if (summaries.length === 0) {
    return ctx.t("menu.dashboard_title", {
      pool_summaries: ctx.t("menu.loading_data"),
      updated_at: updatedAtStr,
    });
  }

  const poolSummariesText = summaries
    .map((p) => {
      const badgeInfo = computePoolBadgeInfo(p.available_count, p.total_blocks);
      const textKey = `${badgeInfo.statusBadgeKey}_text`;
      const directText = ctx.t(textKey);
      const rawStatusText = (directText && directText !== textKey)
        ? directText
        : stripLeadingEmoji(ctx.t(badgeInfo.statusBadgeKey));
      
      const rank = POOL_RANKS[p.slug] || {
        iconsHtml: icon("pool_generic"),
        tierName: { [ctx.lang]: p.name },
      };
      const rankTitle = rank.tierName[ctx.lang] || p.name;

      const rawModels = (p.models || []).slice(0, 10).join(", ");
      const modelsText = escapeHtml(rawModels) || ctx.t("common.custom_models");

      const statusLabel = ctx.lang === "uk" ? "Місткість" : ctx.lang === "ru" ? "Вместимость" : "Capacity";
      const blocksFreeText = ctx.lang === "uk" ? "блоків вільно" : ctx.lang === "ru" ? "блоков свободно" : "blocks free";
      const modelsLabel = ctx.lang === "uk" ? "Моделі" : ctx.lang === "ru" ? "Модели" : "Models";
      const basePriceLabel = ctx.lang === "uk" ? "Базовий тариф: від" : ctx.lang === "ru" ? "Базовый тариф: от" : "Base price: from";
      const currencyMonth = ctx.t("common.currency_month") || "mo";

      return `${rank.iconsHtml} <b>${escapeHtml(rankTitle)}</b>\n` +
        `• ${statusLabel}: [ ${badgeInfo.capacityBarHtml} ] <b>${rawStatusText}</b> <i>(${p.available_count}/${p.total_blocks || 3} ${blocksFreeText})</i>\n` +
        `• ${modelsLabel}: <code>${modelsText}</code>\n` +
        `• ${basePriceLabel} <b>$${p.min_price}/${currencyMonth}</b>`;
    })
    .join("\n\n");

  const dashboardHeader = ctx.lang === "uk"
    ? "<b>CheapestInference — Моніторинг слотів</b>\n\nАктуальний стан тарифів та регіональних блоків:"
    : ctx.lang === "ru"
    ? "<b>CheapestInference — Мониторинг слотов</b>\n\nАктуальное состояние тарифов и региональных блоков:"
    : "<b>CheapestInference — Slot Monitoring</b>\n\nActual status of compute pools and regional blocks:";
  const updatedLabel = ctx.lang === "uk" ? "Останнє оновлення" : ctx.lang === "ru" ? "Последнее обновление" : "Last updated";

  const rendered = `${icon("nav_chart")} ${dashboardHeader}\n\n` +
    `${poolSummariesText}\n\n` +
    `${icon("nav_clock")} <i>${updatedLabel}: ${updatedAtStr}</i>`;

  return clampMessageText(rendered);
}

export function renderSettingsText(ctx: BotContext): string {
  const flagUk = `<tg-emoji emoji-id="5447309366568953338">🇺🇦</tg-emoji>`;
  const flagEn = `<tg-emoji emoji-id="5202196682497859879">🇬🇧</tg-emoji>`;
  const flagRu = `<tg-emoji emoji-id="5449408995691341691">🇷🇺</tg-emoji>`;

  const langNames: Record<string, string> = {
    uk: `Українська ${flagUk}`,
    en: `English ${flagEn}`,
    ru: `Русский ${flagRu}`,
  };
  const currentLang = langNames[ctx.lang] || ctx.lang;

  const headerTitle = ctx.lang === "uk"
    ? "<b>Налаштування бота</b>\n\nКеруйте мовою інтерфейсу, переглядайте довідку та контакти."
    : ctx.lang === "ru"
    ? "<b>Настройки бота</b>\n\nУправляйте языком интерфейса, просматривайте справку и контакты."
    : "<b>Bot Settings</b>\n\nManage interface language, view help guides, and contacts.";

  const langLabel = ctx.lang === "uk" ? "Поточна мова" : ctx.lang === "ru" ? "Текущий язык" : "Current language";
  const idLabel = ctx.lang === "uk" ? "Ваш Telegram ID" : ctx.lang === "ru" ? "Ваш Telegram ID" : "Your Telegram ID";
  const soundLabel = ctx.lang === "uk" ? "Режим звуку" : ctx.lang === "ru" ? "Режим звука" : "Sound Mode";

  const isMuted = (ctx.user?.is_muted ?? 0) === 1;
  const soundStatus = isMuted
    ? (ctx.lang === "uk" ? `Без звуку (тихий режим) ${icon("notify_mute")}` : ctx.lang === "ru" ? `Без звука (тихий режим) ${icon("notify_mute")}` : `Silent (muted) ${icon("notify_mute")}`)
    : (ctx.lang === "uk" ? `Звук увімкнено ${icon("notify_loud")}` : ctx.lang === "ru" ? `Звук включен ${icon("notify_loud")}` : `Audible ${icon("notify_loud")}`);

  const idIcon = `<tg-emoji emoji-id="5422683699130933153">🪪</tg-emoji>`;

  const profileCard = renderUserProfileCard(
    {
      isAdmin: ctx.user?.is_admin === 1,
      totalDonatedStars: (ctx.user as any)?.total_donated_stars || 0,
      lastActiveAt: ctx.user ? Date.parse(ctx.user.last_active_at) || Date.now() : Date.now(),
      telegramId: ctx.from?.id,
    },
    ctx.lang
  );

  const rendered = `${icon("nav_settings")} ${headerTitle}\n\n` +
    `${profileCard}\n\n` +
    `${icon("nav_language")} ${langLabel}: <b>${currentLang}</b>\n` +
    `${icon(isMuted ? "notify_mute" : "notify_loud")} ${soundLabel}: <b>${soundStatus}</b>\n` +
    `${idIcon} ${idLabel}: <code>${ctx.from?.id || "N/A"}</code>`;

  return clampMessageText(rendered);
}

export function renderChangeLanguageText(ctx: BotContext): string {
  const title = ctx.lang === "uk"
    ? "<b>Зміна мови інтерфейсу</b>\n\nОберіть зручну мову для роботи з ботом:"
    : ctx.lang === "ru"
    ? "<b>Смена языка интерфейса</b>\n\nВыберите удобный язык для работы с ботом:"
    : "<b>Change Interface Language</b>\n\nSelect your preferred language for the bot:";

  return `${icon("nav_language")} ${title}`;
}

export function renderHelpText(ctx: BotContext): string {
  const guideIcon = icon("nav_guide");
  const slotIcon = icon("event_slot_drop");
  const starIcon = icon("star");
  const bulbIcon = icon("tip_lightbulb");
  const octoIcon = icon("git_octopus");
  const zapIcon = icon("status_available");

  if (ctx.lang === "uk") {
    return `${guideIcon} <b>CheapestInference — Довідка та інструкція</b>\n\n` +
      `${slotIcon} <b>Як працює цей бот?</b>\n` +
      `• <b>Цілодобовий моніторинг:</b> бот безперервно перевіряє офіційний сайт <a href="https://cheapestinference.com/pools">cheapestinference.com</a> через високошвидкісні проксі-канали без затримок.\n` +
      `• <b>Регіональні 8-годинні блоки:</b> кожен тариф ділиться на три щоденні зміни (Азія: 00:00–08:00, Європа: 08:00–16:00, Америка: 16:00–24:00 UTC).\n` +
      `• <b>Живий дашборд:</b> актуальна наявність слотів та інтерактивна шкала заповненості оновлюються наживо.\n` +
      `• <b>Персональні сповіщення:</b> можливість підписатися на весь тариф або окремі географічні слоти, а також фільтрувати типи подій (вільні слоти, sold out, нові моделі, ціни).\n` +
      `• <b>Швидке бронювання:</b> сповіщення містять прямі посилання для моментального оформлення замовлення на сайті.\n\n` +
      `${zapIcon} <b>Правила активності та черги (Zero-Loss):</b>\n` +
      `• <b>14 днів активності:</b> якщо акаунт не взаємодіє з ботом >14 днів, сповіщення призупиняються для економії лімітів Telegram.\n` +
      `• <b>Миттєве відновлення:</b> будь-яке натискання кнопки чи повідомлення боту миттєво повертає вас у чергу з повним збереженням усіх підписок!\n` +
      `• <b>Пріоритет (Telegram Stars):</b> донатери отримують сповіщення в першій хвилі та мають розширене утримання до 450+ днів.\n\n` +
      `${bulbIcon} <b>Open-Source & Безпека:</b>\n` +
      `Проект є повністю відкритим, надійним та прозорим під ліцензією MIT.\n` +
      `${octoIcon} <a href="https://github.com/grizlizora/cheapestinference-bot">Відкритий вихідний код на GitHub</a>`;
  } else if (ctx.lang === "ru") {
    return `${guideIcon} <b>CheapestInference — Справка и инструкция</b>\n\n` +
      `${slotIcon} <b>Как работает этот бот?</b>\n` +
      `• <b>Круглосуточный мониторинг:</b> бот непрерывно проверяет официальный сайт <a href="https://cheapestinference.com/pools">cheapestinference.com</a> через защищенные скоростные каналы.\n` +
      `• <b>Региональные 8-часовые блоки:</b> каждый тариф делится на три смены (Азия: 00:00–08:00, Европа: 08:00–16:00, Америка: 16:00–24:00 UTC).\n` +
      `• <b>Живой дашборд:</b> актуальное наличие слотов и интерактивная шкала заполненности обновляются на лету.\n` +
      `• <b>Персональные уведомления:</b> подписка на весь тариф или отдельные слоты с фильтрацией событий (свободные слоты, sold out, модели, цены).\n` +
      `• <b>Быстрое бронирование:</b> уведомления содержат прямые кнопки для моментального заказа слота на сайте.\n\n` +
      `${zapIcon} <b>Правила активности и очереди (Zero-Loss):</b>\n` +
      `• <b>14 дней активности:</b> при отсутствии действий >14 дней доставка ставится на паузу для защиты лимитов Telegram.\n` +
      `• <b>Мгновенное возобновление:</b> любое нажатие кнопки или сообщение боту мгновенно возвращает вас в очередь с полным сохранением подписок!\n` +
      `• <b>Приоритет (Telegram Stars):</b> донатеры получают оповещения в первой волне и продлевают удержание до 450+ дней.\n\n` +
      `${bulbIcon} <b>Open-Source & Безопасность:</b>\n` +
      `Проект имеет полностью открытый, надежный и прозрачный исходный код под лицензией MIT.\n` +
      `${octoIcon} <a href="https://github.com/grizlizora/cheapestinference-bot">Исходный код на GitHub</a>`;
  } else {
    return `${guideIcon} <b>CheapestInference — User Guide & Help</b>\n\n` +
      `${slotIcon} <b>How this bot works</b>\n` +
      `• <b>24/7 Live Monitoring:</b> bot continuously tracks the official <a href="https://cheapestinference.com/pools">cheapestinference.com</a> website via resilient high-speed proxy channels.\n` +
      `• <b>Regional 8-Hour Blocks:</b> each compute tier is partitioned into three daily shifts (Asia: 00:00–08:00, Europe: 08:00–16:00, Americas: 16:00–24:00 UTC).\n` +
      `• <b>Real-Time Dashboard:</b> live availability and capacity progress bars update dynamically.\n` +
      `• <b>Granular Alert Filters:</b> subscribe to entire tiers or specific regional slots, with customizable event triggers (slot drops, sold out, model upgrades, price updates).\n` +
      `• <b>Instant Checkout:</b> notifications include direct checkout buttons to secure capacity in seconds.\n\n` +
      `${zapIcon} <b>Activity Policy & Priority (Zero-Loss):</b>\n` +
      `• <b>14-Day Rolling Window:</b> accounts inactive for >14 days are paused to eliminate Telegram API rate limits.\n` +
      `• <b>Instant Revival:</b> pressing any button or sending a message instantly restores delivery with 100% of your preferences intact!\n` +
      `• <b>Supporter Perks (Telegram Stars):</b> donors receive drop alerts in the first wave and extend retention up to 450+ days.\n\n` +
      `${bulbIcon} <b>Open-Source & Transparent:</b>\n` +
      `This project is 100% open-source, robust, and transparent under the MIT license.\n` +
      `${octoIcon} <a href="https://github.com/grizlizora/cheapestinference-bot">Source code on GitHub</a>`;
  }
}
