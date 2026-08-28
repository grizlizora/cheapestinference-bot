import { BotContext } from "../../types/context.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { ScraperOrchestrator } from "../../engine/scraperOrchestrator.js";
import { escapeHtml, formatRelativeTime, stripLeadingEmoji } from "../../i18n/index.js";
import { clampMessageText, formatMonitoringFooter } from "./common.js";
import { icon, getRawUnicode, IconKey } from "./iconTheme.js";

import { renderCapacityBar } from "./capacityBar.js";
import { POOL_RANKS } from "./poolRanks.js";

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
      const urlText = ctx.lang === "uk" ? "Сторінка тарифу на сайті" : ctx.lang === "ru" ? "Страница тарифа на сайте" : "Plan page on website";

      return `${rank.iconsHtml} <b>${escapeHtml(rankTitle)}</b>\n` +
        `• ${statusLabel}: [ ${badgeInfo.capacityBarHtml} ] <b>${rawStatusText}</b> <i>(${p.available_count}/${p.total_blocks || 3} ${blocksFreeText})</i>\n` +
        `• ${modelsLabel}: <code>${modelsText}</code>\n` +
        `• ${basePriceLabel} <b>$${p.min_price}/міс</b>\n` +
        `${icon("nav_link")} <a href="https://cheapestinference.com/pools/${p.slug}">${urlText}</a>`;
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

  const idIcon = `<tg-emoji emoji-id="5422683699130933153">🪪</tg-emoji>`;

  const rendered = `${icon("nav_settings")} ${headerTitle}\n\n` +
    `${icon("nav_language")} ${langLabel}: <b>${currentLang}</b>\n` +
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
  const idIcon = `<tg-emoji emoji-id="5422683699130933153">🪪</tg-emoji>`;
  const guideIcon = icon("nav_guide");
  const authorIcon = icon("nav_author");

  if (ctx.lang === "uk") {
    return `${guideIcon} <b>Як працює цей бот?</b>\n\n` +
      `1. Бот цілодобово перевіряє сторінку <a href="https://cheapestinference.com/pools">cheapestinference.com/pools</a> через захищений анонімний Tor/проксі канал.\n` +
      `2. Кожен тариф ділиться на три щоденні 8-годинні часові блоки (Азія, Європа, Америка).\n` +
      `3. Ви можете переглядати актуальну наявність слотів у реальному часі за допомогою кнопок меню.\n` +
      `4. У картці кожного тарифу (пулу) ви можете налаштувати персональні сповіщення на потрібні вам слоти або окремі регіони.\n` +
      `5. Щойно слот з'являється — ви миттєво отримуєте повідомлення з прямим посиланням на покупку!\n\n` +
      `${idIcon} <b>Ваш Telegram ID:</b> <code>${ctx.from?.id || "N/A"}</code>\n\n` +
      `${authorIcon} <b>Зв'язок з автором / Підтримка:</b>\nTelegram: <a href="https://t.me/grizlizora">@grizlizora</a>`;
  } else if (ctx.lang === "ru") {
    return `${guideIcon} <b>Как работает этот бот?</b>\n\n` +
      `1. Бот круглосуточно проверяет страницу <a href="https://cheapestinference.com/pools">cheapestinference.com/pools</a> через защищенный анонимный Tor/прокси канал.\n` +
      `2. Каждый тариф делится на три ежедневных 8-часовых временных блока (Азия, Европа, Америка).\n` +
      `3. Вы можете просматривать актуальное наличие слотов в реальном времени с помощью кнопок меню.\n` +
      `4. В карточке каждого тарифа (пула) вы можете настроить персональные уведомления на нужные вам слоты или отдельные регионы.\n` +
      `5. Как только слот появляется — вы мгновенно получаете сообщение с прямой ссылкой на покупку!\n\n` +
      `${idIcon} <b>Ваш Telegram ID:</b> <code>${ctx.from?.id || "N/A"}</code>\n\n` +
      `${authorIcon} <b>Связь с автором / Поддержка:</b>\nTelegram: <a href="https://t.me/grizlizora">@grizlizora</a>`;
  } else {
    return `${guideIcon} <b>How this bot works</b>\n\n` +
      `1. The bot monitors <a href="https://cheapestinference.com/pools">cheapestinference.com/pools</a> 24/7 via resilient secure proxy channels.\n` +
      `2. Each pool is partitioned into three daily 8-hour regional blocks (Asia, Europe, Americas).\n` +
      `3. You can inspect live slot availability in real time via the menu buttons.\n` +
      `4. In each pool card, you can configure granular alerts for specific slots or regions.\n` +
      `5. As soon as a slot appears — you receive instant notifications with direct checkout links!\n\n` +
      `${idIcon} <b>Your Telegram ID:</b> <code>${ctx.from?.id || "N/A"}</code>\n\n` +
      `${authorIcon} <b>Contact Author / Support:</b>\nTelegram: <a href="https://t.me/grizlizora">@grizlizora</a>`;
  }
}
