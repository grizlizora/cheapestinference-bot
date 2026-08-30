import { describe, it, expect } from "vitest";
import { DwrrScheduler } from "../../src/bot/notifier/queue/dwrrScheduler.js";
import { NotificationRateLimiter } from "../../src/bot/notifier/rateLimiter.js";
import { OutgoingAlertMessage } from "../../src/bot/notifier/types.js";

describe("🔥 STRESS: DWRR Scheduler Fairness, Scan Window & Load Shedding", () => {
  it("1. Verifies 10:5:2:1 proportional quantum distribution under 10,000 message saturation", () => {
    const rateLimiter = new NotificationRateLimiter();
    const scheduler = new DwrrScheduler(rateLimiter);

    // Populate all 4 queues with 2,500 messages each (10,000 total)
    for (let i = 0; i < 2500; i++) {
      scheduler.enqueue({
        id: `p0-${i}`,
        telegramId: 100000 + i,
        userId: i,
        poolSlug: "p",
        blockId: "b",
        eventType: "ALERT",
        text: "t",
        isMuted: false,
        priority: "P0",
        retries: 0,
        enqueuedAt: Date.now(),
      });
      scheduler.enqueue({
        id: `p1-${i}`,
        telegramId: 200000 + i,
        userId: i,
        poolSlug: "p",
        blockId: "b",
        eventType: "ALERT",
        text: "t",
        isMuted: false,
        priority: "P1",
        retries: 0,
        enqueuedAt: Date.now(),
      });
      scheduler.enqueue({
        id: `p2-${i}`,
        telegramId: 300000 + i,
        userId: i,
        poolSlug: "p",
        blockId: "b",
        eventType: "ALERT",
        text: "t",
        isMuted: false,
        priority: "P2",
        retries: 0,
        enqueuedAt: Date.now(),
      });
      scheduler.enqueue({
        id: `p3-${i}`,
        telegramId: 400000 + i,
        userId: i,
        poolSlug: "p",
        blockId: "b",
        eventType: "ALERT",
        text: "t",
        isMuted: false,
        priority: "P3",
        retries: 0,
        enqueuedAt: Date.now(),
      });
    }

    const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
    // Drain 1,800 messages (100 full rounds: 10 + 5 + 2 + 1 = 18 per round)
    for (let i = 0; i < 1800; i++) {
      const item = scheduler.selectNextItemDWRR(true);
      if (item) counts[item.priority]++;
    }

    expect(counts.P0).toBe(1000); // 100 * 10
    expect(counts.P1).toBe(500);  // 100 * 5
    expect(counts.P2).toBe(200);  // 100 * 2
    expect(counts.P3).toBe(100);  // 100 * 1

    rateLimiter.close();
  });

  it("2. Verifies candidate search window (32 items) and detects Head-of-Line boundary correctly", () => {
    const rateLimiter = new NotificationRateLimiter();
    const scheduler = new DwrrScheduler(rateLimiter);

    // Rate-limit a specific user
    const blockedTgId = 999;
    rateLimiter.recordUserDispatch(blockedTgId, performance.now()); // dispatched 0ms ago

    // Fill P1 with 32 messages for the blocked user, and 1 message for an eligible user (id: 123)
    for (let i = 0; i < 32; i++) {
      scheduler.enqueue({
        id: `p1-blocked-${i}`,
        telegramId: blockedTgId,
        userId: 1,
        poolSlug: "p",
        blockId: "b",
        eventType: "ALERT",
        text: "t",
        isMuted: false,
        priority: "P1",
        retries: 0,
        enqueuedAt: Date.now(),
      });
    }
    scheduler.enqueue({
      id: "p1-eligible-1",
      telegramId: 123,
      userId: 2,
      poolSlug: "p",
      blockId: "b",
      eventType: "ALERT",
      text: "t",
      isMuted: false,
      priority: "P1",
      retries: 0,
      enqueuedAt: Date.now(),
    });

    // Pop attempt: Since scanLimit is 32, candidate 33 is not reached within a single popValidCandidate pass
    const popped = scheduler.popValidCandidate(scheduler.p1Queue, false);
    expect(popped).toBeNull(); // Correctly documents HoL boundary behavior

    // Queue integrity invariant: All 33 items must remain intact in FIFO order
    expect(scheduler.p1Queue.size()).toBe(33);

    rateLimiter.close();
  });
});
