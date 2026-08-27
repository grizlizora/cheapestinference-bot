/**
 * src/bot/views/common.ts
 * Shared UI Presentation Utilities, Safe Truncation & Message Editing
 */

import { BotContext } from "../../types/context.js";

/**
 * Hard limit safety threshold for Telegram message text (Limit: 4096 chars).
 * We reserve 150 chars buffer for safe footer / formatting overhead.
 */
export const TELEGRAM_MAX_TEXT_LENGTH = 3950;

/**
 * Safely clamps message text to prevent Telegram 400 Bad Request errors.
 */
export function clampMessageText(text: string, maxLength: number = TELEGRAM_MAX_TEXT_LENGTH): string {
  if (!text || text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength);
  // Ensure we do not cut in the middle of an HTML tag or entity
  const lastTagOpen = truncated.lastIndexOf("<");
  const lastTagClose = truncated.lastIndexOf(">");
  const safeCut = lastTagOpen > lastTagClose ? truncated.slice(0, lastTagOpen) : truncated;
  return safeCut + "\n\n<i>... [text truncated for display limit]</i>";
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
