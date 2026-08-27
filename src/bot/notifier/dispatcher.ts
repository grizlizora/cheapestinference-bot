import { Bot, InlineKeyboard } from "grammy";
import { BotContext } from "../../types/context.js";
import { DiffEvent, PriceAnalyticsPayload } from "../../types/domain.js";
import { UserDAO } from "../../db/dao/users.js";
import { NotificationLogDAO } from "../../db/dao/notificationLogs.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { SubscriberInvertedIndex, PackedUserProfile } from "./subscriberIndex.js";
import { CircularRingBuffer } from "./circularRingBuffer.js";
import { translate, escapeHtml, SupportedLanguage } from "../../i18n/index.js";

export type BroadcastPriority = "P0" | "P1" | "P2" | "P3";

export interface OutgoingAlertMessage {
  id: string;
  telegramId: number;
  userId: number;
  poolSlug: string;
  blockId: string;
  eventType: string;
  text: string;
  keyboard?: InlineKeyboard;
  isMuted: boolean;
  priority: BroadcastPriority;
  retries: number;
  enqueuedAt: number;
}

export class NotificationDispatcher {
  private index: SubscriberInvertedIndex;
  private p0Queue = new CircularRingBuffer<OutgoingAlertMessage>(256);
  private p1Queue = new CircularRingBuffer<OutgoingAlertMessage>(16384);
  private p2Queue = new CircularRingBuffer<OutgoingAlertMessage>(8192);
  private p3Queue = new CircularRingBuffer<OutgoingAlertMessage>(4096);

  // Deficit Weighted Round-Robin (DWRR) State
  private p0Deficit = 0;
  private p1Deficit = 0;
  private p2Deficit = 0;
  private p3Deficit = 0;
  private readonly quantumP0 = 10;
  private readonly quantumP1 = 5;
  private readonly quantumP2 = 2;
  private readonly quantumP3 = 1;

  private isWorkerRunning = false;
  private isPaused = false;
  private pauseUntil = 0;

  // Rate Limiting Parameters (Target: 27 msg/s = ~37ms per token)
  private readonly targetRatePerSec = 27;
  private readonly tokenIntervalMs = 1000 / this.targetRatePerSec;
  private tokens = 25;
  private readonly maxTokens = 25;
  private lastTokenRefill = performance.now();

  // Per-User Rate Limiter & Message Stale Expiration
  private lastUserDispatchTime = new Map<number, number>();
  private readonly USER_DISPATCH_GAP_MS = 1050; // 1.05s between messages to same chat
  private readonly MAX_MESSAGE_AGE_MS = 10 * 60 * 1000; // 10 min TTL for notifications

  // Blocked users debounced batch
  private blockedUsersBatch: number[] = [];
  private batchFlushTimer?: NodeJS.Timeout;

  constructor(
    private bot: Bot<BotContext>,
    private userDao: UserDAO,
    private logDao: NotificationLogDAO,
    private historyDao?: SlotHistoryDAO,
    index?: SubscriberInvertedIndex
  ) {
    this.index = index ?? new SubscriberInvertedIndex((userDao as any).db);

    this.batchFlushTimer = setInterval(() => this.flushBlockedUsersToDb(), 5000);
    this.batchFlushTimer.unref();
  }

  public getInvertedIndex(): SubscriberInvertedIndex {
    return this.index;
  }

