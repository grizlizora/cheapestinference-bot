/**
 * src/bot/notifier/dispatcher.ts
 * Deficit Weighted Round-Robin (DWRR) Notification Dispatcher (Unified Facade)
 *
 * 100% Backward Compatible Facade for notification dispatching across the codebase.
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
  DispatcherMetrics,
} from "./types.js";
import {
  formatAlertMessage,
  formatBundledAlertMessage,
  createTestAlertMessage,
} from "./alertFormatter.js";
import { NotificationOutboxDAO } from "../../db/dao/notificationOutbox.js";
import { DwrrScheduler } from "./queue/dwrrScheduler.js";
import { OutboxManager } from "./outbox/outboxManager.js";
import { TelegramSender } from "./sender/telegramSender.js";

export type { BroadcastPriority, OutgoingAlertMessage, DispatcherMetrics };
export { formatAlertMessage, formatBundledAlertMessage, createTestAlertMessage };

export interface BroadcastBatchOptions {
  sendSilent?: boolean;
  filter?: "all" | "active_only" | "donors_only";
}

export interface BroadcastDraftPayload {
  htmlText?: string;
  text?: string;
  rawText?: string;
  mediaType?: "text" | "photo" | "video" | "document" | "animation";
  fileId?: string;
  isConfirmed?: boolean;
}

function mapEventTypeToSubKey(type: string): "available" | "sold_out" | "models" | "prices" {
  switch (type) {
    case "SLOT_APPEARED":
      return "available";
    case "SLOT_DISAPPEARED":
      return "sold_out";
    case "SLOT_PRICE_CHANGED":
    case "POOL_BASE_PRICE_CHANGED":
    case "PRICE_CHANGED":
      return "prices";
    case "MODEL_UPGRADE_EVENT":
    case "TIER_UPDATED_EVENT":
    case "NEW_POOL_EVENT":
    default:
      return "models";
  }
}

export class NotificationDispatcher {
  private index: SubscriberInvertedIndex;
  private rateLimiter: NotificationRateLimiter;
  private scheduler: DwrrScheduler;
  private outboxManager: OutboxManager;
  private sender: TelegramSender;

  // Cross-Tick Idempotency Latch: key -> timestamp (bounded TTL sweep to prevent memory leaks)
  private lastDispatchedEventLatch = new Map<string, number>();

  // Expose Ring Buffers for backward compatibility with unit tests
  public get p0Queue(): CircularRingBuffer<OutgoingAlertMessage> {
    return this.scheduler.p0Queue;
  }
  public get p1Queue(): CircularRingBuffer<OutgoingAlertMessage> {
    return this.scheduler.p1Queue;
  }
  public get p2Queue(): CircularRingBuffer<OutgoingAlertMessage> {
    return this.scheduler.p2Queue;
  }
  public get p3Queue(): CircularRingBuffer<OutgoingAlertMessage> {
    return this.scheduler.p3Queue;
  }

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
    this.scheduler = new DwrrScheduler(this.rateLimiter);
    this.outboxManager = new OutboxManager(this.userDao, this.logDao, this.outboxDao, this.index, this.rateLimiter);
    this.sender = new TelegramSender(this.bot, this.rateLimiter, this.scheduler, this.outboxManager);

    this.outboxManager.hydratePendingFromOutbox(this.scheduler);
    this.sender.startWorker();
  }

  public getInvertedIndex(): SubscriberInvertedIndex {
    return this.index;
  }

  public getRateLimiter(): NotificationRateLimiter {
    return this.rateLimiter;
  }

  public enqueue(msg: OutgoingAlertMessage, skipOutbox = false): void {
    if (!skipOutbox) {
      this.outboxManager.recordOutboxInsert(msg);
    }
    this.scheduler.enqueue(msg);
  }

  public enqueueBatch(messages: OutgoingAlertMessage[]): void {
    if (messages.length === 0) return;
    this.outboxManager.recordOutboxInsertBatch(messages);
    for (const msg of messages) {
      this.enqueue(msg, true);
    }
  }

  public selectNextItemDWRR(ignoreRateLimit = false): OutgoingAlertMessage | null {
    return this.scheduler.selectNextItemDWRR(ignoreRateLimit);
  }

  public formatAlertMessage(
    user: PackedUserProfile,
    event: DiffEvent,
    priority: BroadcastPriority = "P1",
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
   * Dispatches admin multi-language broadcasts partitioned by language in P0 queue
   */
  public async dispatchBroadcastBatch(
    drafts: Record<string, string | BroadcastDraftPayload | undefined>,
    options: BroadcastBatchOptions = {}
  ): Promise<{ totalEnqueued: number; statsByLang: Record<string, number> }> {
    const validDrafts: Record<string, { htmlText: string; mediaType?: any; fileId?: string }> = {};
    for (const [l, d] of Object.entries(drafts)) {
      if (!d) continue;
      if (typeof d === "string") {
        if (d.trim().length > 0) {
          validDrafts[l] = { htmlText: d, mediaType: "text" };
        }
      } else {
        const payloadText = d.htmlText || d.text || "";
        if (d.isConfirmed !== false && payloadText.trim().length > 0) {
          validDrafts[l] = { htmlText: payloadText, mediaType: d.mediaType, fileId: d.fileId };
        }
      }
    }

    if (Object.keys(validDrafts).length === 0) {
      return { totalEnqueued: 0, statsByLang: {} };
    }

    const targetProfiles = this.index.getActiveProfiles(options.filter || "active_only");
    let totalEnqueued = 0;
    const statsByLang: Record<string, number> = {};
    const batchMessages: OutgoingAlertMessage[] = [];

    for (const p of targetProfiles) {
      if (!p.isActive) continue;

      if (options.filter === "active_only" && !p.isActive) continue;
      if (options.filter === "donors_only" && (p.totalDonatedStars || 0) <= 0) continue;

      const userLang = (p.language || "en") as SupportedLanguage;

      // 4-tier fallback: targetLang -> uk -> en -> ru -> first available key
      let resolvedLang: SupportedLanguage = userLang;
      let draft = validDrafts[userLang];

      if (!draft) {
        if (validDrafts.uk) {
          resolvedLang = "uk";
          draft = validDrafts.uk;
        } else if (validDrafts.en) {
          resolvedLang = "en";
          draft = validDrafts.en;
        } else if (validDrafts.ru) {
          resolvedLang = "ru";
          draft = validDrafts.ru;
        } else {
          resolvedLang = (Object.keys(validDrafts)[0] as SupportedLanguage) || "en";
          draft = validDrafts[resolvedLang];
        }
      }

      if (!draft) continue;

      const isMuted = options.sendSilent !== undefined ? Boolean(options.sendSilent) : Boolean(p.isMuted);

      const msg: OutgoingAlertMessage & { language?: string } = {
        id: crypto.randomUUID(),
        telegramId: p.telegramId,
        userId: p.userId,
        poolSlug: "broadcast",
        blockId: "ALL",
        eventType: "ADMIN_BROADCAST",
        text: draft.htmlText,
        isMuted,
        priority: "P0",
        retries: 0,
        enqueuedAt: Date.now(),
        mediaType: draft.mediaType,
        fileId: draft.fileId,
        language: resolvedLang as SupportedLanguage,
      };

      batchMessages.push(msg);
      statsByLang[resolvedLang] = (statsByLang[resolvedLang] || 0) + 1;
      totalEnqueued++;
    }

    if (batchMessages.length > 0) {
      this.enqueueBatch(batchMessages);
    }

    return { totalEnqueued, statsByLang };
  }

  /**
   * Main Ingestion Pipeline: Takes diff events, resolves matched subscribers from RAM index,
   * bundles simultaneous alerts (max 8 per message), and enqueues messages with 3-tier priority.
   */
  public async handleDiffEvents(events: DiffEvent[]): Promise<void> {
    if (events.length === 0) return;

    const now = Date.now();
    const MIN_REVERSAL_INTERVAL_MS = 10 * 1000;
    const validEvents: DiffEvent[] = [];

    for (const event of events) {
      const latchKey = `${event.poolSlug}:${event.block || "ALL"}:${event.type}`;
      const lastSent = this.lastDispatchedEventLatch.get(latchKey);

      // Suppress duplicate identical event within 15s (duplicate scraper tick race)
      if (lastSent && now - lastSent < 15 * 1000) {
        console.warn(`🛡️ [Dispatcher Latch] Suppressed duplicate ${event.type} for ${event.poolSlug}:${event.block}`);
        continue;
      }

      // Check opposite latch: if opposite state was dispatched within 10s, suppress rapid flapping
      const oppositeType = event.type === "SLOT_APPEARED" ? "SLOT_DISAPPEARED" : event.type === "SLOT_DISAPPEARED" ? "SLOT_APPEARED" : undefined;
      if (oppositeType) {
        const oppositeKey = `${event.poolSlug}:${event.block || "ALL"}:${oppositeType}`;
        const lastOpposite = this.lastDispatchedEventLatch.get(oppositeKey);
        if (lastOpposite && now - lastOpposite < MIN_REVERSAL_INTERVAL_MS) {
          console.warn(`🛡️ [Anti-Flap Guard] Suppressed ${event.type} for ${event.poolSlug}:${event.block} (within 10s of ${oppositeType})`);
          continue;
        }
        this.lastDispatchedEventLatch.delete(oppositeKey);
      }

      this.lastDispatchedEventLatch.set(latchKey, now);
      validEvents.push(event);
    }

    if (validEvents.length === 0) return;

    // Periodic sweep of latch to prevent unbounded RAM growth
    if (this.lastDispatchedEventLatch.size > 2000) {
      for (const [key, ts] of this.lastDispatchedEventLatch.entries()) {
        if (now - ts > 5 * 60_000) {
          this.lastDispatchedEventLatch.delete(key);
        }
      }
    }

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
    for (const event of validEvents) {
      if (event.type === "SLOT_APPEARED" && this.historyDao) {
        try {
          if (typeof (this.historyDao as any).getSlotAnalytics === "function") {
            const analytics = this.historyDao.getSlotAnalytics(event.poolSlug, event.block);
            eventAnalyticsCache.set(event.id, analytics.avgDurationFormatted || undefined);
          } else if (typeof (this.historyDao as any).getAverageDurationFormatted === "function") {
            const duration = (this.historyDao as any).getAverageDurationFormatted(event.poolSlug, event.block);
            eventAnalyticsCache.set(event.id, duration || undefined);
          }
        } catch {}
      }
    }

    // 2. Format and Enqueue messages with Flyweight Template Deduplication
    const singleMsgTemplateCache = new Map<string, OutgoingAlertMessage>();
    const bundleMsgTemplateCache = new Map<string, OutgoingAlertMessage>();

    // Sort aggregated user entries by 3-tier priority (Admins -> Donors -> Active users)
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
          template = this.formatAlertMessage(user, single.event, single.priority, cachedDuration);
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
        const MAX_BUNDLE_EVENTS_PER_MSG = 8;
        for (let i = 0; i < matchedEvents.length; i += MAX_BUNDLE_EVENTS_PER_MSG) {
          const slice = matchedEvents.slice(i, i + MAX_BUNDLE_EVENTS_PER_MSG);
          if (slice.length === 1) {
            const single = slice[0];
            const cachedDuration = eventAnalyticsCache.get(single.event.id);
            const cacheKey = `${user.language}:${single.event.id}:${single.priority}`;
            let template = singleMsgTemplateCache.get(cacheKey);
            if (!template) {
              template = this.formatAlertMessage(user, single.event, single.priority, cachedDuration);
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
              bundleTemplate = this.formatBundledAlertMessage(user, slice);
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

    const msg = createTestAlertMessage(profile, eventType === "bundle" ? "bundle" : "slot");
    this.enqueue(msg);
  }

  public flushBlockedUsersToDb(): void {
    this.rateLimiter.pruneStaleUserTimestamps();
    this.outboxManager.flushBlockedUsersToDb();
  }

  public async flushPending(): Promise<void> {
    const total = this.getTotalPending();
    console.log(`⏳ [NotificationDispatcher] Flushing pending queues (${total} items)...`);

    const startTime = Date.now();
    const inFlights = this.sender.getInFlightDispatches();

    while (this.getTotalPending() > 0 && Date.now() - startTime < 3000) {
      const msg = this.scheduler.selectNextItemDWRR(true);
      if (!msg) break;
      const p = this.sender.dispatchSingleMessage(msg).finally(() => {
        inFlights.delete(p);
      });
      inFlights.add(p);
    }

    if (inFlights.size > 0) {
      await Promise.all(Array.from(inFlights));
    }

    this.flushBlockedUsersToDb();
  }

  public getTotalPending(): number {
    return this.scheduler.getTotalPending();
  }

  public getQueueMetrics(): DispatcherMetrics {
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
    this.sender.stop();
    this.outboxManager.stop();
  }
}
