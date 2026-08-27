/**
 * src/bot/notifier/dispatcher.ts
 * Deficit Weighted Round-Robin (DWRR) Notification Dispatcher
 */

import { Bot } from "grammy";
import { BotContext } from "../../types/context.js";
import { DiffEvent } from "../../types/domain.js";
import { UserDAO } from "../../db/dao/users.js";
import { NotificationLogDAO } from "../../db/dao/notificationLogs.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { SubscriberInvertedIndex, PackedUserProfile } from "./subscriberIndex.js";
import { CircularRingBuffer } from "./circularRingBuffer.js";
import { SupportedLanguage } from "../../i18n/index.js";
import { NotificationRateLimiter } from "./rateLimiter.js";
import {
  BroadcastPriority,
  OutgoingAlertMessage,
  formatAlertMessage,
  formatBundledAlertMessage,
  createTestAlertMessage,
} from "./alertFormatter.js";

export type { BroadcastPriority, OutgoingAlertMessage };
export { formatAlertMessage, formatBundledAlertMessage, createTestAlertMessage };

export class NotificationDispatcher {
  private index: SubscriberInvertedIndex;
  private rateLimiter: NotificationRateLimiter;

  // DWRR 4-Queue Ring Buffers
  private p0Queue = new CircularRingBuffer<OutgoingAlertMessage>(256);
  private p1Queue = new CircularRingBuffer<OutgoingAlertMessage>(16384);
  private p2Queue = new CircularRingBuffer<OutgoingAlertMessage>(8192);
  private p3Queue = new CircularRingBuffer<OutgoingAlertMessage>(4096);

  // Deficit Weighted Round-Robin (DWRR) Counters
  private p0Deficit = 0;
  private p1Deficit = 0;
  private p2Deficit = 0;
  private p3Deficit = 0;
  private readonly quantumP0 = 10;
  private readonly quantumP1 = 5;
  private readonly quantumP2 = 2;
  private readonly quantumP3 = 1;

  private isWorkerRunning = false;
  private readonly MAX_MESSAGE_AGE_MS = 10 * 60 * 1000; // 10 min TTL

  // Blocked users debounced batch
  private blockedUsersBatch: number[] = [];
  private batchFlushTimer?: NodeJS.Timeout;

  constructor(
    private bot: Bot<BotContext>,
    private userDao: UserDAO,
    private logDao: NotificationLogDAO,
    private historyDao?: SlotHistoryDAO,
    index?: SubscriberInvertedIndex,
    rateLimiter?: NotificationRateLimiter
  ) {
    this.index = index ?? new SubscriberInvertedIndex((userDao as any).db);
    this.rateLimiter = rateLimiter ?? new NotificationRateLimiter();

    this.batchFlushTimer = setInterval(() => this.flushBlockedUsersToDb(), 5000);
    this.batchFlushTimer.unref();
  }

  public getInvertedIndex(): SubscriberInvertedIndex {
    return this.index;
  }

  public getRateLimiter(): NotificationRateLimiter {
    return this.rateLimiter;
  }

  /**
   * Compatibility delegation for existing unit tests
   */
  public formatAlertMessage(
    user: PackedUserProfile,
    event: DiffEvent,
    priority: BroadcastPriority,
    cachedDurationFormatted?: string
  ): OutgoingAlertMessage {
    return formatAlertMessage(user, event, priority, cachedDurationFormatted);
  }

  public formatBundledAlertMessage(
    user: PackedUserProfile,
    matchedEvents: Array<{ event: DiffEvent; priority: BroadcastPriority }>
  ): OutgoingAlertMessage {
    return formatBundledAlertMessage(user, matchedEvents);
  }