  /**
   * Main entrypoint for processing DiffEvents from ScraperOrchestrator
   * Implements Event Bundling / Coalescing with 3,800 character chunking limits
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
      } else if (event.type === "MODEL_UPGRADE_EVENT" || event.type === "NEW_POOL_EVENT") {
        resolvedType = "models";
        priority = "P2";
      } else if (
        event.type === "SLOT_PRICE_CHANGED" ||
        event.type === "POOL_BASE_PRICE_CHANGED" ||
        event.type === "PRICE_CHANGED"
      ) {
        resolvedType = "prices";
        priority = "P2";
      } else if (event.type === "TIER_UPDATED_EVENT") {
        resolvedType = "models";
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
        const msg = this.formatAlertMessage(user, single.event, single.priority, cachedDuration);
        this.enqueue(msg);
      } else {
        // Chunk bundles so no single Telegram message exceeds the 4096 char limit
        const MAX_BUNDLE_EVENTS_PER_MSG = 8;
        for (let i = 0; i < matchedEvents.length; i += MAX_BUNDLE_EVENTS_PER_MSG) {
          const slice = matchedEvents.slice(i, i + MAX_BUNDLE_EVENTS_PER_MSG);
          if (slice.length === 1) {
            const cachedDuration = eventAnalyticsCache.get(slice[0].event.id);
            this.enqueue(this.formatAlertMessage(user, slice[0].event, slice[0].priority, cachedDuration));
          } else {
            const msg = this.formatBundledAlertMessage(user, slice);
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

      const now = performance.now();

      // Check if paused due to 429 backoff
      if (this.isPaused) {
        if (now < this.pauseUntil) {
          const waitMs = Math.max(10, Math.ceil(this.pauseUntil - now));
          setTimeout(processNextTick, waitMs);
          return;
        }
        this.isPaused = false;
      }

      // Refill Token Bucket with exact integer multiplication to avoid timing drift
      const elapsed = now - this.lastTokenRefill;
      if (elapsed >= this.tokenIntervalMs) {
        const newTokens = Math.floor(elapsed / this.tokenIntervalMs);
        this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
        this.lastTokenRefill += newTokens * this.tokenIntervalMs;
      }

      if (this.getTotalPending() === 0) {
        this.isWorkerRunning = false;
        return;
      }

      if (this.tokens >= 1) {
        const item = this.selectNextItemDWRR();
        if (item) {
          this.tokens -= 1;
          this.dispatchSingleMessage(item).catch(() => {});
        }
      }

      // Jittered next tick: 37ms ± 3ms to avoid thundering harmonic edge spikes
      const jitter = (Math.random() - 0.5) * 6;
      const delay = Math.max(5, this.tokenIntervalMs + jitter);
      setTimeout(processNextTick, delay);
    };

    setImmediate(processNextTick);
  }

  private popValidCandidate(q: CircularRingBuffer<OutgoingAlertMessage>): OutgoingAlertMessage | undefined {
    const now = Date.now();
    const skipped: OutgoingAlertMessage[] = [];
    let chosen: OutgoingAlertMessage | undefined;

    while (!q.isEmpty()) {
      const candidate = q.pop()!;
      // 1. Drop stale alerts (> 10 min old)
      if (now - candidate.enqueuedAt > this.MAX_MESSAGE_AGE_MS) {
        continue;
      }
      // Drop alerts for users deactivated/blocked while message was in queue
      const profile = this.index.getProfileByTgId(candidate.telegramId);
      if (profile && !profile.isActive) {
        continue;
      }
      // 2. Check per-user rate limit (1 msg/s)
      const lastSent = this.lastUserDispatchTime.get(candidate.telegramId) || 0;
      if (now - lastSent < this.USER_DISPATCH_GAP_MS) {
        skipped.push(candidate);
        if (skipped.length > 20) break; // Avoid deep scan on high burst
        continue;
      }
      chosen = candidate;
      break;
    }

    // Re-queue skipped candidates back to the front
    for (let i = skipped.length - 1; i >= 0; i--) {
      q.unshift(skipped[i]);
    }
    return chosen;
  }

  /**
   * Deficit Weighted Round-Robin (DWRR) Item Selection
   * Guarantees that lower-priority alerts (P3 sold out, P2 models) are never starved during P1 bursts
   */
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

    // Fallback: Return any available valid message in priority order
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
      this.lastUserDispatchTime.set(msg.telegramId, Date.now());

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
      this.isPaused = true;
      this.pauseUntil = performance.now() + (retryAfter + 0.5) * 1000;
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

  private cleanPriceString(val: string | number | undefined | null): string {
    if (val === undefined || val === null || val === "") return "0";
    const cleaned = String(val).replace(/[^0-9.-]/g, "");
    const num = parseFloat(cleaned);
    if (isNaN(num) || Object.is(num, -0) || num === 0) return "0";
    return num % 1 === 0 ? num.toFixed(0) : num.toFixed(2);
  }

  private formatPriceDeltaBadge(
    delta: number,
    pct: number,
    lang: SupportedLanguage
  ): string {
    const roundedDelta = Math.round(Math.abs(delta) * 100) / 100;
    if (roundedDelta === 0) return "";
    const currencyMonth = translate(lang, "common.currency_month") || "mo";
    const absDelta = Number.isInteger(roundedDelta) ? roundedDelta.toFixed(0) : roundedDelta.toFixed(2);
    const roundedPct = Math.round(Math.abs(pct) * 10) / 10;
    const absPct = Number.isInteger(roundedPct) ? roundedPct.toFixed(0) : roundedPct.toFixed(1);

    if (delta < 0) {
      return translate(lang, "alerts.price_discount_badge", {
        delta: absDelta,
        percentage: absPct,
        currency_month: currencyMonth,
      });
    } else {
      return translate(lang, "alerts.price_increase_badge", {
        delta: absDelta,
        percentage: absPct,
        currency_month: currencyMonth,
      });
    }
  }

