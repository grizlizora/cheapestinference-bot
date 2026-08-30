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
    this.outboxManager = new OutboxManager(this.userDao, this.logDao, this.outboxDao, this.index);
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

  public enqueue(msg: OutgoingAlertMessage): void {
    this.outboxManager.recordOutboxInsert(msg);
    this.scheduler.enqueue(msg);
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
    const statsByLang: Record<string, number> = { uk: 0, en: 0, ru: 0 };
    let totalEnqueued = 0;

    // Get profiles from RAM index
    const targetProfiles = this.index.getActiveProfiles(options.filter || "active_only");

    // Filter valid drafts (support both htmlText and text fields)
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
      return { totalEnqueued: 0, statsByLang };
    }

    for (const p of targetProfiles) {
      const userLang = p.language || "en";

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

      const msg: OutgoingAlertMessage & { language?: string } = {
        id: crypto.randomUUID(),
        telegramId: p.telegramId,
        userId: p.userId,
        poolSlug: "broadcast",
        blockId: "ALL",
        eventType: "ADMIN_BROADCAST",
        text: draft.htmlText,
        isMuted: Boolean(options.sendSilent),
        priority: "P0",
        retries: 0,
        enqueuedAt: Date.now(),
        mediaType: draft.mediaType,
        fileId: draft.fileId,
        language: resolvedLang as SupportedLanguage,
      };

      this.enqueue(msg);
      statsByLang[resolvedLang] = (statsByLang[resolvedLang] || 0) + 1;
      totalEnqueued++;
    }

    return { totalEnqueued, statsByLang };
  }

  /**
   * Main Ingestion Pipeline: Takes diff events, resolves matched subscribers from RAM index,
   * bundles simultaneous alerts (max 8 per message), and enqueues messages.
   */
  public async handleDiffEvents(events: DiffEvent[]): Promise<void> {
    if (events.length === 0) return;

    // Periodic sweep of latch to prevent unbounded RAM growth
    const now = Date.now();
    if (this.lastDispatchedEventLatch.size > 2000) {
      for (const [key, ts] of this.lastDispatchedEventLatch.entries()) {
        if (now - ts > 60_000) {
          this.lastDispatchedEventLatch.delete(key);
        }
      }
    }

    // Collect matched events partitioned by user
    const userMatchedEvents = new Map<number, Array<{ user: PackedUserProfile; event: DiffEvent; priority: BroadcastPriority }>>();

    for (const event of events) {
      // Cross-tick latch check
      const latchKey = `${event.poolSlug}:${event.block}:${event.type}:${event.newPrice ?? ""}:${event.newStatus ?? ""}`;
      const lastSent = this.lastDispatchedEventLatch.get(latchKey);
      if (lastSent && now - lastSent < 2000) {
        continue;
      }
      this.lastDispatchedEventLatch.set(latchKey, now);

      const subKey = mapEventTypeToSubKey(event.type);
      const subscribers = this.index.resolveSubscribers(event.poolSlug, event.block, subKey);

      for (const user of subscribers) {
        let priority: BroadcastPriority = "P1";
        if (user.isAdmin) {
          priority = "P0";
        } else if ((user.totalDonatedStars || 0) > 0) {
          priority = "P1";
        }

        let list = userMatchedEvents.get(user.telegramId);
        if (!list) {
          list = [];
          userMatchedEvents.set(user.telegramId, list);
        }
        list.push({ user, event, priority });
      }
    }

    // Dispatch formatted messages (chunk into bundles of max 8 events)
    const MAX_EVENTS_PER_BUNDLE = 8;

    for (const [, items] of userMatchedEvents) {
      if (items.length === 0) continue;
      const user = items[0].user;

      for (let offset = 0; offset < items.length; offset += MAX_EVENTS_PER_BUNDLE) {
        const slice = items.slice(offset, offset + MAX_EVENTS_PER_BUNDLE);

        if (slice.length === 1) {
          const { event, priority } = slice[0];
          let durationFormatted: string | undefined;
          if (event.type === "SLOT_APPEARED" && this.historyDao) {
            try {
              if (typeof (this.historyDao as any).getSlotAnalytics === "function") {
                durationFormatted = this.historyDao.getSlotAnalytics(event.poolSlug, event.block)?.avgDurationFormatted;
              } else if (typeof (this.historyDao as any).getAverageDurationFormatted === "function") {
                durationFormatted = (this.historyDao as any).getAverageDurationFormatted(event.poolSlug, event.block);
              }
            } catch {}
          }
          const msg = this.formatAlertMessage(user, event, priority, durationFormatted);
          this.enqueue(msg);
        } else {
          const matched = slice.map((i) => ({ event: i.event, priority: i.priority }));
          const bundleMsg = this.formatBundledAlertMessage(user, matched);
          this.enqueue(bundleMsg);
        }
      }
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
