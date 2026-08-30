import { describe, it, expect, vi } from "vitest";
import { NotificationRateLimiter } from "../../src/bot/notifier/rateLimiter.js";

describe("🔥 STRESS: NotificationRateLimiter Burst & 429 Ceiling", () => {
  it("1. Strictly enforces 27 msg/s ceiling over 5 seconds of continuous token consumption", () => {
    const limiter = new NotificationRateLimiter({ targetRatePerSec: 27, maxBurstTokens: 25 });
    let totalConsumed = 0;
    const nowStart = performance.now();

    // Consume all 25 burst tokens initially
    while (limiter.consumeGlobalToken()) {
      totalConsumed++;
    }
    expect(totalConsumed).toBe(25);

    // Simulate 5 seconds in 50ms increments (100 ticks)
    for (let tick = 1; tick <= 100; tick++) {
      const simulatedNow = nowStart + tick * 50;
      vi.spyOn(performance, "now").mockReturnValue(simulatedNow);
      limiter.refillTokens();
      while (limiter.consumeGlobalToken()) {
        totalConsumed++;
      }
    }

    // Expected: 25 initial burst + (5s * 27 msg/s) = 160 tokens
    expect(totalConsumed).toBeGreaterThanOrEqual(158);
    expect(totalConsumed).toBeLessThanOrEqual(162);

    limiter.close();
  });

  it("2. Validates 429 backoff pause and automatic unpause after retry_after expires", () => {
    const limiter = new NotificationRateLimiter();
    expect(limiter.isGlobalPaused()).toBe(false);

    const startTime = performance.now();
    vi.spyOn(performance, "now").mockReturnValue(startTime);

    // Trigger 429 with retry_after = 3 seconds (pause = 3.5s)
    limiter.trigger429Backoff(3);
    expect(limiter.isGlobalPaused()).toBe(true);
    expect(limiter.hasAvailableTokens()).toBe(false);

    // Advance 2.0s -> Still paused
    vi.spyOn(performance, "now").mockReturnValue(startTime + 2000);
    expect(limiter.isGlobalPaused()).toBe(true);

    // Advance 3.6s -> Automatically unpaused
    vi.spyOn(performance, "now").mockReturnValue(startTime + 3600);
    expect(limiter.isGlobalPaused()).toBe(false);

    limiter.close();
  });
});