  private formatPriceRatingBadge(
    pa: PriceAnalyticsPayload | undefined,
    currentPrice: number,
    lang: SupportedLanguage
  ): string {
    if (!pa || pa.rating === "insufficient_data" || pa.sampleCount < 3) return "";
    const currStr = currentPrice % 1 === 0 ? currentPrice.toFixed(0) : currentPrice.toFixed(2);
    const avgStr =
      pa.avgPrice != null ? (pa.avgPrice % 1 === 0 ? pa.avgPrice.toFixed(0) : pa.avgPrice.toFixed(2)) : "";

    if (pa.rating === "all_time_low") {
      return translate(lang, "alerts.price_all_time_low") || `🔥 <b>Історичний мінімум! Найнижча ціна ($${currStr})</b>`;
    }
    if (pa.rating === "below_average" && pa.avgPrice) {
      return (
        translate(lang, "alerts.price_below_average", { current: currStr, avg: avgStr }) ||
        `🟢 <b>Нижче середнього ($${currStr} vs сер. $${avgStr})</b>`
      );
    }
    if (pa.rating === "above_average" && pa.avgPrice) {
      return (
        translate(lang, "alerts.price_above_average", { current: currStr, avg: avgStr }) ||
        `🔴 <b>Вище середнього ($${currStr} vs сер. $${avgStr})</b>`
      );
    }
    if (pa.rating === "fair" && pa.avgPrice) {
      return translate(lang, "alerts.price_fair_value") || "⚖️ <b>Стандартна ціна (в межах норми)</b>";
    }
    return "";
  }

  private truncateToTelegramLimit(text: string, maxLen = 3900): string {
    if (text.length <= maxLen) return text;
    let truncated = text.substring(0, maxLen - 30);
    const lastNewline = truncated.lastIndexOf("\n");
    if (lastNewline > maxLen / 2) {
      truncated = truncated.substring(0, lastNewline);
    }
    truncated = truncated.replace(/<[^>]*$/, "");

    // Strict LIFO tag stack for 100% valid HTML closing
    const stack: string[] = [];
    for (const match of truncated.matchAll(/<\/?([a-z0-9]+)[^>]*>/gi)) {
      const fullTag = match[0];
      const tagName = match[1].toLowerCase();
      if (tagName === "br" || tagName === "hr") continue;

      if (fullTag.startsWith("</")) {
        if (stack.length > 0 && stack[stack.length - 1] === tagName) {
          stack.pop();
        }
      } else {
        stack.push(tagName);
      }
    }

    while (stack.length > 0) {
      const tagToClose = stack.pop();
      truncated += `</${tagToClose}>`;
    }

    return truncated + "\n\n<i>...[truncated]</i>";
  }