  /**
   * Main entrypoint for processing DiffEvents from ScraperOrchestrator
   */
  public async handleDiffEvents(events: DiffEvent[]): Promise<void> {
    if (!events || events.length === 0) return;

    // 1. Group events per user across the scrape poll
    const userEventsMap = new Map<
      number,
      { user: PackedUserProfile; matchedEvents: Array<{ event: DiffEvent; priority: BroadcastPriority }> }
    >();

    for (const event of events) {
      let resolvedType: "available" | "sold_out" | "models" | "prices" = "available";
      let priority: BroadcastPriority = "P1";

      if (event.type === "SLOT_APPEARED") {
        resolvedType = "available";
        priority = "P1";
      } else if (event.type === "SLOT_DISAPPEARED") {
        resolvedType = "sold_out";
        priority = "P3";
      } else if (
        event.type === "MODEL_UPGRADE_EVENT" ||
        event.type === "NEW_POOL_EVENT" ||
        event.type === "TIER_UPDATED_EVENT"
      ) {
        resolvedType = "models";
        priority = "P2";
      } else if (
        event.type === "SLOT_PRICE_CHANGED" ||
        event.type === "POOL_BASE_PRICE_CHANGED" ||
        event.type === "PRICE_CHANGED"
      ) {
        resolvedType = "prices";
        priority = "P2";
      }

      const subscribers = this.index.resolveSubscribers(event.poolSlug, event.block, resolvedType);
      if (subscribers.length === 0) continue;

      for (const sub of subscribers) {
        let entry = userEventsMap.get(sub.userId);
        if (!entry) {
          entry = { user: sub, matchedEvents: [] };
          userEventsMap.set(sub.userId, entry);
        }
        const isDuplicate = entry.matchedEvents.some(
          (e) =>
            e.event.id === event.id ||
            (e.event.poolSlug === event.poolSlug &&
              e.event.block === event.block &&
              e.event.type === event.type &&
              e.event.newPrice === event.newPrice)
        );
        if (!isDuplicate) {
          entry.matchedEvents.push({ event, priority });
        }
      }
    }

    // Precompute analytics cache per event to eliminate N+1 queries in subscriber loop
    const eventAnalyticsCache = new Map<string, string | undefined>();
    for (const event of events) {
      if (event.type === "SLOT_APPEARED" && this.historyDao) {
        const analytics = this.historyDao.getSlotAnalytics(event.poolSlug, event.block);
        eventAnalyticsCache.set(event.id, analytics.avgDurationFormatted || undefined);
      }
    }

    // 2. Format and Enqueue messages (Single or Chunked Bundles <= 3,800 chars)
    for (const { user, matchedEvents } of userEventsMap.values()) {
      if (matchedEvents.length === 1) {
        const single = matchedEvents[0];
        const cachedDuration = eventAnalyticsCache.get(single.event.id);
        const msg = formatAlertMessage(user, single.event, single.priority, cachedDuration);
        this.enqueue(msg);
      } else {
        const MAX_BUNDLE_EVENTS_PER_MSG = 8;
        for (let i = 0; i < matchedEvents.length; i += MAX_BUNDLE_EVENTS_PER_MSG) {
          const slice = matchedEvents.slice(i, i + MAX_BUNDLE_EVENTS_PER_MSG);
          if (slice.length === 1) {
            const cachedDuration = eventAnalyticsCache.get(slice[0].event.id);
            this.enqueue(formatAlertMessage(user, slice[0].event, slice[0].priority, cachedDuration));
          } else {
            const msg = formatBundledAlertMessage(user, slice);
            this.enqueue(msg);
          }
        }
      }
    }
  }

  public enqueue(msg: OutgoingAlertMessage): void {
    const q = this.getQueueByPriority(msg.priority);
    q.push(msg);

    if (!this.isWorkerRunning) {
      this.startWorkerLoop();
    }
  }

  private getQueueByPriority(priority: BroadcastPriority): CircularRingBuffer<OutgoingAlertMessage> {
    switch (priority) {
      case "P0":
        return this.p0Queue;
      case "P1":
        return this.p1Queue;
      case "P2":
        return this.p2Queue;
      case "P3":
      default:
        return this.p3Queue;
    }
  }

