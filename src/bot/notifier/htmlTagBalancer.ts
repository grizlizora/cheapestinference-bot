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
 * Balances unclosed HTML tags in a string using a strict LIFO stack.
 */
export function balanceHtmlTags(html: string): string {
  if (!html) return "";

  const stack: string[] = [];
  const tagRegex = /<\/?([a-z0-9_-]+)[^>]*>/gi;

  for (const match of html.matchAll(tagRegex)) {
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

  let result = html;
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

  if (text.length <= maxLen) {
    return balanceHtmlTags(text);
  }

  const reserve = options?.reserveLength ?? 30;
  const ellipsis = options?.ellipsis ?? "\n\n<i>...[truncated]</i>";

  let truncated = text.substring(0, maxLen - reserve);
  const lastNewline = truncated.lastIndexOf("\n");
  const minCutoff = maxLen - reserve - 400;
  if (lastNewline > minCutoff && lastNewline > 0) {
    truncated = truncated.substring(0, lastNewline);
  }

  // Strip broken opening tag truncated mid-attribute and cut entities
  truncated = truncated.replace(/<[^>]*$/, "").replace(/&[a-zA-Z0-9#]*$/, "");

  const balanced = balanceHtmlTags(truncated);
  return balanced + ellipsis;
}
