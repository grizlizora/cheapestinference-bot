/**
 * src/bot/views/common.ts
 * Shared UI Presentation Utilities, Safe Truncation & Message Editing
 */

import { BotContext } from "../../types/context.js";
import { truncateToTelegramLimit } from "../notifier/htmlTagBalancer.js";

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
  return truncateToTelegramLimit(text, maxLength, {
    ellipsis: "\n\n<i>... [text truncated for display limit]</i>",
    reserveLength: 45,
  });
}

/**
 * Safely edit message text ignoring Telegram 400 "message is not modified"
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
    const safeText = clampMessageText(text);
    await ctx.editMessageText(safeText, extra);
  } catch (err: any) {
    const desc = err?.description || err?.message || "";
    if (desc.includes("message is not modified") || desc.includes("query is too old")) {
      return;
    }
    console.warn("⚠️ [View/Menu] Safe editMessageText warning:", desc);
  }
}
