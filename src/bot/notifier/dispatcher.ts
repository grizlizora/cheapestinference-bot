import { Bot, InlineKeyboard } from "grammy";
import { BotContext } from "../../types/context.js";
import { DiffEvent } from "../../types/domain.js";
import { UserDAO } from "../../db/dao/users.js";
import { NotificationLogDAO } from "../../db/dao/notificationLogs.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { SubscriberInvertedIndex, PackedUserProfile } from "./subscriberIndex.js";
import { CircularRingBuffer } from "./circularRingBuffer.js";
import { SupportedLanguage, translate } from "../../i18n/index.js";

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

  private isWorkerRunning = false;
  private isPaused = false;
  private pauseUntil = 0;

  // Rate Limiting Parameters (Target: 27 msg/s = ~37ms per token)
  private readonly targetRatePerSec = 27;
  private readonly tokenIntervalMs = 1000 / this.targetRatePerSec;
  private tokens = 25;
  private readonly maxTokens = 25;
  private lastTokenRefill = performance.now();

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
   */
  public async handleDiffEvents(events: DiffEvent[]): Promise<void> {
    if (!events || events.length === 0) return;

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
        const msg = this.formatAlertMessage(sub, event, priority);
        this.enqueue(msg);
      }
    }
  }

  public enqueue(msg: OutgoingAlertMessage): void {
    switch (msg.priority) {
      case "P0":
        this.p0Queue.push(msg);
        break;
      case "P1":
        this.p1Queue.push(msg);
        break;
      case "P2":
        this.p2Queue.push(msg);
        break;
      case "P3":
      default:
        this.p3Queue.push(msg);
        break;
    }

    if (!this.isWorkerRunning) {
      this.startWorkerLoop();
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

      // Refill Token Bucket
      const elapsed = now - this.lastTokenRefill;
      if (elapsed >= this.tokenIntervalMs) {
        const newTokens = Math.floor(elapsed / this.tokenIntervalMs);
        this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
        this.lastTokenRefill = now;
      }

      if (this.getTotalPending() === 0) {
        this.isWorkerRunning = false;
        return;
      }

      if (this.tokens >= 1) {
        const item = this.selectNextItem();
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

  /**
   * Deficit Round-Robin Item Selection (P0 -> P1 -> P2 -> P3)
   */
  private selectNextItem(): OutgoingAlertMessage | undefined {
    if (!this.p0Queue.isEmpty()) return this.p0Queue.pop();
    if (!this.p1Queue.isEmpty()) return this.p1Queue.pop();
    if (!this.p2Queue.isEmpty()) return this.p2Queue.pop();
    if (!this.p3Queue.isEmpty()) return this.p3Queue.pop();
    return undefined;
  }

  private async dispatchSingleMessage(msg: OutgoingAlertMessage): Promise<void> {
    try {
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

      if (msg.retries < 5) {
        msg.retries++;
        this.p1Queue.unshift(msg);
      }
      return;
    }

    // 3. Transient Network Errors
    if (msg.retries < 3) {
      msg.retries++;
      this.p2Queue.push(msg);
    } else {
      console.error(`❌ [NotificationDispatcher] Dropping message to ${msg.telegramId} after 3 retries: ${err.message}`);
    }
  }

  private formatAlertMessage(
    user: PackedUserProfile,
    event: DiffEvent,
    priority: BroadcastPriority
  ): OutgoingAlertMessage {
    const lang = user.language;
    const blockName = translate(lang, `common.block_${event.block}`) || event.block;
    const timeFormatted = new Date(event.timestamp).toISOString().replace("T", " ").substring(0, 19);

    let text = "";
    let keyboard: InlineKeyboard | undefined;

    if (event.type === "SLOT_APPEARED") {
      const header = translate(lang, "alerts.slot_appeared_header");
      const body = translate(lang, "alerts.slot_appeared_body", {
        pool_name: event.poolName,
        block_name: blockName,
        hours_utc: event.hoursUtc,
        models: (event.models || []).join(", "),
        price: event.newPrice || "0",
        timestamp: timeFormatted,
      });

      text = `${header}\n\n${body}`;

      if (this.historyDao) {
        const analytics = this.historyDao.getSlotAnalytics(event.poolSlug, event.block);
        if (analytics.avgDurationFormatted) {
          text += translate(lang, "alerts.analytics_duration_tip", {
            duration: analytics.avgDurationFormatted,
          });
        }
      }

      keyboard = new InlineKeyboard().url(
        translate(lang, "alerts.btn_claim_slot"),
        `https://cheapestinference.com/pools/${event.poolSlug}#${event.block}`
      );
    } else if (event.type === "SLOT_DISAPPEARED") {
      const header = translate(lang, "alerts.slot_disappeared_header");
      const body = translate(lang, "alerts.slot_disappeared_body", {
        pool_name: event.poolName,
        block_name: blockName,
        timestamp: timeFormatted,
      });
      text = `${header}\n\n${body}`;
    } else if (event.type === "MODEL_UPGRADE_EVENT") {
      const header = translate(lang, "alerts.model_upgrade_header");
      const diffLines: string[] = [];

      if (event.modelUpgrade) {
        for (const up of event.modelUpgrade.upgraded) {
          diffLines.push(
            translate(lang, "alerts.model_item_upgraded", {
              old_model: up.previousModelName || "",
              new_model: up.modelName,
            })
          );
        }
        for (const add of event.modelUpgrade.added) {
          diffLines.push(
            translate(lang, "alerts.model_item_added", {
              model_name: add.modelName,
            })
          );
        }
        for (const rem of event.modelUpgrade.removed) {
          diffLines.push(
            translate(lang, "alerts.model_item_removed", {
              model_name: rem.modelName,
            })
          );
        }
      }

      const body = translate(lang, "alerts.model_upgrade_body", {
        pool_name: event.poolName,
        model_diff_block: diffLines.length > 0 ? diffLines.join("\n") : "• " + (event.models || []).join(", "),
        all_models: (event.models || []).join(", "),
      });

      text = `${header}\n\n${body}`;
      keyboard = new InlineKeyboard().url(
        translate(lang, "common.open_site"),
        `https://cheapestinference.com/pools/${event.poolSlug}`
      );
    } else if (event.type === "SLOT_PRICE_CHANGED") {
      const header = translate(lang, "alerts.slot_price_changed_header");
      let deltaBadge = "";
      if (event.slotPrice) {
        const sign = event.slotPrice.priceDelta > 0 ? "+" : "";
        deltaBadge = `${sign}$${event.slotPrice.priceDelta}/mo (${sign}${event.slotPrice.percentageDelta}%)`;
        if (event.slotPrice.isDiscount) {
          deltaBadge = `🟢 <b>${deltaBadge} (Price Drop!)</b>`;
        } else {
          deltaBadge = `🔴 <b>${deltaBadge}</b>`;
        }
      }

      const body = translate(lang, "alerts.slot_price_changed_body", {
        pool_name: event.poolName,
        block_name: blockName,
        old_price: event.previousPrice || "0",
        new_price: event.newPrice || "0",
        delta_badge: deltaBadge,
        hours_utc: event.hoursUtc,
      });

      text = `${header}\n\n${body}`;
      keyboard = new InlineKeyboard().url(
        translate(lang, "alerts.btn_claim_slot"),
        `https://cheapestinference.com/pools/${event.poolSlug}#${event.block}`
      );
    } else if (event.type === "POOL_BASE_PRICE_CHANGED" || event.type === "PRICE_CHANGED") {
      const header = translate(lang, "alerts.pool_base_price_header");
      let deltaBadge = "";
      if (event.basePrice) {
        const sign = event.basePrice.priceDelta > 0 ? "+" : "";
        deltaBadge = `${sign}$${event.basePrice.priceDelta}/mo (${sign}${event.basePrice.percentageDelta}%)`;
        if (event.basePrice.priceDelta < 0) {
          deltaBadge = `🟢 <b>${deltaBadge} (Price Drop!)</b>`;
        } else {
          deltaBadge = `🔴 <b>${deltaBadge}</b>`;
        }
      }

      const body = translate(lang, "alerts.pool_base_price_body", {
        pool_name: event.poolName,
        old_price: event.previousPrice || "0",
        new_price: event.newPrice || "0",
        delta_badge: deltaBadge,
        models: (event.models || []).join(", "),
      });

      text = `${header}\n\n${body}`;
      keyboard = new InlineKeyboard().url(
        translate(lang, "common.open_site"),
        `https://cheapestinference.com/pools/${event.poolSlug}`
      );
    } else if (event.type === "TIER_UPDATED_EVENT") {
      const header = translate(lang, "alerts.tier_updated_header");
      const diffLines: string[] = [];
      if (event.tierUpdate?.newDescription) {
        diffLines.push(translate(lang, "alerts.tier_desc_change", { new_description: event.tierUpdate.newDescription }));
      }
      if (event.tierUpdate?.newAnnualDiscount) {
        diffLines.push(
          translate(lang, "alerts.tier_discount_change", {
            old_discount: ((event.tierUpdate.previousAnnualDiscount || 0.15) * 100).toFixed(0),
            new_discount: (event.tierUpdate.newAnnualDiscount * 100).toFixed(0),
          })
        );
      }

      const body = translate(lang, "alerts.tier_updated_body", {
        pool_name: event.poolName,
        tier_diff_block: diffLines.join("\n"),
        timestamp: timeFormatted,
      });

      text = `${header}\n\n${body}`;
      keyboard = new InlineKeyboard().url(
        translate(lang, "common.open_site"),
        `https://cheapestinference.com/pools/${event.poolSlug}`
      );
    } else {
      // General Fallback
      text = `🚨 <b>CheapestInference Alert</b>\n\nPool: <b>${event.poolName}</b> (${blockName})\nStatus: <b>${event.newStatus}</b>`;
    }

    return {
      id: crypto.randomUUID(),
      telegramId: user.telegramId,
      userId: user.userId,
      poolSlug: event.poolSlug,
      blockId: event.block,
      eventType: event.type,
      text,
      keyboard,
      isMuted: user.isMuted,
      priority,
      retries: 0,
      enqueuedAt: Date.now(),
    };
  }

  private flushBlockedUsersToDb(): void {
    if (this.blockedUsersBatch.length === 0) return;
    const batch = [...this.blockedUsersBatch];
    this.blockedUsersBatch = [];

    try {
      const placeholders = batch.map(() => "?").join(",");
      (this.userDao as any).db
        .prepare(`UPDATE users SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE telegram_id IN (${placeholders})`)
        .run(...batch);
      console.log(`🧹 [NotificationDispatcher] Deactivated ${batch.length} blocked users in database batch.`);
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
