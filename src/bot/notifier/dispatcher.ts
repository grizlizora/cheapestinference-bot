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
import { toValidUtf8 } from "./htmlTagBalancer.js";
import {
  BroadcastPriority,
  OutgoingAlertMessage,
  formatAlertMessage,
  formatBundledAlertMessage,
  createTestAlertMessage,
} from "./alertFormatter.js";

import { NotificationOutboxDAO, OutboxItem } from "../../db/dao/notificationOutbox.js";
import { InlineKeyboard } from "grammy";

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

  // Cross-Tick Idempotency Latch: key -> timestamp
  private lastDispatchedEventLatch = new Map<string, number>();

  constructor(
    private bot: Bot<BotContext>,
    private userDao: UserDAO,
    private logDao: NotificationLogDAO,
    private historyDao?: SlotHistoryDAO,
    index?: SubscriberInvertedIndex,
    rateLimiter?: NotificationRateLimiter,
    private outboxDao?: NotificationOutboxDAO
  ) {
    this.index = index ?? new SubscriberInvertedIndex((userDao as any).db);
    this.rateLimiter = rateLimiter ?? new NotificationRateLimiter();

    this.batchFlushTimer = setInterval(() => this.flushBlockedUsersToDb(), 5000);
    this.batchFlushTimer.unref();

    this.hydratePendingFromOutbox();
  }

  private hydratePendingFromOutbox(): void {
    if (!this.outboxDao) return;
    try {
      const pendingItems = this.outboxDao.getPending(1000);
      if (pendingItems.length === 0) return;
      console.log(`📦 [NotificationDispatcher] Hydrated ${pendingItems.length} pending alerts from SQLite outbox.`);

      const now = Date.now();
      for (const item of pendingItems) {
        const itemCreatedMs = item.createdAt
          ? (Date.parse(item.createdAt.replace(" ", "T") + "Z") || Date.parse(item.createdAt) || now)
          : now;

        if (now - itemCreatedMs > this.MAX_MESSAGE_AGE_MS) {
          this.outboxDao.markTerminalFailed(item.id, "Expired TTL on startup hydration");
          continue;
        }

        let keyboard: InlineKeyboard | undefined;
        if (item.replyMarkupJson) {
          try {
            const parsed = JSON.parse(item.replyMarkupJson);
            if (parsed.inline_keyboard) {
              keyboard = new InlineKeyboard(parsed.inline_keyboard);
            }
          } catch {}
        }

        const msg: OutgoingAlertMessage = {
          id: item.id,
          telegramId: item.telegramId,
          userId: item.userId,
          poolSlug: item.poolSlug || "",
          blockId: item.blockId || "",
          eventType: item.eventType,
          text: item.messageText,
          keyboard,
          isMuted: item.disableNotification,
          priority: item.priority,
          retries: item.attempts,
          enqueuedAt: itemCreatedMs,
        };

        const q = this.getQueueByPriority(msg.priority);
        q.push(msg);
      }

      if (this.getTotalPending() > 0 && !this.isWorkerRunning) {
        this.startWorkerLoop();
      }
    } catch (e: any) {
      console.error("[NotificationDispatcher] Error hydrating outbox:", e.message);
    }
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

    // Cross-Tick Idempotency Latch & Anti-Flap Guard (prevents rapid engine flapping within 60s)
    const now = Date.now();
    const MIN_REVERSAL_INTERVAL_MS = 60 * 1000;
    const validEvents: DiffEvent[] = [];

    for (const event of events) {
      const latchKey = `${event.poolSlug}:${event.block || "ALL"}:${event.type}`;
      const lastSent = this.lastDispatchedEventLatch.get(latchKey);

      // Suppress duplicate identical event within 5 minutes
      if (lastSent && (now - lastSent) < 5 * 60 * 1000) {
        console.warn(`🛡️ [Dispatcher Latch] Suppressed duplicate ${event.type} for ${event.poolSlug}:${event.block}`);
        continue;
      }

      // Check opposite latch: if opposite state was dispatched within 60s, suppress rapid flapping
      const oppositeType = event.type === "SLOT_APPEARED" ? "SLOT_DISAPPEARED" : event.type === "SLOT_DISAPPEARED" ? "SLOT_APPEARED" : undefined;
      if (oppositeType) {
        const oppositeKey = `${event.poolSlug}:${event.block || "ALL"}:${oppositeType}`;
        const lastOpposite = this.lastDispatchedEventLatch.get(oppositeKey);
        if (lastOpposite && (now - lastOpposite) < MIN_REVERSAL_INTERVAL_MS) {
          console.warn(`🛡️ [Anti-Flap Guard] Suppressed ${event.type} for ${event.poolSlug}:${event.block} (within 60s of ${oppositeType})`);
          continue;
        }
        this.lastDispatchedEventLatch.delete(oppositeKey);
      }

      this.lastDispatchedEventLatch.set(latchKey, now);
      validEvents.push(event);
    }

    if (validEvents.length === 0) return;

    // 1. Group events per user across the scrape poll
    const userEventsMap = new Map<
      number,
      { user: PackedUserProfile; matchedEvents: Array<{ event: DiffEvent; priority: BroadcastPriority }> }
    >();

    for (const event of validEvents) {
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

    // 2. Format and Enqueue messages with Flyweight Template Deduplication
    // Avoids generating separate string allocations for identical alerts across subscribers
    const singleMsgTemplateCache = new Map<string, OutgoingAlertMessage>();
    const bundleMsgTemplateCache = new Map<string, OutgoingAlertMessage>();

    // Sort aggregated user entries by 3-tier priority before enqueueing to eliminate multi-event donor interleaving
    const sortedUserEntries = Array.from(userEventsMap.values()).sort((a, b) => {
      const adminDiff = (b.user.isAdmin ? 1 : 0) - (a.user.isAdmin ? 1 : 0);
      if (adminDiff !== 0) return adminDiff;

      const starsDiff = (b.user.totalDonatedStars || 0) - (a.user.totalDonatedStars || 0);
      if (starsDiff !== 0) return starsDiff;

      return (b.user.lastActiveAt || 0) - (a.user.lastActiveAt || 0);
    });

    const batchMessages: OutgoingAlertMessage[] = [];

    for (const { user, matchedEvents } of sortedUserEntries) {
      if (matchedEvents.length === 1) {
        const single = matchedEvents[0];
        const cachedDuration = eventAnalyticsCache.get(single.event.id);
        const cacheKey = `${user.language}:${single.event.id}:${single.priority}`;
        let template = singleMsgTemplateCache.get(cacheKey);
        if (!template) {
          template = formatAlertMessage(user, single.event, single.priority, cachedDuration);
          singleMsgTemplateCache.set(cacheKey, template);
        }
        // Flyweight shallow clone with recipient-specific IDs
        batchMessages.push({
          ...template,
          id: crypto.randomUUID(),
          telegramId: user.telegramId,
          userId: user.userId,
          isMuted: user.isMuted,
          enqueuedAt: Date.now(),
        });
      } else {
        const MAX_BUNDLE_EVENTS_PER_MSG = 8;
        for (let i = 0; i < matchedEvents.length; i += MAX_BUNDLE_EVENTS_PER_MSG) {
          const slice = matchedEvents.slice(i, i + MAX_BUNDLE_EVENTS_PER_MSG);
          if (slice.length === 1) {
            const single = slice[0];
            const cachedDuration = eventAnalyticsCache.get(single.event.id);
            const cacheKey = `${user.language}:${single.event.id}:${single.priority}`;
            let template = singleMsgTemplateCache.get(cacheKey);
            if (!template) {
              template = formatAlertMessage(user, single.event, single.priority, cachedDuration);
              singleMsgTemplateCache.set(cacheKey, template);
            }
            batchMessages.push({
              ...template,
              id: crypto.randomUUID(),
              telegramId: user.telegramId,
              userId: user.userId,
              isMuted: user.isMuted,
              enqueuedAt: Date.now(),
            });
          } else {
            const bundleKey = `${user.language}:${slice.map((s) => s.event.id).join(",")}`;
            let bundleTemplate = bundleMsgTemplateCache.get(bundleKey);
            if (!bundleTemplate) {
              bundleTemplate = formatBundledAlertMessage(user, slice);
              bundleMsgTemplateCache.set(bundleKey, bundleTemplate);
            }
            batchMessages.push({
              ...bundleTemplate,
              id: crypto.randomUUID(),
              telegramId: user.telegramId,
              userId: user.userId,
              isMuted: user.isMuted,
              enqueuedAt: Date.now(),
            });
          }
        }
      }
    }

    if (batchMessages.length > 0) {
      this.enqueueBatch(batchMessages);
    }
  }

  public enqueueBatch(messages: OutgoingAlertMessage[]): void {
    if (messages.length === 0) return;
    if (this.outboxDao) {
      try {
        this.outboxDao.enqueueBatch(
          messages.map((msg) => ({
            id: msg.id,
            userId: msg.userId,
            telegramId: msg.telegramId,
            priority: msg.priority,
            messageText: msg.text,
            replyMarkupJson: msg.keyboard ? JSON.stringify(msg.keyboard) : undefined,
            disableNotification: msg.isMuted,
            eventType: msg.eventType,
            poolSlug: msg.poolSlug,
            blockId: msg.blockId,
            status: "pending",
            attempts: msg.retries || 0,
          }))
        );
      } catch (e: any) {
        console.error("[NotificationDispatcher] Error persisting outbox batch:", e.message);
      }
    }

    for (const msg of messages) {
      this.enqueue(msg, true);
    }
  }

  public enqueue(msg: OutgoingAlertMessage, skipOutbox = false): void {
    if (this.outboxDao && !skipOutbox) {
      try {
        this.outboxDao.enqueue({
          id: msg.id,
          userId: msg.userId,
          telegramId: msg.telegramId,
          priority: msg.priority,
          messageText: msg.text,
          replyMarkupJson: msg.keyboard ? JSON.stringify(msg.keyboard) : undefined,
          disableNotification: msg.isMuted,
          eventType: msg.eventType,
          poolSlug: msg.poolSlug,
          blockId: msg.blockId,
          status: "pending",
          attempts: msg.retries || 0,
        });
      } catch (e: any) {
        console.error("[NotificationDispatcher] Error persisting outbox item:", e.message);
      }
    }

    const q = this.getQueueByPriority(msg.priority);
    q.push(msg);

    if (this.getTotalPending() > 0 && !this.isWorkerRunning) {
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

  private inFlightDispatches = new Set<Promise<void>>();

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
          const p = this.dispatchSingleMessage(item).finally(() => {
            this.inFlightDispatches.delete(p);
          });
          this.inFlightDispatches.add(p);
        }
      }

      // 3. Jittered next tick (~37ms ± 3ms)
      const delay = this.rateLimiter.getJitteredDelayMs();
      setTimeout(processNextTick, delay);
    };

    setImmediate(processNextTick);
  }

  private readonly deferredScratch: OutgoingAlertMessage[] = [];

  private popValidCandidate(
    q: CircularRingBuffer<OutgoingAlertMessage>,
    bypassUserRateLimit = false
  ): OutgoingAlertMessage | undefined {
    const now = Date.now();
    this.deferredScratch.length = 0;
    let chosen: OutgoingAlertMessage | undefined;
    let scanCount = 0;
    const maxScan = Math.min(q.size(), 50);

    while (!q.isEmpty() && scanCount < maxScan) {
      scanCount++;
      const candidate = q.pop()!;

      // 1. Drop stale alerts (> 10 min old)
      if (now - candidate.enqueuedAt > this.MAX_MESSAGE_AGE_MS) {
        this.outboxDao?.markTerminalFailed(candidate.id, "TTL expired in queue");
        continue;
      }

      // 2. Drop alerts for deactivated/blocked users
      const profile = this.index.getProfileByTgId(candidate.telegramId);
      if (profile && !profile.isActive) {
        this.outboxDao?.markTerminalFailed(candidate.id, "User deactivated");
        continue;
      }

      // 3. Check per-user rate limit (1.05s gap) unless draining
      if (!bypassUserRateLimit && !this.rateLimiter.canDispatchToUser(candidate.telegramId)) {
        this.deferredScratch.push(candidate);
        continue;
      }

      chosen = candidate;
      break;
    }

    // Re-queue rate-limited candidates to the tail so ready subscribers behind them are processed
    for (let i = 0; i < this.deferredScratch.length; i++) {
      q.push(this.deferredScratch[i]);
    }
    this.deferredScratch.length = 0;
    return chosen;
  }

  private selectNextItemDWRR(bypassUserRateLimit = false): OutgoingAlertMessage | undefined {
    if (this.p0Queue.isEmpty()) this.p0Deficit = 0;
    if (this.p1Queue.isEmpty()) this.p1Deficit = 0;
    if (this.p2Queue.isEmpty()) this.p2Deficit = 0;
    if (this.p3Queue.isEmpty()) this.p3Deficit = 0;

    // Allocate deficit quanta if all active queues are depleted of deficit
    if (this.p0Deficit <= 0 && this.p1Deficit <= 0 && this.p2Deficit <= 0 && this.p3Deficit <= 0) {
      if (!this.p0Queue.isEmpty()) this.p0Deficit += this.quantumP0; // 10
      if (!this.p1Queue.isEmpty()) this.p1Deficit += this.quantumP1; // 6
      if (!this.p2Queue.isEmpty()) this.p2Deficit += this.quantumP2; // 3
      if (!this.p3Queue.isEmpty()) this.p3Deficit += this.quantumP3; // 1
    }

    // Drain P0 (Admin Broadcast & Interactive)
    if (!this.p0Queue.isEmpty() && this.p0Deficit > 0) {
      const item = this.popValidCandidate(this.p0Queue, bypassUserRateLimit);
      if (item) {
        this.p0Deficit--;
        return item;
      }
    }

    // Drain P1 (Slot Drops)
    if (!this.p1Queue.isEmpty() && this.p1Deficit > 0) {
      const item = this.popValidCandidate(this.p1Queue, bypassUserRateLimit);
      if (item) {
        this.p1Deficit--;
        return item;
      }
    }

    // Drain P2 (Model upgrades & Prices)
    if (!this.p2Queue.isEmpty() && this.p2Deficit > 0) {
      const item = this.popValidCandidate(this.p2Queue, bypassUserRateLimit);
      if (item) {
        this.p2Deficit--;
        return item;
      }
    }

    // Drain P3 (Sold Out)
    if (!this.p3Queue.isEmpty() && this.p3Deficit > 0) {
      const item = this.popValidCandidate(this.p3Queue, bypassUserRateLimit);
      if (item) {
        this.p3Deficit--;
        return item;
      }
    }

    // Fallback: Priority order
    if (!this.p0Queue.isEmpty()) {
      const item = this.popValidCandidate(this.p0Queue, bypassUserRateLimit);
      if (item) return item;
    }
    if (!this.p1Queue.isEmpty()) {
      const item = this.popValidCandidate(this.p1Queue, bypassUserRateLimit);
      if (item) return item;
    }
    if (!this.p2Queue.isEmpty()) {
      const item = this.popValidCandidate(this.p2Queue, bypassUserRateLimit);
      if (item) return item;
    }
    if (!this.p3Queue.isEmpty()) {
      const item = this.popValidCandidate(this.p3Queue, bypassUserRateLimit);
      if (item) return item;
    }

    return undefined;
  }

  /**
   * Dispatches a multi-language broadcast campaign in bulk with O(1) RAM user resolution,
   * SQLite Outbox persistence, and DWRR P0 rate-limited streaming.
   */
  public async dispatchBroadcastBatch(
    drafts: { uk?: string; en?: string; ru?: string },
    options: {
      sendSilent?: boolean;
      filter?: "all" | "active_only" | "donors_only";
    } = {}
  ): Promise<{ totalEnqueued: number; statsByLang: Record<string, number> }> {
    const filter = options.filter || "active_only";
    const profiles = this.index.getActiveProfiles(filter);
    const now = Date.now();

    const outboxBatch: OutboxItem[] = [];
    const statsByLang: Record<string, number> = { uk: 0, en: 0, ru: 0 };

    for (const p of profiles) {
      let chosenText = drafts[p.language];
      let resolvedLang: SupportedLanguage = p.language;

      // 4-tier fallback resolution
      if (!chosenText || chosenText.trim().length === 0) {
        if (drafts.en && drafts.en.trim().length > 0) {
          chosenText = drafts.en;
          resolvedLang = "en";
        } else if (drafts.uk && drafts.uk.trim().length > 0) {
          chosenText = drafts.uk;
          resolvedLang = "uk";
        } else if (drafts.ru && drafts.ru.trim().length > 0) {
          chosenText = drafts.ru;
          resolvedLang = "ru";
        }
      }

      if (!chosenText || chosenText.trim().length === 0) continue;

      statsByLang[resolvedLang] = (statsByLang[resolvedLang] || 0) + 1;
      const isMuted = options.sendSilent ?? Boolean(p.isMuted);
      const itemId = crypto.randomUUID();

      const outboxItem: OutboxItem = {
        id: itemId,
        userId: p.userId,
        telegramId: p.telegramId,
        priority: "P0",
        messageText: chosenText,
        disableNotification: isMuted,
        eventType: "admin_broadcast",
        isBroadcast: true,
        language: resolvedLang,
        status: "pending",
        attempts: 0,
      };
      outboxBatch.push(outboxItem);

      // Enqueue directly into memory queue with skipOutbox flag
      this.p0Queue.push({
        id: itemId,
        telegramId: p.telegramId,
        userId: p.userId,
        poolSlug: "broadcast",
        blockId: "all",
        eventType: "admin_broadcast",
        text: chosenText,
        isMuted,
        priority: "P0",
        retries: 0,
        enqueuedAt: now,
      });
    }

    if (this.outboxDao && outboxBatch.length > 0) {
      this.outboxDao.enqueueBatch(outboxBatch);
    }

    if (this.getTotalPending() > 0 && !this.isWorkerRunning) {
      this.startWorkerLoop();
    }

    return { totalEnqueued: outboxBatch.length, statsByLang };
  }

  private async dispatchSingleMessage(msg: OutgoingAlertMessage): Promise<void> {
    try {
      this.rateLimiter.recordUserDispatch(msg.telegramId);

      const sanitizedText = toValidUtf8(msg.text);

      try {
        await this.bot.api.sendMessage(msg.telegramId, sanitizedText, {
          parse_mode: "HTML",
          reply_markup: msg.keyboard,
          disable_notification: msg.isMuted,
          link_preview_options: { is_disabled: true },
        });
      } catch (sendErr: any) {
        const desc = sendErr?.description || sendErr?.message || "";
        if (desc.includes("DOCUMENT_INVALID") || desc.includes("CUSTOM_EMOJI_INVALID")) {
          const stripped = sanitizedText.replace(/<tg-emoji[^>]*>(.*?)<\/tg-emoji>/gi, "$1");
          await this.bot.api.sendMessage(msg.telegramId, stripped, {
            parse_mode: "HTML",
            reply_markup: msg.keyboard,
            disable_notification: msg.isMuted,
            link_preview_options: { is_disabled: true },
          });
        } else {
          throw sendErr;
        }
      }

      this.outboxDao?.markDispatched(msg.id);
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
      this.outboxDao?.markTerminalFailed(msg.id, "User deactivated or blocked");
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
      this.outboxDao?.markFailed(msg.id, err.message);
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
    const total = this.getTotalPending();
    console.log(`⏳ [NotificationDispatcher] Flushing pending queues (${total} items)...`);
    
    // Aggressive synchronous drain before shutdown (up to 3 seconds)
    const startTime = Date.now();
    while (this.getTotalPending() > 0 && Date.now() - startTime < 3000) {
      const msg = this.selectNextItemDWRR(true);
      if (!msg) break;
      const p = this.dispatchSingleMessage(msg).finally(() => {
        this.inFlightDispatches.delete(p);
      });
      this.inFlightDispatches.add(p);
    }

    if (this.inFlightDispatches.size > 0) {
      await Promise.all(Array.from(this.inFlightDispatches));
    }

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
