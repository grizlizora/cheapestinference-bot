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
 * Truncates text to Telegram message length limits and balances unclosed HTML tags using a LIFO stack.
 */
export function truncateToTelegramLimit(
  text: string,
  maxLen: number = 3900,
  options?: TruncateOptions
): string {
  if (!text || text.length <= maxLen) {
    return text || "";
  }

  const reserve = options?.reserveLength ?? 30;
  const ellipsis = options?.ellipsis ?? "\n\n<i>...[truncated]</i>";

  let truncated = text.substring(0, maxLen - reserve);
  const lastNewline = truncated.lastIndexOf("\n");
  if (lastNewline > maxLen / 2) {
    truncated = truncated.substring(0, lastNewline);
  }

  // Strip broken opening tag truncated mid-attribute
  truncated = truncated.replace(/<[^>]*$/, "");

  // Strict LIFO tag stack for 100% valid HTML closing
  const stack: string[] = [];
  const tagRegex = /<\/?([a-z0-9_-]+)[^>]*>/gi;

  for (const match of truncated.matchAll(tagRegex)) {
    const fullTag = match[0];
    const tagName = match[1].toLowerCase();

    if (VOID_TAGS.has(tagName)) continue;

    if (fullTag.startsWith("</")) {
      // Closing tag: pop matching tag from top of stack if present
      const lastIndex = stack.lastIndexOf(tagName);
      if (lastIndex !== -1) {
        stack.splice(lastIndex, 1);
      }
    } else {
      // Opening tag: push onto LIFO stack
      stack.push(tagName);
    }
  }

  // Close all lingering open tags in reverse LIFO order
  while (stack.length > 0) {
    const tagToClose = stack.pop();
    truncated += `</${tagToClose}>`;
  }

  return truncated + ellipsis;
}
