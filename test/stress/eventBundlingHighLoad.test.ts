import { describe, it, expect } from "vitest";
import { DiffEvent } from "../../src/types/domain.js";
import { formatBundledAlertMessage } from "../../src/bot/notifier/formatters/bundleAlertFormatter.js";
import { PackedUserProfile } from "../../src/bot/notifier/subscriberIndex.js";
import { performance } from "perf_hooks";

describe("🔥 STRESS: High-Volume Alert Bundling (500+ Slot Events)", () => {
  it("1. Accurately formats and deduplicates buttons for 500 simultaneous slot events", () => {
    const user: PackedUserProfile = {
      userId: 1,
      telegramId: 123456,
      language: "uk",
      isMuted: false,
      isActive: true,
      notifyAvailableGlobal: true,
      notifySoldOutGlobal: true,
      notifyModelsGlobal: true,
      notifyPricesGlobal: true,
    };

    const events: Array<{ event: DiffEvent; priority: "P1" }> = [];
    for (let i = 0; i < 500; i++) {
      events.push({
        event: {
          id: `diff-${i}`,
          poolSlug: `pool-${i % 10}`,
          poolName: `Compute Pool ${i % 10}`,
          block: `block-${i % 5}`,
          type: "SLOT_APPEARED",
          newStatus: "available",
          newPrice: `${49 + (i % 100)}`,
          timestamp: Date.now(),
        },
        priority: "P1",
      });
    }

    const t0 = performance.now();
    const bundle = formatBundledAlertMessage(user, events);
    const duration = performance.now() - t0;

    expect(duration).toBeLessThan(30); // Bundling 500 events < 30ms
    expect(bundle.keyboard).toBeDefined();

    // Button packing invariant: Never exceeds MAX_BUNDLE_BUTTONS (4 buttons)
    const totalButtons = bundle.keyboard!.inline_keyboard.flat().length;
    expect(totalButtons).toBeLessThanOrEqual(4);
    expect(bundle.text.length).toBeLessThanOrEqual(4096); // Telegram character limit
  });
});