  private formatAlertMessage(
    user: PackedUserProfile,
    event: DiffEvent,
    priority: BroadcastPriority,
    cachedDurationFormatted?: string
  ): OutgoingAlertMessage {
    const lang = user.language;
    const blockName = translate(lang, `common.block_${event.block}`) || event.block;
    const timeFormatted = new Date(event.timestamp).toISOString().replace("T", " ").substring(0, 19);
    const currencyMonth = translate(lang, "common.currency_month") || "mo";

    const blockHash = event.block && event.block !== "ALL" ? `#${event.block}` : "";
    const poolUrl = `https://cheapestinference.com/pools/${event.poolSlug}`;
    const checkoutUrl = `${poolUrl}${blockHash}`;

    let text = "";
    let keyboard: InlineKeyboard | undefined;

    if (event.type === "SLOT_APPEARED") {
      const isLimited = event.newStatus === "limited";
      const statusIcon = isLimited ? "🟡" : "🟢";
      const statusBadge = isLimited
        ? translate(lang, "common.status_limited")
        : translate(lang, "common.status_available");

      const header = translate(lang, "alerts.slot_appeared_header", {
        status_icon: statusIcon,
        pool_name: escapeHtml(event.poolName),
      });

      const body = translate(lang, "alerts.slot_appeared_body", {
        pool_name: escapeHtml(event.poolName),
        block_name: escapeHtml(blockName),
        hours_utc: escapeHtml(event.hoursUtc),
        models: (event.models || []).map((m) => `<code>${escapeHtml(m)}</code>`).join(", "),
        price: escapeHtml(this.cleanPriceString(event.newPrice)),
        currency_month: currencyMonth,
        status_badge: statusBadge,
        timestamp: timeFormatted,
      });

      text = `${header}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${body}`;

      if (event.analytics?.isBatchDrop) {
        const batchBadge = translate(lang, "alerts.tag_multi_region_drop", { count: event.analytics.totalOpenings || 2 }) ||
          "🆕 <i>Новий дроп потужностей</i>";
        text = `${batchBadge}\n${text}`;
      } else if (event.analytics?.demandCategory === "hot" && event.analytics.avgLifespanFormatted) {
        const hotBadge = translate(lang, "alerts.tag_hot_slot_drop", { duration: escapeHtml(event.analytics.avgLifespanFormatted) }) ||
          `🔥 <i>Гарячий слот (розбирають за ${escapeHtml(event.analytics.avgLifespanFormatted)})</i>`;
        text = `${hotBadge}\n${text}`;
      } else if (cachedDurationFormatted) {
        text += translate(lang, "alerts.analytics_duration_tip", {
          duration: escapeHtml(cachedDurationFormatted),
        });
      }

      const btnLabel = translate(lang, "alerts.btn_claim_slot_block", {
        block_name: blockName,
        price: escapeHtml(this.cleanPriceString(event.newPrice)),
        currency_month: currencyMonth,
      });

      keyboard = new InlineKeyboard().url(btnLabel, checkoutUrl);
    } else if (event.type === "SLOT_DISAPPEARED") {
      const header = translate(lang, "alerts.slot_disappeared_header", {
        pool_name: escapeHtml(event.poolName),
      });
      let body = translate(lang, "alerts.slot_disappeared_body", {
        pool_name: escapeHtml(event.poolName),
        block_name: escapeHtml(blockName),
        timestamp: timeFormatted,
      });

      const eta = event.analytics?.eta;
      if (eta) {
        if (eta.isPredictable) {
          let confBadge = translate(lang, "intelligence.conf_low") || "⚪";
          if (eta.confidence === "HIGH") {
            confBadge = translate(lang, "intelligence.conf_high") || "🟢 Висока точність";
          } else if (eta.confidence === "MEDIUM") {
            confBadge = translate(lang, "intelligence.conf_medium") || "🟡 Середня точність";
          }
          const cadence = eta.detectedCadenceHours
            ? translate(lang, "intelligence.cadence_daily") || "добовий цикл ~24h"
            : eta.formattedEtaWindow;
          body += `\n\n🔮 <b>${translate(lang, "intelligence.eta_title") || "Очікувана поява"}:</b> <code>${escapeHtml(cadence)}</code> [${confBadge}]`;
        } else {
          body += `\n\n🔮 <b>${translate(lang, "intelligence.eta_title") || "Прогноз"}:</b> <i>${
            translate(lang, "intelligence.eta_gathering_data", {
              count: eta.sampleCount,
              min: eta.minRequired,
            }) || `Збір статистики (${eta.sampleCount}/${eta.minRequired})`
          }</i>`;
        }
      }

      text = `${header}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${body}`;
    } else if (event.type === "MODEL_UPGRADE_EVENT") {
      const header = translate(lang, "alerts.model_upgrade_header", {
        pool_name: escapeHtml(event.poolName),
      });
      const diffLines: string[] = [];

      if (event.modelUpgrade) {
        for (const up of event.modelUpgrade.upgraded) {
          diffLines.push(
            translate(lang, "alerts.model_item_upgraded", {
              old_model: escapeHtml(up.previousModelName || ""),
              new_model: escapeHtml(up.modelName),
            })
          );
        }
        for (const add of event.modelUpgrade.added) {
          diffLines.push(
            translate(lang, "alerts.model_item_added", {
              model_name: escapeHtml(add.modelName),
            })
          );
        }
        for (const rem of event.modelUpgrade.removed) {
          diffLines.push(
            translate(lang, "alerts.model_item_removed", {
              model_name: escapeHtml(rem.modelName),
            })
          );
        }
      }

      const allModelsList = (event.models || []).map((m) => `<code>${escapeHtml(m)}</code>`).join(", ");

      const body = translate(lang, "alerts.model_upgrade_body", {
        pool_name: escapeHtml(event.poolName),
        model_diff_block:
          diffLines.length > 0
            ? diffLines.join("\n")
            : "• " + allModelsList,
        all_models: allModelsList,
        model_count: (event.models || []).length,
      });

      text = `${header}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${body}`;
      keyboard = new InlineKeyboard().url(
        translate(lang, "common.open_site"),
        poolUrl
      );
    } else if (event.type === "SLOT_PRICE_CHANGED") {
      const isDiscount = (event.slotPrice?.priceDelta || 0) < 0;
      const trendIcon = isDiscount ? "📉" : "📈";
      const header = translate(lang, "alerts.slot_price_changed_header", {
        trend_icon: trendIcon,
        pool_name: escapeHtml(event.poolName),
      });

      const deltaBadge = event.slotPrice
        ? this.formatPriceDeltaBadge(event.slotPrice.priceDelta, event.slotPrice.percentageDelta, lang)
        : "";

      const cleanNewPrice = this.cleanPriceString(event.newPrice);
      const newPriceNum = parseFloat(cleanNewPrice) || 0;
      const ratingBadge = this.formatPriceRatingBadge(event.slotPrice?.priceAnalytics, newPriceNum, lang);

      const body = translate(lang, "alerts.slot_price_changed_body", {
        pool_name: escapeHtml(event.poolName),
        block_name: escapeHtml(blockName),
        old_price: escapeHtml(this.cleanPriceString(event.previousPrice)),
        new_price: escapeHtml(cleanNewPrice),
        currency_month: currencyMonth,
        delta_badge: deltaBadge + (ratingBadge ? `\n${ratingBadge}` : ""),
        hours_utc: escapeHtml(event.hoursUtc),
      });

      text = `${header}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${body}`;

      const btnLabel = translate(lang, "alerts.btn_claim_slot_block", {
        block_name: blockName,
        price: escapeHtml(cleanNewPrice),
        currency_month: currencyMonth,
      });

      keyboard = new InlineKeyboard().url(btnLabel, checkoutUrl);
    } else if (event.type === "POOL_BASE_PRICE_CHANGED" || event.type === "PRICE_CHANGED") {
      const isDiscount = (event.basePrice?.priceDelta || 0) < 0;
      const trendIcon = isDiscount ? "📉" : "📈";
      const header = translate(lang, "alerts.pool_base_price_header", {
        trend_icon: trendIcon,
        pool_name: escapeHtml(event.poolName),
      });

      const deltaBadge = event.basePrice
        ? this.formatPriceDeltaBadge(event.basePrice.priceDelta, event.basePrice.percentageDelta, lang)
        : "";

      const cleanNewPrice = this.cleanPriceString(event.newPrice);
      const newPriceNum = parseFloat(cleanNewPrice) || 0;
      const ratingBadge = this.formatPriceRatingBadge(event.basePrice?.priceAnalytics, newPriceNum, lang);

      const body = translate(lang, "alerts.pool_base_price_body", {
        pool_name: escapeHtml(event.poolName),
        old_price: escapeHtml(this.cleanPriceString(event.previousPrice)),
        new_price: escapeHtml(cleanNewPrice),
        currency_month: currencyMonth,
        delta_badge: deltaBadge + (ratingBadge ? `\n${ratingBadge}` : ""),
        models: (event.models || []).map((m) => `<code>${escapeHtml(m)}</code>`).join(", "),
      });

      text = `${header}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${body}`;
      keyboard = new InlineKeyboard().url(
        translate(lang, "common.open_site"),
        poolUrl
      );
    } else if (event.type === "TIER_UPDATED_EVENT") {
      const header = translate(lang, "alerts.tier_updated_header", {
        pool_name: escapeHtml(event.poolName),
      });
      const diffLines: string[] = [];
      if (event.tierUpdate?.newDescription) {
        diffLines.push(
          translate(lang, "alerts.tier_desc_change", {
            new_description: escapeHtml(event.tierUpdate.newDescription),
          })
        );
      }
      if (event.tierUpdate?.newAnnualDiscount) {
        diffLines.push(
          translate(lang, "alerts.tier_discount_change", {
            old_discount: ((event.tierUpdate.previousAnnualDiscount || 0.15) * 100).toFixed(0),
            new_discount: (event.tierUpdate.newAnnualDiscount * 100).toFixed(0),
          })
        );
      }
      if (event.tierUpdate?.newInfraSpec) {
        diffLines.push(
          translate(lang, "alerts.tier_infra_change", {
            new_infra: escapeHtml(event.tierUpdate.newInfraSpec),
          })
        );
      }
      if (event.tierUpdate?.newManualProvisioning !== undefined) {
        const provText = event.tierUpdate.newManualProvisioning
          ? lang === "uk"
            ? "Ручна видача"
            : lang === "ru"
            ? "Ручная выдача"
            : "Manual"
          : lang === "uk"
          ? "Миттєва авто-видача"
          : lang === "ru"
          ? "Мгновенная авто-выдача"
          : "Instant Automatic";
        diffLines.push(
          translate(lang, "alerts.tier_prov_change", {
            provisioning: escapeHtml(provText),
          })
        );
      }

      const body = translate(lang, "alerts.tier_updated_body", {
        pool_name: escapeHtml(event.poolName),
        tier_diff_block: diffLines.join("\n"),
        timestamp: timeFormatted,
      });

      text = `${header}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${body}`;
      keyboard = new InlineKeyboard().url(
        translate(lang, "common.open_site"),
        poolUrl
      );
    } else if (event.type === "NEW_POOL_EVENT") {
      const header = translate(lang, "alerts.new_pool_header", {
        pool_name: escapeHtml(event.poolName),
      });
      const body = translate(lang, "alerts.new_pool_body", {
        pool_name: escapeHtml(event.poolName),
        models: (event.models || []).map((m) => `<code>${escapeHtml(m)}</code>`).join(", "),
        min_price: escapeHtml(this.cleanPriceString(event.newPrice)),
        currency_month: currencyMonth,
        description: escapeHtml((event.metadata?.description as string) || "High-performance compute pool"),
      });

      text = `${header}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${body}`;
      keyboard = new InlineKeyboard().url(
        translate(lang, "common.open_site"),
        poolUrl
      );
    } else {
      text = `🚨 <b>CheapestInference Alert</b>\n\nPool: <b>${escapeHtml(event.poolName)}</b> (${escapeHtml(blockName)})\nStatus: <b>${escapeHtml(event.newStatus || "updated")}</b>`;
    }

    return {
      id: crypto.randomUUID(),
      telegramId: user.telegramId,
      userId: user.userId,
      poolSlug: event.poolSlug,
      blockId: event.block,
      eventType: event.type,
      text: this.truncateToTelegramLimit(text),
      keyboard,
      isMuted: user.isMuted,
      priority,
      retries: 0,
      enqueuedAt: Date.now(),
    };
  }