  private startWorkerLoop(): void {
    if (this.isWorkerRunning) return;
    this.isWorkerRunning = true;

    const processNextTick = async () => {
      if (!this.isWorkerRunning) return;

      // 1. Check global 429 adaptive pause
      if (this.rateLimiter.isGlobalPaused()) {
        const waitMs = this.rateLimiter.getPauseRemainingMs();
        setTimeout(processNextTick, waitMs);
        return;
      }

      if (this.getTotalPending() === 0) {
        this.isWorkerRunning = false;
        return;
      }

      // 2. Consume global token & select next DWRR candidate
      if (this.rateLimiter.hasGlobalToken()) {
        const item = this.selectNextItemDWRR();
        if (item) {
          this.rateLimiter.consumeGlobalToken();
          this.dispatchSingleMessage(item).catch(() => {});
        }
      }

      // 3. Jittered next tick (~37ms ± 3ms)
      const delay = this.rateLimiter.getJitteredDelayMs();
      setTimeout(processNextTick, delay);
    };

    setImmediate(processNextTick);
  }

  private popValidCandidate(q: CircularRingBuffer<OutgoingAlertMessage>): OutgoingAlertMessage | undefined {
    const now = Date.now();
    const deferred: OutgoingAlertMessage[] = [];
    let chosen: OutgoingAlertMessage | undefined;
    let scanCount = 0;
    const maxScan = Math.min(q.size(), 50);

    while (!q.isEmpty() && scanCount < maxScan) {
      scanCount++;
      const candidate = q.pop()!;

      // 1. Drop stale alerts (> 10 min old)
      if (now - candidate.enqueuedAt > this.MAX_MESSAGE_AGE_MS) {
        continue;
      }

      // 2. Drop alerts for deactivated/blocked users
      const profile = this.index.getProfileByTgId(candidate.telegramId);
      if (profile && !profile.isActive) {
        continue;
      }

      // 3. Check per-user rate limit (1.05s gap)
      if (!this.rateLimiter.canDispatchToUser(candidate.telegramId)) {
        deferred.push(candidate);
        continue;
      }

      chosen = candidate;
      break;
    }

    // Re-queue rate-limited candidates to the tail so ready subscribers behind them are processed
    for (const d of deferred) {
      q.push(d);
    }
    return chosen;
  }

  private selectNextItemDWRR(): OutgoingAlertMessage | undefined {
    // P0 Interactive messages always take absolute immediate precedence
    if (!this.p0Queue.isEmpty()) {
      return this.popValidCandidate(this.p0Queue);
    }

    if (this.p1Queue.isEmpty()) this.p1Deficit = 0;
    if (this.p2Queue.isEmpty()) this.p2Deficit = 0;
    if (this.p3Queue.isEmpty()) this.p3Deficit = 0;

    // Allocate deficit quanta if all active queues are depleted of deficit
    if (this.p1Deficit <= 0 && this.p2Deficit <= 0 && this.p3Deficit <= 0) {
      if (!this.p1Queue.isEmpty()) this.p1Deficit += this.quantumP1;
      if (!this.p2Queue.isEmpty()) this.p2Deficit += this.quantumP2;
      if (!this.p3Queue.isEmpty()) this.p3Deficit += this.quantumP3;
    }

    // Drain P1
    if (!this.p1Queue.isEmpty() && this.p1Deficit > 0) {
      const item = this.popValidCandidate(this.p1Queue);
      if (item) {
        this.p1Deficit--;
        return item;
      }
    }

    // Drain P2
    if (!this.p2Queue.isEmpty() && this.p2Deficit > 0) {
      const item = this.popValidCandidate(this.p2Queue);
      if (item) {
        this.p2Deficit--;
        return item;
      }
    }

    // Drain P3
    if (!this.p3Queue.isEmpty() && this.p3Deficit > 0) {
      const item = this.popValidCandidate(this.p3Queue);
      if (item) {
        this.p3Deficit--;
        return item;
      }
    }

    // Fallback: Priority order
    if (!this.p1Queue.isEmpty()) {
      const item = this.popValidCandidate(this.p1Queue);
      if (item) return item;
    }
    if (!this.p2Queue.isEmpty()) {
      const item = this.popValidCandidate(this.p2Queue);
      if (item) return item;
    }
    if (!this.p3Queue.isEmpty()) {
      const item = this.popValidCandidate(this.p3Queue);
      if (item) return item;
    }

    return undefined;
  }

