import { describe, it, expect } from "vitest";
import { stripLeadingEmoji, SUPPORTED_LANGUAGES, SupportedLanguage } from "../src/i18n/index.js";
import { toValidUtf8, safeUnicodeSlice, truncateToTelegramLimit } from "../src/bot/notifier/htmlTagBalancer.js";
import { renderDashboardText, computePoolBadgeInfo } from "../src/bot/views/dashboardView.js";
import { renderPoolDetailText } from "../src/bot/views/poolDetailView.js";
import { formatAlertMessage, formatBundledAlertMessage } from "../src/bot/notifier/alertFormatter.js";
import { DiffEvent } from "../src/types/domain.js";
import { PackedUserProfile } from "../src/bot/notifier/subscriberIndex.js";
import uk from "../src/i18n/locales/uk.json" with { type: "json" };
import en from "../src/i18n/locales/en.json" with { type: "json" };
import ru from "../src/i18n/locales/ru.json" with { type: "json" };

function createMockContext(lang: SupportedLanguage = "uk") {
  return {
    lang,
    from: { id: 828157777 },
    session: { tempPoolSlug: "frontier" },
    t: (key: string, params?: any) => {
      const dict = lang === "uk" ? uk : lang === "ru" ? ru : en;
      const keys = key.split(".");
      let val: any = dict;
      for (const k of keys) {
        val = val?.[k];
      }
      let str = typeof val === "string" ? val : key;
      if (params) {
        for (const [pk, pv] of Object.entries(params)) {
          str = str.replace(new RegExp(`{${pk}}`, "g"), String(pv));
        }
      }
      return str;
    },
  } as any;
}

function createMockPoolStateDao(availableCount = 3, totalBlocks = 3) {
  return {
    getPoolSummaries: () => [
      {
        slug: "flagship",
        name: "Flagship Pool",
        min_price: "149.00",
        models: ["kimi-k3", "qwen3.8-max"],
        available_count: 0,
        total_blocks: 3,
        updated_at: Date.now(),
      },
      {
        slug: "core",
        name: "Core Pool",
        min_price: "17.99",
        models: ["mimo-v2.5", "deepseek-v4-flash"],
        available_count: availableCount,
        total_blocks: totalBlocks,
        updated_at: Date.now(),
      },
      {
        slug: "frontier",
        name: "Frontier Pool",
        min_price: "59.00",
        models: ["minimax-m3", "glm-5.2"],
        available_count: 3,
        total_blocks: 3,
        updated_at: Date.now(),
      },
    ],
    getPoolBlocks: (slug: string) => [
      {
        pool_name: slug.toUpperCase() + " Pool",
        block_id: "asia",
        status: "available",
        hours_utc: "00:00 – 08:00 UTC",
        price_month: "59.00",
        min_price_day: "1.97",
        models: ["deepseek-r1", "glm-5.3"],
      },
      {
        pool_name: slug.toUpperCase() + " Pool",
        block_id: "europe",
        status: "sold-out",
        hours_utc: "08:00 – 16:00 UTC",
        price_month: "59.00",
        min_price_day: "1.97",
        models: ["deepseek-r1", "glm-5.3"],
      },
      {
        pool_name: slug.toUpperCase() + " Pool",
        block_id: "americas",
        status: "available",
        hours_utc: "16:00 – 24:00 UTC",
        price_month: "59.00",
        min_price_day: "1.97",
        models: ["deepseek-r1", "glm-5.3"],
      },
    ],
    getLastVerified: () => ({ timestamp: Date.now() }),
  } as any;
}

function hasLoneSurrogates(str: string): boolean {
  // Test if string contains an unpaired high surrogate or unpaired low surrogate
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: must be followed by a low surrogate
      if (i + 1 >= str.length) return true;
      const nextCode = str.charCodeAt(i + 1);
      if (nextCode < 0xdc00 || nextCode > 0xdfff) return true;
      i++; // Skip the pair
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Unpaired low surrogate found!
      return true;
    }
  }
  return false;
}

