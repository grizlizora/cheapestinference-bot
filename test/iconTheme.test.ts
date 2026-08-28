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
import {
  formatAlertMessage,
  formatBundledAlertMessage,
  formatPriceRatingBadge,
  formatPriceDeltaBadge,
} from "../src/bot/notifier/alertFormatter.js";
import { PackedUserProfile } from "../src/bot/notifier/subscriberIndex.js";
import { DiffEvent } from "../src/types/domain.js";
import { computePoolBadgeInfo } from "../src/bot/views/dashboardView.js";
import { getBlockIcon } from "../src/bot/views/poolDetailView.js";

function createMockUser(lang: "uk" | "en" | "ru" = "uk"): PackedUserProfile {
  return {
    userId: 1,
    telegramId: 828157777,
    language: lang,
    isMuted: false,
    role: "admin",
    notifyAvailableGlobal: true,
    notifySoldOutGlobal: true,
    notifyModelsGlobal: true,
    notifyPricesGlobal: true,
    updatedAt: Date.now(),
  };
}

describe("🎨 Telegram Custom Animated Iconography & Real-World E2E Simulation (iconTheme.ts)", () => {
  beforeEach(() => {
    // Reset to default custom_emoji mode with no overrides
    setIconThemeConfig({
      mode: "custom_emoji",
      overrides: {},
    });
  });

  describe("1. Master Icon Registry & Fallback Fidelity (54 Keys)", () => {
    it("should register 54 valid icons with 64-bit Telegram emoji IDs and Unicode fallbacks", () => {
      const keys = Object.keys(ICON_REGISTRY) as IconKey[];
      expect(keys.length).toBeGreaterThanOrEqual(54);

      for (const key of keys) {
        const def = ICON_REGISTRY[key];
        expect(def.customEmojiId).toMatch(/^\d{18,20}$/); // 64-bit Telegram emoji ID format
        expect(def.unicodeFallback.length).toBeGreaterThanOrEqual(1);
        expect(def.name.length).toBeGreaterThan(0);

        const rendered = icon(key);
        expect(rendered).toBe(`<tg-emoji emoji-id="${def.customEmojiId}">${def.unicodeFallback}</tg-emoji>`);
        expect(getRawUnicode(key)).toBe(def.unicodeFallback);
      }
    });

    it("should gracefully handle unknown keys with safe fallback", () => {
      const unknownRendered = (icon as any)("non_existent_key", "❓");
      expect(unknownRendered).toBe("❓");

      const defaultFallback = (icon as any)("non_existent_key");
      expect(defaultFallback).toBe("🔹");
    });
  });

  describe("2. Configuration Modes & Runtime Sticker Pack Overrides", () => {
    it("should support instant Unicode-only mode with zero HTML tags", () => {
      setIconThemeConfig({ mode: "unicode_only" });

      expect(icon("status_available")).toBe("🟢");
      expect(icon("status_sold_out")).toBe("🔴");
      expect(icon("pool_flagship")).toBe("🚀");
      expect(icon("event_slot_drop")).toBe("⚡");
      expect(icon("region_asia")).toBe("🌏");
      expect(icon("price_all_time_low")).toBe("🔥");
      expect(icon("prediction_crystal")).toBe("🔮");
    });

    it("should support MarkdownV2 format mode", () => {
      setIconThemeConfig({ mode: "markdown_v2" });

      const rendered = icon("status_available");
      expect(rendered).toBe(`![🟢](tg://emoji?id=${ICON_REGISTRY.status_available.customEmojiId})`);
    });

    it("should allow dynamic sticker pack overrides from custom @Stickers packs", () => {
      setIconThemeConfig({
        overrides: {
          status_available: "5999000111222333444",
          pool_flagship: "5999000111222333555",
        },
      });

      expect(icon("status_available")).toBe('<tg-emoji emoji-id="5999000111222333444">🟢</tg-emoji>');
      expect(icon("pool_flagship")).toBe('<tg-emoji emoji-id="5999000111222333555">🚀</tg-emoji>');
      // Non-overridden icons remain in default pack
      expect(icon("status_sold_out")).toBe(`<tg-emoji emoji-id="${ICON_REGISTRY.status_sold_out.customEmojiId}">🔴</tg-emoji>`);
    });
  });

  describe("3. Visual Semantic Context Appropriateness Audit", () => {
    it("should map geographic regions to matching 3D rotating globe icons", () => {
      expect(getRegionalGlobeIcon("asia")).toContain(ICON_REGISTRY.region_asia.customEmojiId);
      expect(getRegionalGlobeIcon("asia")).toContain("🌏");
      expect(getBlockIcon("asia")).toContain("🌏");

      expect(getRegionalGlobeIcon("europe")).toContain(ICON_REGISTRY.region_europe.customEmojiId);
      expect(getRegionalGlobeIcon("europe")).toContain("🌍");
      expect(getBlockIcon("europe")).toContain("🌍");

      expect(getRegionalGlobeIcon("americas")).toContain(ICON_REGISTRY.region_americas.customEmojiId);
      expect(getRegionalGlobeIcon("americas")).toContain("🌎");
      expect(getBlockIcon("americas")).toContain("🌎");

      expect(getRegionalGlobeIcon("unknown_region")).toContain(ICON_REGISTRY.region_all.customEmojiId);
      expect(getRegionalGlobeIcon("unknown_region")).toContain("🌐");
    });

    it("should map capacity levels to accurate breathing orbs", () => {
      // 100% capacity available -> Green
      const orbFull = getCapacityOrbIcon(3, 3);
      expect(orbFull).toContain("🟢");
      expect(orbFull).toContain(ICON_REGISTRY.status_available.customEmojiId);

      // Partial capacity (e.g. 1/3) -> Amber
      const orbPartial = getCapacityOrbIcon(1, 3);
      expect(orbPartial).toContain("🟡");
      expect(orbPartial).toContain(ICON_REGISTRY.status_partially_available.customEmojiId);

      // Sold out (0/3) -> Red
      const orbEmpty = getCapacityOrbIcon(0, 3);
      expect(orbEmpty).toContain("🔴");
      expect(orbEmpty).toContain(ICON_REGISTRY.status_sold_out.customEmojiId);
    });

    it("should provide raw Unicode for inline keyboard buttons and <tg-emoji> for HTML message text", () => {
      const badgeAvailable = computePoolBadgeInfo(3, 3);
      expect(badgeAvailable.icon).toBe("🟢"); // Raw Unicode for InlineKeyboardButton
      expect(badgeAvailable.iconHtml).toContain("<tg-emoji"); // HTML tag for Message Body

      const badgeSoldOut = computePoolBadgeInfo(0, 3);
      expect(badgeSoldOut.icon).toBe("🔴"); // Raw Unicode for InlineKeyboardButton
      expect(badgeSoldOut.iconHtml).toContain("<tg-emoji"); // HTML tag for Message Body
    });
  });

  describe("4. Real-World Telegram Bot Alert & Message Dispatch Simulation", () => {
    it("should format SLOT_APPEARED alert with animated drop icon, status orb, and clean checkout button", () => {
      const user = createMockUser("uk");
      const event: DiffEvent = {
        id: "evt-slot-1",
        type: "SLOT_APPEARED",
        poolSlug: "frontier",
        poolName: "Frontier Pool",
        block: "europe",
        models: ["deepseek-r1", "glm-5.3"],
        hoursUtc: "08:00 – 16:00 UTC",
        newPrice: "149",
        newStatus: "available",
        timestamp: Date.now(),
        analytics: {
          demandCategory: "hot",
          avgLifespanFormatted: "12 хв",
        },
      };

      const alert = formatAlertMessage(user, event, "P0");

      // Verify HTML Message Body contains animated custom emojis
      expect(alert.text).toContain(`<tg-emoji emoji-id="${ICON_REGISTRY.status_available.customEmojiId}">🟢</tg-emoji>`);
      expect(alert.text).toContain(`<tg-emoji emoji-id="${ICON_REGISTRY.event_hot_slot.customEmojiId}">🔥</tg-emoji>`);
      expect(alert.text).toContain("Frontier Pool");
      expect(alert.text).toContain("Європа");
      expect(alert.text).toContain("$149/міс");

      // Verify Inline Keyboard button uses RAW text and NEVER contains unparsed HTML tags!
      expect(alert.keyboard).toBeDefined();
      const keyboardJson = JSON.stringify(alert.keyboard);
      expect(keyboardJson).not.toContain("<tg-emoji");
      expect(keyboardJson).not.toContain("</tg-emoji>");
      expect(keyboardJson).toContain("pools/frontier#europe");
      expect(keyboardJson).toContain("149");
    });

    it("should format SLOT_DISAPPEARED alert with animated lock and prediction crystal", () => {
      const user = createMockUser("uk");
      const event: DiffEvent = {
        id: "evt-slot-sold",
        type: "SLOT_DISAPPEARED",
        poolSlug: "flagship",
        poolName: "Flagship Pool",
        block: "asia",
        timestamp: Date.now(),
        analytics: {
          eta: {
            isPredictable: true,
            confidence: "HIGH",
            confidenceScore: 0.88,
            detectedCadenceHours: 24,
            formattedEtaWindow: "добовий цикл ~24h",
            sampleCount: 5,
            minRequired: 3,
          },
        },
      };

      const alert = formatAlertMessage(user, event, "P2");

      expect(alert.text).toContain(`<tg-emoji emoji-id="${ICON_REGISTRY.event_slot_sold.customEmojiId}">🔒</tg-emoji>`);
      expect(alert.text).toContain(`<tg-emoji emoji-id="${ICON_REGISTRY.prediction_crystal.customEmojiId}">🔮</tg-emoji>`);
      expect(alert.text).toContain(`<tg-emoji emoji-id="${ICON_REGISTRY.status_available.customEmojiId}">🟢</tg-emoji>`);
      expect(alert.text).toContain("Flagship Pool");
      expect(alert.text).toContain("добовий цикл ~24h");
    });

    it("should format SLOT_PRICE_CHANGED with discount trend and All-Time Low (ATL) rating badge", () => {
      const user = createMockUser("uk");
      const event: DiffEvent = {
        id: "evt-price-atl",
        type: "SLOT_PRICE_CHANGED",
        poolSlug: "core",
        poolName: "Core Pool",
        block: "americas",
        previousPrice: "69",
        newPrice: "49",
        hoursUtc: "16:00 – 24:00 UTC",
        timestamp: Date.now(),
        slotPrice: {
          priceDelta: -20,
          percentageDelta: -28.9,
          priceAnalytics: {
            rating: "all_time_low",
            minPrice: 49,
            maxPrice: 69,
            avgPrice: 59,
            sampleCount: 4,
          },
        },
      };

      const alert = formatAlertMessage(user, event, "P1");

      expect(alert.text).toContain(`<tg-emoji emoji-id="${ICON_REGISTRY.event_price_drop.customEmojiId}">📉</tg-emoji>`);
      expect(alert.text).toContain(`<tg-emoji emoji-id="${ICON_REGISTRY.price_all_time_low.customEmojiId}">🔥</tg-emoji>`);
      expect(alert.text).toContain("Core Pool");
      expect(alert.text).toContain("49");
    });

    it("should format MODEL_UPGRADE_EVENT with model ascension rocket and clean model code blocks", () => {
      const user = createMockUser("uk");
      const event: DiffEvent = {
        id: "evt-model-up",
        type: "MODEL_UPGRADE_EVENT",
        poolSlug: "flagship",
        poolName: "Flagship Pool",
        block: "ALL",
        models: ["claude-3-7-sonnet", "deepseek-r1"],
        timestamp: Date.now(),
        modelUpgrade: {
          added: [{ type: "added", modelName: "deepseek-r1", family: "deepseek" }],
          upgraded: [{ type: "upgraded", modelName: "claude-3-7-sonnet", previousModelName: "claude-3-5-sonnet", family: "claude" }],
          removed: [],
          allActiveModels: ["claude-3-7-sonnet", "deepseek-r1"],
        },
      };

      const alert = formatAlertMessage(user, event, "P1");

      expect(alert.text).toContain(`<tg-emoji emoji-id="${ICON_REGISTRY.event_model_upgrade.customEmojiId}">🚀</tg-emoji>`);
      expect(alert.text).toContain("claude-3-7-sonnet");
      expect(alert.text).toContain("deepseek-r1");
    });

    it("should format multi-pool bundled alert digest with batch drop icon and clock footer", () => {
      const user = createMockUser("uk");
      const events = [
        {
          event: {
            id: "e1",
            type: "SLOT_APPEARED",
            poolSlug: "frontier",
            poolName: "Frontier Pool",
            block: "europe",
            hoursUtc: "08:00 – 16:00 UTC",
            newPrice: "149",
            models: ["deepseek-r1"],
            timestamp: Date.now(),
          } as DiffEvent,
          priority: "P0" as const,
        },
        {
          event: {
            id: "e2",
            type: "SLOT_DISAPPEARED",
            poolSlug: "core",
            poolName: "Core Pool",
            block: "asia",
            timestamp: Date.now(),
          } as DiffEvent,
          priority: "P1" as const,
        },
      ];

      const bundle = formatBundledAlertMessage(user, events);

      expect(bundle.text).toContain(`<tg-emoji emoji-id="${ICON_REGISTRY.event_batch_drop.customEmojiId}">🆕</tg-emoji>`);
      expect(bundle.text).toContain(`<tg-emoji emoji-id="${ICON_REGISTRY.status_available.customEmojiId}">🟢</tg-emoji>`);
      expect(bundle.text).toContain(`<tg-emoji emoji-id="${ICON_REGISTRY.event_slot_sold.customEmojiId}">🔒</tg-emoji>`);
      expect(bundle.text).toContain(`<tg-emoji emoji-id="${ICON_REGISTRY.nav_clock.customEmojiId}">🕒</tg-emoji>`);
    });
  });

  describe("5. HTML Parser Robustness & Truncation Safety", () => {
    it("should automatically close unclosed <tg-emoji> tags via balanceHtmlTags", () => {
      const unclosed = `<tg-emoji emoji-id="5368324170671202286">🟢`;
      const balanced = balanceHtmlTags(unclosed);
      expect(balanced).toBe(`<tg-emoji emoji-id="5368324170671202286">🟢</tg-emoji>`);
    });

    it("should safely truncate long texts with hundreds of <tg-emoji> without tag mutilation", () => {
      const singleItem = `${icon("status_available")} <b>Active Node</b> `;
      const massiveText = Array(200).fill(singleItem).join("\n");

      const truncated = truncateToTelegramLimit(massiveText, 600);

      expect(truncated.length).toBeLessThanOrEqual(600);
      expect(truncated).not.toMatch(/<tg-emoji[^>]*$/); // No unclosed opening tag attributes

      // Count open and closing tags to guarantee 100% balance
      const openCount = (truncated.match(/<tg-emoji/g) || []).length;
      const closeCount = (truncated.match(/<\/tg-emoji>/g) || []).length;
      expect(openCount).toBe(closeCount);
    });

    it("should never produce broken surrogate pairs (replacement characters) in multilingual strings", () => {
      const languages: Array<"uk" | "en" | "ru"> = ["uk", "en", "ru"];

      for (const lang of languages) {
        const rating = formatPriceRatingBadge(
          { rating: "below_average", minPrice: 10, maxPrice: 100, avgPrice: 50, sampleCount: 5 },
          35,
          lang
        );
        expect(rating).not.toContain("\uFFFD");
        expect(rating).toContain("<tg-emoji");

        const delta = formatPriceDeltaBadge(-15, -20, lang);
        expect(delta).not.toContain("\uFFFD");
      }
    });
  });
});
