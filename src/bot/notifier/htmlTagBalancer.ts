/**
 * src/bot/notifier/htmlTagBalancer.ts
 * Strict LIFO HTML Tag Balancer & Truncation Engine for Telegram Messages
 */

export interface TruncateOptions {
  maxLen?: number;
  ellipsis?: string;
  reserveLength?: number;
}

const VOID_TAGS = new Set(["br", "hr", "img", "input", "meta", "link"]);

/**
 * Ensures a string contains 100% valid UTF-8 / well-formed UTF-16 code units.
 * Eliminates any lone surrogates (U+D800..U+DFFF) and raw surrogate escapes.
 */
export function toValidUtf8(text: string): string {
  if (!text) return "";
  const wellFormed = typeof (text as any).toWellFormed === "function" ? (text as any).toWellFormed() : text;
  return wellFormed.replace(/\uFFFD/g, "").replace(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/g, "");
}

/**
 * Slices a string safely without bisecting UTF-16 surrogate pairs.
 */
export function safeUnicodeSlice(text: string, start: number, end: number): string {
  if (!text) return "";
  let sliceEnd = Math.min(text.length, end);
  if (sliceEnd > 0 && sliceEnd < text.length) {
    const charCode = text.charCodeAt(sliceEnd - 1);
    if (charCode >= 0xd800 && charCode <= 0xdbff) {
      sliceEnd -= 1;
    }
  }
  return text.slice(start, sliceEnd);
}

/**
 * Balances unclosed HTML tags in a string using a strict LIFO stack.
 */
export function balanceHtmlTags(html: string): string {
  if (!html) return "";

  const sanitized = toValidUtf8(html);
  const stack: string[] = [];
  const tagRegex = /<\/?([a-z0-9_-]+)[^>]*>/gi;

  for (const match of sanitized.matchAll(tagRegex)) {
    const fullTag = match[0];
    const tagName = match[1].toLowerCase();

    if (VOID_TAGS.has(tagName) || fullTag.endsWith("/>")) continue;

    if (fullTag.startsWith("</")) {
      // Closing tag: pop matching tag or unwind stack to matching tag
      const idx = stack.lastIndexOf(tagName);
      if (idx !== -1) {
        stack.splice(idx);
      }
    } else {
      // Opening tag: push onto LIFO stack
      stack.push(tagName);
    }
  }

  let result = sanitized;
  while (stack.length > 0) {
    const tagToClose = stack.pop();
    result += `</${tagToClose}>`;
  }
  return result;
}

/**
 * Truncates text to Telegram message length limits and balances unclosed HTML tags using a LIFO stack.
 */
export function truncateToTelegramLimit(
  text: string,
  maxLen: number = 3900,
  options?: TruncateOptions
): string {
  if (!text) return "";

  const sanitized = toValidUtf8(text);
  if (sanitized.length <= maxLen) {
    return balanceHtmlTags(sanitized);
  }

  const reserve = options?.reserveLength ?? 30;
  const ellipsis = options?.ellipsis ?? "\n\n<i>...[truncated]</i>";

  let truncated = safeUnicodeSlice(sanitized, 0, maxLen - reserve);
  const lastNewline = truncated.lastIndexOf("\n");
  const minCutoff = maxLen - reserve - 400;
  if (lastNewline > minCutoff && lastNewline > 0) {
    truncated = safeUnicodeSlice(truncated, 0, lastNewline);
  }

  // Strip broken opening tag truncated mid-attribute and cut entities
  truncated = truncated.replace(/<[^>]*$/, "").replace(/&[a-zA-Z0-9#]*$/, "");

  const balanced = balanceHtmlTags(truncated);
  return balanced + ellipsis;
}
