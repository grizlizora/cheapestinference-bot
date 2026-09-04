/**
 * src/bot/views/common.ts
 * Shared UI Presentation Utilities, Safe Truncation & Message Editing
 */

import { BotContext } from "../../types/context.js";
import { truncateToTelegramLimit, toValidUtf8 } from "../notifier/htmlTagBalancer.js";
import { icon } from "./iconTheme.js";
import { LOCALE_TIMEZONES } from "./timezoneHelper.js";
import { SupportedLanguage } from "../../i18n/index.js";

/**
 * Hard limit safety threshold for Telegram message text (Limit: 4096 chars).
 * We reserve 196 chars buffer for safe footer / formatting overhead.
 */
export const TELEGRAM_MAX_TEXT_LENGTH = 3900;

/**
 * Safely clamps message text to prevent Telegram 400 Bad Request errors,
 * balancing all unclosed HTML tags and entities in strict LIFO order.
 */
export function clampMessageText(text: string, maxLength: number = TELEGRAM_MAX_TEXT_LENGTH): string {
  return truncateToTelegramLimit(toValidUtf8(text), maxLength, {
    ellipsis: "\n\n<i>... [text truncated for display limit]</i>",
    reserveLength: 45,
  });
}

/**
 * Strip Telegram <tg-emoji> tags to plain unicode fallback.
 */
export function stripTgEmoji(text: string): string {
  return text.replace(/<tg-emoji[^>]*>(.*?)<\/tg-emoji>/gi, "$1");
}

/**
 * Safely reply to a message with automatic fallback if custom emoji IDs are invalid (DOCUMENT_INVALID).
 */
export async function safeReply(
  ctx: BotContext,
  text: string,
  extra?: any
): Promise<any> {
  const options: any = {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(extra && extra.inline_keyboard ? { reply_markup: extra } : extra),
  };
  const safeText = clampMessageText(toValidUtf8(text));
  try {
    return await ctx.reply(safeText, options);
  } catch (err: any) {
    const desc = err?.description || err?.message || "";
    if (desc.includes("DOCUMENT_INVALID") || desc.includes("CUSTOM_EMOJI_INVALID")) {
      const stripped = stripTgEmoji(safeText);
      return await ctx.reply(stripped, options);
    }
    throw err;
  }
}

export async function safeEditMessageText(
  ctx: BotContext,
  text: string,
  extra?: any
): Promise<void> {
  try {
    const hasCustomMarkup =
      extra &&
      (extra.inline_keyboard !== undefined ||
        extra.reply_markup !== undefined ||
        typeof extra.pack === "function");

    if (!hasCustomMarkup && (ctx as any).menu && typeof (ctx as any).menu.update === "function") {
      try {
        (ctx as any).menu.update();
      } catch {}
    }

    const options: any = {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(extra && (extra.inline_keyboard || typeof extra.pack === "function")
        ? { reply_markup: extra }
        : extra),
    };

    const safeText = clampMessageText(toValidUtf8(text));
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery?.message?.message_id || ctx.msg?.message_id;

    // When custom reply_markup is provided, use ctx.api directly so Grammy Menu plugin does not overwrite it!
    if (hasCustomMarkup && chatId && messageId && ctx.api) {
      try {
        await ctx.api.editMessageText(chatId, messageId, safeText, options);
        return;
      } catch (err: any) {
        const desc = err?.description || err?.message || "";
        if (desc.includes("DOCUMENT_INVALID") || desc.includes("CUSTOM_EMOJI_INVALID")) {
          const stripped = stripTgEmoji(safeText);
          await ctx.api.editMessageText(chatId, messageId, stripped, options);
          return;
        }
        if (desc.includes("message is not modified") || desc.includes("query is too old")) {
          return;
        }
        throw err;
      }
    }

    try {
      await ctx.editMessageText(safeText, options);
    } catch (err: any) {
      const desc = err?.description || err?.message || "";
      if (desc.includes("DOCUMENT_INVALID") || desc.includes("CUSTOM_EMOJI_INVALID")) {
        const stripped = stripTgEmoji(safeText);
        await ctx.editMessageText(stripped, options);
        return;
      }
      throw err;
    }
  } catch (err: any) {
    const desc = err?.description || err?.message || "";
    if (desc.includes("message is not modified") || desc.includes("query is too old")) {
      return;
    }
    console.warn("⚠️ [View/Menu] Safe editMessageText warning:", desc);
  }
}

const DTF_CACHE = new Map<string, Intl.DateTimeFormat>();
function getDtf(timeZone: string): Intl.DateTimeFormat {
  let dtf = DTF_CACHE.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    DTF_CACHE.set(timeZone, dtf);
  }
  return dtf;
}

/**
 * Formats a clear, dynamic telemetry timestamp footer showing live verification and state.
 */
export function formatMonitoringFooter(
  lastVerifiedTs: number | undefined,
  lang: string,
  lastUserInteractionAt?: number,
  consecutiveFailures = 0
): string {
  const ts = lastVerifiedTs && lastVerifiedTs > 0 ? lastVerifiedTs : Date.now();
  const utcDateStr = new Date(ts).toISOString().replace("T", " ").substring(0, 16) + " UTC";

  const tzConfig = LOCALE_TIMEZONES[lang as SupportedLanguage] || LOCALE_TIMEZONES.en;
  let localDateStr = "";
  if (tzConfig && tzConfig.timeZone !== "UTC") {
    const dtf = getDtf(tzConfig.timeZone);
    const cityName = tzConfig.cityName[lang as SupportedLanguage] || tzConfig.cityName.en;
    localDateStr = ` (${dtf.format(new Date(ts))} ${cityName})`;
  }

  const now = Date.now();
  const idleMs = lastUserInteractionAt ? Math.max(0, now - lastUserInteractionAt) : 0;

  let modeTag = "";
  if (idleMs <= 30 * 60 * 1000) {
    modeTag = `${icon("status_live")} Live 5s`;
  } else if (idleMs <= 24 * 60 * 60 * 1000) {
    const activeText = lang === "uk" ? "Моніторинг активний" : lang === "ru" ? "Мониторинг активен" : "Monitoring active";
    modeTag = `${icon("status_available")} ${activeText}`;
  } else {
    const standbyText = lang === "uk" ? "Режим очікування" : lang === "ru" ? "Режим ожидания" : "Standby";
    modeTag = `${icon("status_standby")} ${standbyText}`;
  }

  let delayTag = "";
  if (consecutiveFailures > 0) {
    const warnText = lang === "uk"
      ? `[затримка мережі, спроба ${consecutiveFailures}]`
      : lang === "ru"
      ? `[задержка сети, попытка ${consecutiveFailures}]`
      : `[network delay, retry ${consecutiveFailures}]`;
    delayTag = ` ${icon("status_delay")} ${warnText}`;
  }

  return `${utcDateStr}${localDateStr} (${modeTag})${delayTag}`;
}