describe("🛡️ Unicode Surrogate Invariants & UTF-8 Zero-Corruption Suite (unicodeSurrogateInvariants.test.ts)", () => {
  describe("1. stripLeadingEmoji() Surrogate Safety", () => {
    it("should cleanly strip leading astral-plane emojis without leaving orphaned low surrogates", () => {
      const testCases = [
        { input: "🟢 Доступно", expected: "Доступно" },
        { input: "🔴 Розпродано (0/3 блоків вільно)", expected: "Розпродано (0/3 блоків вільно)" },
        { input: "🟡 Частково вільно", expected: "Частково вільно" },
        { input: "📦 Flagship Pool", expected: "Flagship Pool" },
        { input: "⚡ Забрати слот", expected: "Забрати слот" },
        { input: "🔥 Історичний мінімум", expected: "Історичний мінімум" },
        { input: "📉 Знижка 20%", expected: "Знижка 20%" },
        { input: "📈 Підвищення", expected: "Підвищення" },
        { input: "🏷️ Вартість", expected: "Вартість" }, // Emoji with variation selector \uFE0F
        { input: "👨‍💻 Написати автору", expected: "Написати автору" }, // ZWJ sequence
      ];

      for (const { input, expected } of testCases) {
        const stripped = stripLeadingEmoji(input);
        expect(stripped).toBe(expected);
        expect(hasLoneSurrogates(stripped)).toBe(false);
        expect(stripped.includes("\udd34")).toBe(false);
        expect(stripped.includes("\udfe2")).toBe(false);
        expect(stripped.includes("\udce6")).toBe(false);
      }
    });
  });

  describe("2. toValidUtf8() and safeUnicodeSlice() Invariants", () => {
    it("should sanitize and remove any synthetic lone surrogates", () => {
      // Create a corrupted string containing an orphaned low surrogate \udd34 and high surrogate \ud83d
      const corrupted = "Status: \udd34 Sold out \ud83d next";
      expect(hasLoneSurrogates(corrupted)).toBe(true);

      const sanitized = toValidUtf8(corrupted);
      expect(hasLoneSurrogates(sanitized)).toBe(false);
      expect(sanitized).toBe("Status:  Sold out  next");
    });

    it("should never bisect a surrogate pair when slicing at exact pair boundary", () => {
      const textWithEmoji = "Header: " + "🟢".repeat(100); // Each 🟢 is 2 code units
      // Cut at odd boundary where high surrogate lands at slice end
      const sliced = safeUnicodeSlice(textWithEmoji, 0, 9); // Index 8 is high surrogate of 1st emoji
      expect(hasLoneSurrogates(sliced)).toBe(false);
      expect(sliced.endsWith("\uD83D")).toBe(false);
    });

    it("should produce 100% valid UTF-8 during message truncation", () => {
      const longText = "<b>Important</b>\n" + "🟢 Node active\n".repeat(500);
      const truncated = truncateToTelegramLimit(longText, 400);

      expect(hasLoneSurrogates(truncated)).toBe(false);
      expect(truncated.length).toBeLessThanOrEqual(400);
    });
  });

  describe("3. Real-World Rendered Views UTF-8 Verification (UK, EN, RU)", () => {
    it("should render Dashboard text in UK, EN, and RU with 0 lone surrogates and 0 JSON escapes", () => {
      for (const lang of SUPPORTED_LANGUAGES) {
        const ctx = createMockContext(lang);
        const dao = createMockPoolStateDao();
        const rendered = renderDashboardText(ctx, dao);

        // 1. Invariant: Must not have lone surrogates
        expect(hasLoneSurrogates(rendered)).toBe(false);

        // 2. Invariant: toWellFormed() must equal rendered
        expect(rendered.toWellFormed()).toBe(rendered);

        // 3. Invariant: JSON serialization must contain zero lone surrogate escape sequences
        const json = JSON.stringify({ text: rendered });
        expect(json).not.toMatch(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/);
        expect(json).not.toContain("\\udd34");
        expect(json).not.toContain("\\udfe2");
      }
    });

    it("should render Pool Detail text in UK, EN, and RU with 0 lone surrogates", () => {
      for (const lang of SUPPORTED_LANGUAGES) {
        const ctx = createMockContext(lang);
        const dao = createMockPoolStateDao();
        const rendered = renderPoolDetailText(ctx, dao);

        expect(hasLoneSurrogates(rendered)).toBe(false);
        expect(rendered.toWellFormed()).toBe(rendered);

        const json = JSON.stringify({ text: rendered });
        expect(json).not.toMatch(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/);
      }
    });
  });

  describe("4. All 7 Alert Formats & Bundled Digests UTF-8 Invariant", () => {
    const mockUser: PackedUserProfile = {
      userId: 1,
      telegramId: 828157777,
      language: "uk",
      isMuted: false,
      role: "admin",
      notifyAvailableGlobal: true,
      notifySoldOutGlobal: true,
      notifyModelsGlobal: true,
      notifyPricesGlobal: true,
      updatedAt: Date.now(),
    };

    const eventTypes: DiffEvent[] = [
      {
        id: "e1",
        type: "SLOT_APPEARED",
        poolSlug: "frontier",
        poolName: "Frontier Pool",
        block: "europe",
        models: ["deepseek-r1"],
        hoursUtc: "08:00 – 16:00 UTC",
        newPrice: "149",
        newStatus: "available",
        timestamp: Date.now(),
        analytics: { demandCategory: "hot", avgLifespanFormatted: "12 хв" },
      },
      {
        id: "e2",
        type: "SLOT_DISAPPEARED",
        poolSlug: "flagship",
        poolName: "Flagship Pool",
        block: "asia",
        timestamp: Date.now(),
        analytics: {
          eta: {
            isPredictable: true,
            confidence: "HIGH",
            confidenceScore: 0.9,
            detectedCadenceHours: 24,
            formattedEtaWindow: "добовий цикл ~24h",
            sampleCount: 5,
            minRequired: 3,
          },
        },
      },
      {
        id: "e3",
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
          priceAnalytics: { rating: "all_time_low", minPrice: 49, maxPrice: 69, avgPrice: 59, sampleCount: 4 },
        },
      },
      {
        id: "e4",
        type: "POOL_BASE_PRICE_CHANGED",
        poolSlug: "core",
        poolName: "Core Pool",
        block: "ALL",
        previousPrice: "69",
        newPrice: "49",
        timestamp: Date.now(),
        basePrice: { priceDelta: -20, percentageDelta: -28.9 },
      },
      {
        id: "e5",
        type: "MODEL_UPGRADE_EVENT",
        poolSlug: "flagship",
        poolName: "Flagship Pool",
        block: "ALL",
        models: ["claude-3-7-sonnet"],
        timestamp: Date.now(),
        modelUpgrade: {
          added: [{ type: "added", modelName: "claude-3-7-sonnet", family: "claude" }],
          upgraded: [],
          removed: [],
          allActiveModels: ["claude-3-7-sonnet"],
        },
      },
      {
        id: "e6",
        type: "TIER_UPDATED_EVENT",
        poolSlug: "frontier",
        poolName: "Frontier Pool",
        block: "ALL",
        timestamp: Date.now(),
        tierUpdate: { newDescription: "Ultra-fast inference" },
      },
      {
        id: "e7",
        type: "NEW_POOL_EVENT",
        poolSlug: "quantum",
        poolName: "Quantum Pool",
        block: "ALL",
        newPrice: "199",
        timestamp: Date.now(),
        metadata: { description: "Quantum compute" },
      },
    ];

    for (const evt of eventTypes) {
      it(`should format ${evt.type} alert with zero lone surrogates across all languages`, () => {
        for (const lang of SUPPORTED_LANGUAGES) {
          const user = { ...mockUser, language: lang };
          const alert = formatAlertMessage(user, evt, "P0");

          expect(hasLoneSurrogates(alert.text)).toBe(false);
          expect(alert.text.toWellFormed()).toBe(alert.text);

          const json = JSON.stringify({ text: alert.text });
          expect(json).not.toMatch(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/);
        }
      });
    }

    it("should format bundled digest with zero lone surrogates across all languages", () => {
      for (const lang of SUPPORTED_LANGUAGES) {
        const user = { ...mockUser, language: lang };
        const bundle = formatBundledAlertMessage(user, [
          { event: eventTypes[0], priority: "P0" },
          { event: eventTypes[1], priority: "P1" },
        ]);

        expect(hasLoneSurrogates(bundle.text)).toBe(false);
        expect(bundle.text.toWellFormed()).toBe(bundle.text);

        const json = JSON.stringify({ text: bundle.text });
        expect(json).not.toMatch(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/);
      }
    });
  });

  describe("5. Localization Dictionaries Pure UTF-8 Verification", () => {
    function verifyDictValues(obj: any, path = ""): void {
      for (const [k, v] of Object.entries(obj)) {
        const currPath = path ? `${path}.${k}` : k;
        if (typeof v === "string") {
          expect(
            hasLoneSurrogates(v),
            `Locale key ${currPath} contains lone surrogate`
          ).toBe(false);
          expect(v.toWellFormed(), `Locale key ${currPath} is not well formed`).toBe(v);
        } else if (typeof v === "object" && v !== null) {
          verifyDictValues(v, currPath);
        }
      }
    }

    it("should verify 100% of keys in uk.json, en.json, ru.json are valid well-formed UTF-8", () => {
      verifyDictValues(uk, "uk");
      verifyDictValues(en, "en");
      verifyDictValues(ru, "ru");
    });
  });
});
