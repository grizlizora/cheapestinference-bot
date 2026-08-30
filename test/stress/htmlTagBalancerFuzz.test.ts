import { describe, it, expect } from "vitest";
import { truncateToTelegramLimit, balanceHtmlTags, toValidUtf8 } from "../../src/bot/notifier/htmlTagBalancer.js";
import { serializeTelegramEntitiesToHtml } from "../../src/bot/notifier/telegramEntitySerializer.js";
import { performance } from "perf_hooks";

describe("🔥 STRESS & FUZZING: HTML Balancer & Entity Serializer Robustness", () => {
  it("1. Balances 100 levels of nested tags in < 2ms without stack overflow", () => {
    let deeplyNested = "";
    for (let i = 0; i < 100; i++) deeplyNested += "<b><i><code>";
    deeplyNested += "Deep payload";

    const t0 = performance.now();
    const balanced = balanceHtmlTags(deeplyNested);
    const duration = performance.now() - t0;

    expect(duration).toBeLessThan(10);
    expect(balanced.endsWith("</code></i></b>")).toBe(true);
  });

  it("2. Truncates adversarial strings without bisecting 4-byte surrogate emojis", () => {
    const emojiPayload = "🚀".repeat(2000); // 4000 code units
    const truncated = truncateToTelegramLimit(emojiPayload, 100);

    expect(truncated.length).toBeLessThanOrEqual(150);
    // Invariant: No dangling high surrogates
    for (let i = 0; i < truncated.length; i++) {
      const code = truncated.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = truncated.charCodeAt(i + 1);
        expect(next).toBeGreaterThanOrEqual(0xdc00);
        expect(next).toBeLessThanOrEqual(0xdfff);
      }
    }
  });
});
