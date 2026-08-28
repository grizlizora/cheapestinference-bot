import { describe, it, expect, beforeEach } from "vitest";
import {
  icon,
  getRawUnicode,
  getRegionalGlobeIcon,
  getCapacityOrbIcon,
  setIconThemeConfig,
  ICON_REGISTRY,
  IconKey,
} from "../src/bot/views/iconTheme.js";
import { balanceHtmlTags, truncateToTelegramLimit } from "../src/bot/notifier/htmlTagBalancer.js";

describe("🎨 Telegram Custom Animated Iconography Engine (iconTheme.ts)", () => {
  beforeEach(() => {
    // Reset to default custom_emoji mode with no overrides
    setIconThemeConfig({
      mode: "custom_emoji",
      overrides: {},
    });
  });

  it("should render all 54 registered icons with valid <tg-emoji> HTML tags and fallbacks", () => {
    const keys = Object.keys(ICON_REGISTRY) as IconKey[];
    expect(keys.length).toBeGreaterThanOrEqual(54);

    for (const key of keys) {
      const def = ICON_REGISTRY[key];
      const rendered = icon(key);

      expect(rendered).toBe(`<tg-emoji emoji-id="${def.customEmojiId}">${def.unicodeFallback}</tg-emoji>`);
      expect(getRawUnicode(key)).toBe(def.unicodeFallback);
    }
  });

  it("should support unicode_only mode with instant fallback and zero tags", () => {
    setIconThemeConfig({ mode: "unicode_only" });

    expect(icon("status_available")).toBe("🟢");
    expect(icon("pool_flagship")).toBe("🚀");
    expect(icon("event_slot_drop")).toBe("⚡");
    expect(icon("region_asia")).toBe("🌏");
    expect(icon("price_all_time_low")).toBe("🔥");
  });

  it("should support markdown_v2 mode formatting", () => {
    setIconThemeConfig({ mode: "markdown_v2" });

    const rendered = icon("status_available");
    expect(rendered).toBe(`![🟢](tg://emoji?id=${ICON_REGISTRY.status_available.customEmojiId})`);
  });

  it("should allow dynamic pack ID overrides at runtime", () => {
    setIconThemeConfig({
      overrides: {
        status_available: "9999999999999999999",
      },
    });

    expect(icon("status_available")).toBe('<tg-emoji emoji-id="9999999999999999999">🟢</tg-emoji>');
    // Other icons remain unaffected
    expect(icon("status_sold_out")).toBe(`<tg-emoji emoji-id="${ICON_REGISTRY.status_sold_out.customEmojiId}">🔴</tg-emoji>`);
  });

  it("should resolve 3D regional globes correctly for all geographical blocks", () => {
    expect(getRegionalGlobeIcon("asia")).toContain("🌏");
    expect(getRegionalGlobeIcon("ASIA")).toContain("🌏");
    expect(getRegionalGlobeIcon("europe")).toContain("🌍");
    expect(getRegionalGlobeIcon("americas")).toContain("🌎");
    expect(getRegionalGlobeIcon("custom")).toContain("🌐");
  });

  it("should resolve capacity status orbs dynamically based on pool fullness", () => {
    expect(getCapacityOrbIcon(3, 3)).toContain("🟢");
    expect(getCapacityOrbIcon(1, 3)).toContain("🟡");
    expect(getCapacityOrbIcon(0, 3)).toContain("🔴");
  });

  it("should seamlessly balance unclosed <tg-emoji> tags in htmlTagBalancer", () => {
    const openTag = `<tg-emoji emoji-id="5368324170671202286">🟢`;
    const balanced = balanceHtmlTags(openTag);
    expect(balanced).toBe(`<tg-emoji emoji-id="5368324170671202286">🟢</tg-emoji>`);

    const nested = `<b>${icon("price_all_time_low")} <i>Hot Deal!`;
    const balancedNested = balanceHtmlTags(nested);
    expect(balancedNested).toContain("</i></b>");
  });

  it("should safely truncate long messages with <tg-emoji> tags without broken attributes", () => {
    const emojiStr = icon("status_available");
    const longText = Array(300).fill(emojiStr).join(" ");
    const truncated = truncateToTelegramLimit(longText, 500);

    expect(truncated.length).toBeLessThanOrEqual(500);
    expect(truncated).not.toContain("<tg-emoji emoji-id=\"5368324170671202286\">🟢</tg-emoji");
    // Ensure all opened tags are balanced
    const openCount = (truncated.match(/<tg-emoji/g) || []).length;
    const closeCount = (truncated.match(/<\/tg-emoji>/g) || []).length;
    expect(openCount).toBe(closeCount);
  });
});
