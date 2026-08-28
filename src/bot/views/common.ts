/**
 * src/bot/views/common.ts
 * Shared UI Presentation Utilities, Safe Truncation & Message Editing
 */

import { BotContext } from "../../types/context.js";
import { truncateToTelegramLimit, toValidUtf8 } from "../notifier/htmlTagBalancer.js";
import { icon } from "./iconTheme.js";

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
  consecutiveFailures = 0
): string {
  const ts = lastVerifiedTs && lastVerifiedTs > 0 ? lastVerifiedTs : Date.now();
  const utcDateStr = new Date(ts).toISOString().replace("T", " ").substring(0, 19) + " UTC";
  
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

  return `${utcDateStr} (${modeTag})${delayTag}`;
}