  private formatBundledAlertMessage(
    user: PackedUserProfile,
    matchedEvents: Array<{ event: DiffEvent; priority: BroadcastPriority }>
  ): OutgoingAlertMessage {
    const lang = user.language;
    const count = matchedEvents.length;
    const timeFormatted = new Date().toISOString().replace("T", " ").substring(0, 19);
    const currencyMonth = translate(lang, "common.currency_month") || "mo";

    const title = translate(lang, "alerts.batch_title", { count }) ||
      `⚡ <b>CheapestInference — Slot Updates (${count})</b>`;

    const sectionLines: string[] = [];
    const keyboard = new InlineKeyboard();

    let highestPriority: BroadcastPriority = "P3";
    for (const item of matchedEvents) {
      if (item.priority === "P1") highestPriority = "P1";
      else if (item.priority === "P2" && highestPriority !== "P1") highestPriority = "P2";
    }

    let buttonCount = 0;

    for (const { event } of matchedEvents) {
      const blockName = translate(lang, `common.block_${event.block}`) || event.block;
      const blockHash = event.block && event.block !== "ALL" ? `#${event.block}` : "";
      const checkoutUrl = `https://cheapestinference.com/pools/${event.poolSlug}${blockHash}`;

      if (event.type === "SLOT_APPEARED") {
        const cleanPrice = this.cleanPriceString(event.newPrice);
        const lifespanBadge = event.analytics?.avgLifespanFormatted
          ? ` ${event.analytics.demandCategory === "hot" ? "🔥" : "⚡"} <code>${escapeHtml(event.analytics.avgLifespanFormatted)}</code>`
          : "";
        sectionLines.push(
          `🟢 <b>${escapeHtml(event.poolName)} • ${escapeHtml(blockName)}</b>${lifespanBadge}\n` +
          `💰 <code>$${escapeHtml(cleanPrice)}/${currencyMonth}</code> | 🕒 <code>${escapeHtml(event.hoursUtc)}</code>\n` +
          `🤖 ${(event.models || []).map((m) => `<code>${escapeHtml(m)}</code>`).join(", ")}`
        );

        if (buttonCount < 3) {
          const btnLabel = `⚡ ${event.poolSlug.toUpperCase()} (${blockName}) • $${cleanPrice}`;
          keyboard.url(btnLabel, checkoutUrl).row();
          buttonCount++;
        }
      } else if (event.type === "SLOT_DISAPPEARED") {
        sectionLines.push(
          `🔒 <b>${escapeHtml(event.poolName)} • ${escapeHtml(blockName)}</b> — <i>${translate(lang, "common.status_sold_out")}</i>`
        );
        if (buttonCount < 3) {
          const btnLabel = `🔍 ${event.poolSlug.toUpperCase()}`;
          keyboard.url(btnLabel, `https://cheapestinference.com/pools/${event.poolSlug}`).row();
          buttonCount++;
        }
      } else if (event.type === "MODEL_UPGRADE_EVENT") {
        const upgradeTitle =
          translate(lang, "alerts.bundle_title_models") || "Model Upgrade";
        sectionLines.push(
          `🚀 <b>${escapeHtml(event.poolName)} • ${upgradeTitle}</b>\n` +
          `🤖 ${(event.models || []).map((m) => `<code>${escapeHtml(m)}</code>`).join(", ")}`
        );
      } else if (event.type === "SLOT_PRICE_CHANGED") {
        const deltaStr = event.slotPrice
          ? ` (${this.formatPriceDeltaBadge(event.slotPrice.priceDelta, event.slotPrice.percentageDelta, lang)})`
          : "";
        const cleanOld = this.cleanPriceString(event.previousPrice);
        const cleanNew = this.cleanPriceString(event.newPrice);
        const hoursStr = event.hoursUtc ? ` | 🕒 <code>${escapeHtml(event.hoursUtc)}</code>` : "";
        sectionLines.push(
          `🏷 <b>${escapeHtml(event.poolName)} • ${escapeHtml(blockName)}</b>\n` +
          `💰 <s>$${escapeHtml(cleanOld)}</s> ➔ <b>$${escapeHtml(cleanNew)}/${currencyMonth}</b>${deltaStr}${hoursStr}`
        );
        if (buttonCount < 3) {
          const btnLabel = `🏷 ${event.poolSlug.toUpperCase()} (${blockName}) • $${cleanNew}`;
          keyboard.url(btnLabel, checkoutUrl).row();
          buttonCount++;
        }
      } else if (event.type === "POOL_BASE_PRICE_CHANGED" || event.type === "PRICE_CHANGED") {
        const deltaStr = event.basePrice
          ? ` (${this.formatPriceDeltaBadge(event.basePrice.priceDelta, event.basePrice.percentageDelta, lang)})`
          : "";
        const cleanOld = this.cleanPriceString(event.previousPrice);
        const cleanNew = this.cleanPriceString(event.newPrice);
        const tariffBadge = translate(lang, "alerts.bundle_title_base_price") || "Base Tariff";
        sectionLines.push(
          `💰 <b>${escapeHtml(event.poolName)} • ${tariffBadge}</b>\n` +
          `💵 <s>$${escapeHtml(cleanOld)}</s> ➔ <b>$${escapeHtml(cleanNew)}/${currencyMonth}</b>${deltaStr}\n` +
          `🤖 ${(event.models || []).map((m) => `<code>${escapeHtml(m)}</code>`).join(", ")}`
        );
        if (buttonCount < 3) {
          const btnLabel = `💰 ${event.poolSlug.toUpperCase()} • $${cleanNew}`;
          keyboard.url(btnLabel, `https://cheapestinference.com/pools/${event.poolSlug}`).row();
          buttonCount++;
        }
      } else if (event.type === "TIER_UPDATED_EVENT") {
        const tierTitle =
          translate(lang, "alerts.bundle_title_tier") || "Tier Specification Updated";
        sectionLines.push(
          `📝 <b>${escapeHtml(event.poolName)} • ${tierTitle}</b>`
        );
      } else if (event.type === "NEW_POOL_EVENT") {
        const newPoolTitle =
          translate(lang, "alerts.bundle_title_new_pool") || "New Pool Launched";
        sectionLines.push(
          `✨ <b>${escapeHtml(event.poolName)} • ${newPoolTitle}</b>\n` +
          `🤖 ${(event.models || []).map((m) => `<code>${escapeHtml(m)}</code>`).join(", ")}`
        );
      } else {
        sectionLines.push(`• <b>${escapeHtml(event.poolName)}</b> (${escapeHtml(blockName)}): ${escapeHtml(event.newStatus || "updated")}`);
      }
    }

    if (buttonCount === 0) {
      keyboard.url(
        translate(lang, "common.open_site"),
        "https://cheapestinference.com/pools"
      );
      buttonCount++;
    }

    const footer =
      lang === "uk"
        ? `🕒 <i>Час оновлення: ${timeFormatted} UTC</i>`
        : lang === "ru"
        ? `🕒 <i>Время обновления: ${timeFormatted} UTC</i>`
        : `🕒 <i>Updated at: ${timeFormatted} UTC</i>`;

    const text = `${title}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${sectionLines.join("\n───\n")}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${footer}`;

    const firstEvent = matchedEvents[0].event;

    return {
      id: crypto.randomUUID(),
      telegramId: user.telegramId,
      userId: user.userId,
      poolSlug: firstEvent.poolSlug,
      blockId: "BUNDLE",
      eventType: "BUNDLE_EVENT",
      text: this.truncateToTelegramLimit(text),
      keyboard: buttonCount > 0 ? keyboard : undefined,
      isMuted: user.isMuted,
      priority: highestPriority,
      retries: 0,
      enqueuedAt: Date.now(),
    };
  }

