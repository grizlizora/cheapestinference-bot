/**
 * src/bot/notifier/userActivitySyncer.ts
 * 30-Second Debounced Trailing Activity Syncer for SQLite & RAM
 */

import { UserDAO } from "../../db/dao/users.js";
import { SubscriberInvertedIndex } from "./subscriberIndex.js";

export class UserActivitySyncer {
  private pendingTouches = new Map<number, { timer: NodeJS.Timeout; timestamp: number }>();
  private readonly QUIET_THRESHOLD_MS = 30_000; // 30 seconds debounce window

  constructor(
    private userDao: UserDAO,
    private invertedIndex: SubscriberInvertedIndex
  ) {
    // Graceful process exit handler
    const onExit = () => this.flushAll();
    process.on("SIGINT", onExit);
    process.on("SIGTERM", onExit);
    process.on("beforeExit", onExit);
  }

  /**
   * Records a user interaction event:
   * 1. Updates RAM index immediately (0.001 ms).
   * 2. If initial touch (> 30s since last disk write), writes immediately to SQLite.
   * 3. Schedules/reschedules a 30s trailing timer to persist the exact final action timestamp.
   */
  public touch(telegramId: number, now: number = Date.now()): void {
    // 1. RAM Fast-Path
    this.invertedIndex.touchLastActive(telegramId, now);

    const profile = this.invertedIndex.getProfileByTgId(telegramId);
    const lastDbTouch = profile?.lastDbTouchAt || 0;

    // 2. Initial touch write if past quiet window
    if (now - lastDbTouch > this.QUIET_THRESHOLD_MS) {
      const iso = new Date(now).toISOString();
      this.userDao.touchLastActive(telegramId, iso);
      if (profile) profile.lastDbTouchAt = now;
    }

    // 3. Clear existing trailing timer and schedule fresh 30-second trailing sync
    const existing = this.pendingTouches.get(telegramId);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      this.flushUser(telegramId);
    }, this.QUIET_THRESHOLD_MS);

    // Unref timer so it does not block Node.js event loop shutdown
    timer.unref();

    this.pendingTouches.set(telegramId, { timer, timestamp: now });
  }

  /**
   * Flushes a specific user's pending trailing touch to SQLite
   */
  public flushUser(telegramId: number): void {
    const entry = this.pendingTouches.get(telegramId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pendingTouches.delete(telegramId);

    const iso = new Date(entry.timestamp).toISOString();
    this.userDao.touchLastActive(telegramId, iso);

    const profile = this.invertedIndex.getProfileByTgId(telegramId);
    if (profile) {
      profile.lastDbTouchAt = entry.timestamp;
    }
  }

  /**
   * Immediately flushes all pending trailing touches to SQLite
   * (Called before database backups, CSV exports, and server restarts)
   */
  public flushAll(): void {
    if (this.pendingTouches.size === 0) return;
    const entries = Array.from(this.pendingTouches.entries());
    this.pendingTouches.clear();

    for (const [telegramId, entry] of entries) {
      clearTimeout(entry.timer);
      const iso = new Date(entry.timestamp).toISOString();
      this.userDao.touchLastActive(telegramId, iso);

      const profile = this.invertedIndex.getProfileByTgId(telegramId);
      if (profile) {
        profile.lastDbTouchAt = entry.timestamp;
      }
    }
  }

  public getPendingCount(): number {
    return this.pendingTouches.size;
  }
}