  private async dispatchSingleMessage(msg: OutgoingAlertMessage): Promise<void> {
    try {
      this.rateLimiter.recordUserDispatch(msg.telegramId, Date.now());

      await this.bot.api.sendMessage(msg.telegramId, msg.text, {
        parse_mode: "HTML",
        reply_markup: msg.keyboard,
        disable_notification: msg.isMuted,
        link_preview_options: { is_disabled: true },
      });

      this.logDao.logNotification(msg.userId, msg.poolSlug, msg.blockId, msg.eventType);
    } catch (err: any) {
      this.handleTelegramError(err, msg);
    }
  }

  private handleTelegramError(err: any, msg: OutgoingAlertMessage): void {
    const errorCode = err?.error_code || err?.response?.error_code;
    const description = err?.description || "";

    // 1. User Blocked or Invalid Chat (403 / 400)
    if (errorCode === 403 || (errorCode === 400 && description.includes("chat not found"))) {
      this.index.markUserDeactivated(msg.telegramId);
      this.blockedUsersBatch.push(msg.telegramId);
      return;
    }

    // 2. Rate Limit (HTTP 429)
    if (errorCode === 429) {
      const retryAfter = err?.parameters?.retry_after || 5;
      console.warn(`⚠️ [NotificationDispatcher] HTTP 429 received. Pausing queue for ${retryAfter + 0.5}s.`);
      this.rateLimiter.trigger429Backoff(retryAfter);
      const targetQ = this.getQueueByPriority(msg.priority);
      targetQ.unshift(msg); // Push back to head of line
      return;
    }

    // 3. Transient Network Errors
    if (msg.retries < 3) {
      msg.retries++;
      const targetQ = this.getQueueByPriority(msg.priority);
      targetQ.push(msg);
    } else {
      console.error(`❌ [NotificationDispatcher] Dropping message to ${msg.telegramId} after 3 retries: ${err.message}`);
    }
  }

  public async sendTestAlert(
    targetTgId: number,
    lang: SupportedLanguage = "uk",
    eventType: "slot" | "model" | "bundle" = "slot"
  ): Promise<void> {
    const profile: PackedUserProfile = this.getInvertedIndex().getProfileByTgId(targetTgId) || {
      userId: 0,
      telegramId: targetTgId,
      language: lang,
      isMuted: false,
      isActive: true,
      notifyAvailableGlobal: true,
      notifySoldOutGlobal: true,
      notifyModelsGlobal: true,
      notifyPricesGlobal: true,
      lastActiveAt: Date.now(),
    };

    const msg = createTestAlertMessage(profile, eventType);
    this.enqueue(msg);
  }

  public flushBlockedUsersToDb(): void {
    this.rateLimiter.pruneStaleUserTimestamps();

    if (this.blockedUsersBatch.length === 0) return;
    const uniqueIds = Array.from(new Set(this.blockedUsersBatch));

    try {
      this.userDao.deactivateUsersBatch(uniqueIds);
      this.blockedUsersBatch = [];
      console.log(`🧹 [NotificationDispatcher] Deactivated ${uniqueIds.length} unique blocked users in DB transaction.`);
    } catch (e: any) {
      console.error("[NotificationDispatcher] Error persisting blocked users to DB:", e.message);
    }
  }

  public async flushPending(): Promise<void> {
    console.log(`⏳ [NotificationDispatcher] Flushing pending queues (${this.getTotalPending()} items)...`);
    this.flushBlockedUsersToDb();
  }

  public getTotalPending(): number {
    return this.p0Queue.size() + this.p1Queue.size() + this.p2Queue.size() + this.p3Queue.size();
  }

  public getQueueMetrics() {
    const limiterMetrics = this.rateLimiter.getMetrics();
    return {
      p0: this.p0Queue.size(),
      p1: this.p1Queue.size(),
      p2: this.p2Queue.size(),
      p3: this.p3Queue.size(),
      total: this.getTotalPending(),
      tokensAvailable: limiterMetrics.tokensAvailable,
      isPaused: limiterMetrics.isPaused,
    };
  }

  public stop(): void {
    this.isWorkerRunning = false;
    if (this.batchFlushTimer) {
      clearInterval(this.batchFlushTimer);
      this.batchFlushTimer = undefined;
    }
  }
}
