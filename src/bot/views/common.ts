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
  extra: any = { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
): Promise<any> {
  const safeText = clampMessageText(toValidUtf8(text));
  try {
    return await ctx.reply(safeText, extra);
  } catch (err: any) {
    const desc = err?.description || err?.message || "";
    if (desc.includes("DOCUMENT_INVALID") || desc.includes("CUSTOM_EMOJI_INVALID")) {
      const stripped = stripTgEmoji(safeText);
      return await ctx.reply(stripped, extra);
    }
    throw err;
  }
}

/**
 * Safely edit message text ignoring Telegram 400 "message is not modified",
 * with automatic fallback if custom emoji IDs are invalid (DOCUMENT_INVALID).
 */
export async function safeEditMessageText(
  ctx: BotContext,
  text: string,
  extra: any = { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
): Promise<void> {
  try {
    if ((ctx as any).menu && typeof (ctx as any).menu.update === "function") {
      try {
        (ctx as any).menu.update();
      } catch {}
    }
    const safeText = clampMessageText(toValidUtf8(text));
    try {
      await ctx.editMessageText(safeText, extra);
    } catch (err: any) {
      const desc = err?.description || err?.message || "";
      if (desc.includes("DOCUMENT_INVALID") || desc.includes("CUSTOM_EMOJI_INVALID")) {
        const stripped = stripTgEmoji(safeText);
        await ctx.editMessageText(stripped, extra);
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

/**
 * Formats a clear, dynamic telemetry timestamp footer showing live verification and state.
 */
export function formatMonitoringFooter(
  lastVerifiedTs: number | undefined,
  lang: string,
  lastUserInteractionAt?: number,
  consecutiveFailures = 0,
  latencyMs = 140
): string {
  const ts = lastVerifiedTs && lastVerifiedTs > 0 ? lastVerifiedTs : Date.now();
  const utcDateStr = new Date(ts).toISOString().replace("T", " ").substring(0, 19) + " UTC";

  const tzConfig = LOCALE_TIMEZONES[lang as SupportedLanguage] || LOCALE_TIMEZONES.en;
  let localDateStr = "";
  if (tzConfig && tzConfig.timeZone !== "UTC") {
    const dtf = new Intl.DateTimeFormat("en-GB", {
      timeZone: tzConfig.timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const cityName = tzConfig.cityName[lang as SupportedLanguage] || tzConfig.cityName.en;
    localDateStr = ` (${dtf.format(new Date(ts))} ${cityName})`;
  }

  const now = Date.now();
  const idleMs = lastUserInteractionAt ? Math.max(0, now - lastUserInteractionAt) : 0;

  let modeTag = `${icon("status_live")} Live 5s`;
  if (idleMs > 30 * 60 * 1000 && idleMs <= 24 * 60 * 60 * 1000) {
    const activeText = lang === "uk" ? "Моніторинг активний" : lang === "ru" ? "Мониторинг активен" : "Monitoring active";
    modeTag = `${icon("status_available")} ${activeText}`;
  } else if (idleMs > 24 * 60 * 60 * 1000) {
    const standbyText = lang === "uk" ? "Режим очікування" : lang === "ru" ? "Режим ожидания" : "Standby";
    modeTag = `${icon("status_standby")} ${standbyText}`;
  }

  const radarLabel = lang === "uk" ? "LIVE RADAR 24/7" : lang === "ru" ? "LIVE RADAR 24/7" : "LIVE RADAR 24/7";
  const speedLabel = lang === "uk" ? "Швидкість" : lang === "ru" ? "Скорость" : "Latency";
  const channelLabel = lang === "uk" ? "Захищений Tor/SOCKS5 канал" : lang === "ru" ? "Защищенный Tor/SOCKS5 канал" : "Encrypted Tor/SOCKS5 Pipeline";
  const updatedLabel = lang === "uk" ? "Оновлено" : lang === "ru" ? "Обновлено" : "Verified";

  let delayNotice = "";
  if (consecutiveFailures > 0) {
    const warn = lang === "uk" ? `[помилок: ${consecutiveFailures}]` : `[retries: ${consecutiveFailures}]`;
    delayNotice = ` ${icon("status_delay")} <code>${warn}</code>`;
  }

  return `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🛰️ ${icon("status_available")} <b>${radarLabel}</b> • ${speedLabel}: ${icon("pool_frontier")} <b>${latencyMs}ms</b>\n` +
    `${icon("rank_shield")} <b>${channelLabel}</b> • Режим: <b>${modeTag}</b>${delayNotice}\n` +
    `${icon("nav_clock")} <i>${updatedLabel}: ${utcDateStr}${localDateStr}</i>`;
}