  /**
   * Direct Realistic Test Alert Delivery (P0 Priority)
   */
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

    if (eventType === "slot") {
      const event: DiffEvent = {
        id: crypto.randomUUID(),
        type: "SLOT_APPEARED",
        poolSlug: "frontier",
        poolName: "Frontier Pool",
        block: "europe",
        models: ["deepseek-r1", "qwen-2.5-coder-32b", "glm-5.3"],
        hoursUtc: "08:00 – 16:00 UTC",
        newPrice: "149",
        newStatus: "available",
        timestamp: Date.now(),
      };
      const msg = this.formatAlertMessage(profile, event, "P0");
      this.enqueue(msg);
    } else if (eventType === "bundle") {
      const events: DiffEvent[] = [
        {
          id: crypto.randomUUID(),
          type: "SLOT_APPEARED",
          poolSlug: "frontier",
          poolName: "Frontier Pool",
          block: "europe",
          models: ["deepseek-r1", "glm-5.3"],
          hoursUtc: "08:00 – 16:00 UTC",
          newPrice: "149",
          newStatus: "available",
          timestamp: Date.now(),
        },
        {
          id: crypto.randomUUID(),
          type: "SLOT_APPEARED",
          poolSlug: "core",
          poolName: "Core Pool",
          block: "asia",
          models: ["qwen-2.5-72b", "llama-3.3-70b"],
          hoursUtc: "00:00 – 08:00 UTC",
          newPrice: "99",
          newStatus: "available",
          timestamp: Date.now(),
        },
      ];
      const msg = this.formatBundledAlertMessage(
        profile,
        events.map((e) => ({ event: e, priority: "P0" }))
      );
      this.enqueue(msg);
    } else {
      const event: DiffEvent = {
        id: crypto.randomUUID(),
        type: "MODEL_UPGRADE_EVENT",
        poolSlug: "frontier",
        poolName: "Frontier Pool",
        block: "ALL",
        models: ["glm-5.3", "minimax-m3", "qwen-3.5-turbo"],
        hoursUtc: "",
        timestamp: Date.now(),
        modelUpgrade: {
          added: [{ type: "added", modelName: "qwen-3.5-turbo", family: "qwen", newVersion: "3.5" }],
          upgraded: [
            {
              type: "upgraded",
              modelName: "glm-5.3",
              previousModelName: "glm-5.2",
              family: "glm",
              oldVersion: "5.2",
              newVersion: "5.3",
              changeNote: "GLM 5.2 ➡️ GLM 5.3",
            },
          ],
          removed: [],
          allActiveModels: ["glm-5.3", "minimax-m3", "qwen-3.5-turbo"],
        },
      };
      const msg = this.formatAlertMessage(profile, event, "P0");
      this.enqueue(msg);
    }
  }

  private flushBlockedUsersToDb(): void {
    // Evict user rate-limit timestamps older than 5 minutes to prevent RAM growth
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [tgId, lastSent] of this.lastUserDispatchTime.entries()) {
      if (lastSent < cutoff) {
        this.lastUserDispatchTime.delete(tgId);
      }
    }

    if (this.blockedUsersBatch.length === 0) return;
    const uniqueIds = Array.from(new Set(this.blockedUsersBatch));
    this.blockedUsersBatch = [];

    try {
      this.userDao.deactivateUsersBatch(uniqueIds);
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
    return {
      p0: this.p0Queue.size(),
      p1: this.p1Queue.size(),
      p2: this.p2Queue.size(),
      p3: this.p3Queue.size(),
      total: this.getTotalPending(),
      tokensAvailable: this.tokens,
      isPaused: this.isPaused,
    };
  }
}
