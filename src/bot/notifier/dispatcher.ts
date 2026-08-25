import { Bot, InlineKeyboard } from "grammy";
import { BotContext } from "../../types/context.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { UserDAO } from "../../db/dao/users.js";
import { NotificationLogDAO } from "../../db/dao/notificationLogs.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { DiffEvent } from "../../types/domain.js";
import { SupportedLanguage, translate } from "../../i18n/index.js";

export class NotificationDispatcher {
  private pendingUserEvents = new Map<number, DiffEvent[]>();
  private batchTimers = new Map<number, NodeJS.Timeout>();
  private lastUserSendTime = new Map<number, number>();
  private globalSendQueue: Array<() => Promise<void>> = [];
  private isProcessingGlobalQueue = false;

  constructor(
    private bot: Bot<BotContext>,
    private subDao: SubscriptionDAO,
    private userDao: UserDAO,
    private logDao: NotificationLogDAO,
    private historyDao?: SlotHistoryDAO
  ) {}

  public async dispatchEvents(events: DiffEvent[]): Promise<void> {
    if (events.length === 0) return;

    for (const event of events) {
      if (event.type === "SLOT_APPEARED" || event.type === "SLOT_DISAPPEARED") {
        this.dispatchSingleDiffEvent(event);
      } else if (event.type === "CATALOG_UPDATED" || event.type === "NEW_POOL_EVENT") {
        this.broadcastCatalogUpdate(event);
      } else if (event.type === "PRICE_CHANGED") {
        this.dispatchPriceChangedEvent(event);
      }
    }
  }

  private dispatchSingleDiffEvent(event: DiffEvent): void {
    const eventType = event.type === "SLOT_DISAPPEARED" ? "sold_out" : "available";
    const matches = this.subDao.findSubscribersForSlot(event.poolSlug, event.block, eventType);
    if (matches.length === 0) return;

    for (const match of matches) {
      if (event.type === "SLOT_APPEARED") {
        // 🚀 FAST-PATH: Zero artificial delay for new slot availability alerts
        const user = this.userDao.getByTelegramId(match.telegram_id);
        if (user && user.is_active === 1) {
          const lang = (user.language as SupportedLanguage) || "uk";
          this.sendSingleAlert(user.id, match.telegram_id, lang, user.is_muted === 1, event);
        }
      } else {
        // Regular batching for disappearances/price changes
        this.enqueueForUser(match.telegram_id, event);
      }
    }
  }

  private dispatchPriceChangedEvent(event: DiffEvent): void {
    const matches = this.subDao.findSubscribersForSlot(event.poolSlug, event.block, "available");
    for (const match of matches) {
      this.enqueueForUser(match.telegram_id, event);
    }
  }

  private broadcastCatalogUpdate(event: DiffEvent): void {
    const matches = this.subDao.findSubscribersForSlot(event.poolSlug, "ALL", "available");
    for (const match of matches) {
      this.enqueueForUser(match.telegram_id, event);
    }
  }

  private enqueueForUser(telegramId: number, event: DiffEvent): void {
    const list = this.pendingUserEvents.get(telegramId) || [];
    list.push(event);
    this.pendingUserEvents.set(telegramId, list);

    if (this.batchTimers.has(telegramId)) {
      clearTimeout(this.batchTimers.get(telegramId)!);
    }

    const timer = setTimeout(async () => {
      this.batchTimers.delete(telegramId);
      await this.flushUserEvents(telegramId);
    }, 2500);

    this.batchTimers.set(telegramId, timer);
  }

  public async flushPending(): Promise<void> {
    const userIds = Array.from(this.pendingUserEvents.keys());
    for (const tid of userIds) {
      if (this.batchTimers.has(tid)) {
        clearTimeout(this.batchTimers.get(tid)!);
        this.batchTimers.delete(tid);
      }
      await this.flushUserEvents(tid);
    }
  }

  private async flushUserEvents(telegramId: number): Promise<void> {
    const events = this.pendingUserEvents.get(telegramId);
    this.pendingUserEvents.delete(telegramId);
    if (!events || events.length === 0) return;

    const user = this.userDao.getByTelegramId(telegramId);
    if (!user || user.is_active === 0) return;

    const lang = (user.language as SupportedLanguage) || "uk";

    if (events.length === 1) {
      await this.sendSingleAlert(user.id, telegramId, lang, user.is_muted === 1, events[0]);
    } else {
      // Chunk batches by 12 events to respect max message length
      for (let i = 0; i < events.length; i += 12) {
        if (i > 0) {
          await new Promise((res) => setTimeout(res, 1500));
        }
        const chunk = events.slice(i, i + 12);
        await this.sendBatchAlert(user.id, telegramId, lang, user.is_muted === 1, chunk);
      }
    }
  }

  public async sendSingleAlert(
    userId: number,
    telegramId: number,
    lang: SupportedLanguage,
    isMuted: boolean,
    event: DiffEvent
  ): Promise<void> {
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

      keyboard = new InlineKeyboard()
        .url(
          translate(lang, "alerts.btn_claim_slot"),
          `https://cheapestinference.com/pools/${event.poolSlug}`
        );
    } else if (event.type === "SLOT_DISAPPEARED") {
      const header = translate(lang, "alerts.slot_disappeared_header");
      const body = translate(lang, "alerts.slot_disappeared_body", {
        pool_name: event.poolName,
        block_name: blockName,
        timestamp: timeFormatted,
      });
      text = `${header}\n\n${body}`;
    } else if (event.type === "PRICE_CHANGED") {
      const header = translate(lang, "alerts.price_changed_header");
      const body = translate(lang, "alerts.price_changed_body", {
        pool_name: event.poolName,
        block_name: blockName,
        old_price: event.previousPrice || "0",
        new_price: event.newPrice || "0",
        timestamp: timeFormatted,
      });
      text = `${header}\n\n${body}`;
      keyboard = new InlineKeyboard().url(
        translate(lang, "alerts.btn_claim_slot"),
        `https://cheapestinference.com/pools/${event.poolSlug}`
      );
    } else if (event.type === "CATALOG_UPDATED" || event.type === "NEW_POOL_EVENT") {
      const header = translate(lang, "alerts.catalog_updated_header");
      const body = translate(lang, "alerts.catalog_updated_body", {
        pool_name: event.poolName,
        models: (event.models || []).join(", "),
      });
      text = `${header}\n\n${body}\n💰 <b>Price:</b> from $${event.newPrice}/mo`;
      keyboard = new InlineKeyboard().url(
        translate(lang, "alerts.btn_claim_slot"),
        `https://cheapestinference.com/pools/${event.poolSlug}`
      );
    }

    try {
      await this.enqueueGlobalSend(async () => {
        await this.bot.api.sendMessage(telegramId, text, {
          parse_mode: "HTML",
          reply_markup: keyboard,
          disable_notification: isMuted,
          link_preview_options: { is_disabled: true },
        });
      });

      this.logDao.logNotification(
        userId,
        event.poolSlug,
        event.block,
        event.type
      );
      this.lastUserSendTime.set(telegramId, Date.now());
    } catch (err: any) {
      if (err?.error_code === 403) {
        console.warn(`[Dispatcher] User ${telegramId} blocked the bot. Deactivating subscription.`);
        this.userDao.deactivateUser(telegramId);
      } else {
        console.error(`[Dispatcher] Failed to send single alert to ${telegramId}:`, err);
      }
    }
  }

  private async sendBatchAlert(
    userId: number,
    telegramId: number,
    lang: SupportedLanguage,
    isMuted: boolean,
    events: DiffEvent[]
  ): Promise<void> {
    const title = translate(lang, "alerts.batch_title", { count: events.length });
    const items: string[] = [];

    for (const e of events) {
      const blockName = translate(lang, `common.block_${e.block}`) || e.block;
      if (e.type === "SLOT_APPEARED") {
        items.push(
          `🟢 <b>${e.poolName}</b> (${blockName}) — ${translate(lang, "common.status_available")}`
        );
      } else if (e.type === "SLOT_DISAPPEARED") {
        items.push(
          `🔴 <b>${e.poolName}</b> (${blockName}) — ${translate(lang, "common.status_sold_out")}`
        );
      } else if (e.type === "PRICE_CHANGED") {
        items.push(
          `💵 <b>${e.poolName}</b> (${blockName}) — $${e.previousPrice} ➡️ <b>$${e.newPrice}</b>`
        );
      } else {
        items.push(`📦 <b>${e.poolName}</b> — ${translate(lang, "alerts.catalog_updated_header")}`);
      }
    }

    const text = `${title}\n\n${items.join("\n")}`;
    const keyboard = new InlineKeyboard().url(
      translate(lang, "common.open_site"),
      "https://cheapestinference.com/pools"
    );

    try {
      await this.enqueueGlobalSend(async () => {
        await this.bot.api.sendMessage(telegramId, text, {
          parse_mode: "HTML",
          reply_markup: keyboard,
          disable_notification: isMuted,
          link_preview_options: { is_disabled: true },
        });
      });

      for (const e of events) {
        this.logDao.logNotification(
          userId,
          e.poolSlug,
          e.block,
          e.type
        );
      }
      this.lastUserSendTime.set(telegramId, Date.now());
    } catch (err: any) {
      if (err?.error_code === 403) {
        this.userDao.deactivateUser(telegramId);
      } else {
        console.error(`[Dispatcher] Failed to send batch alert to ${telegramId}:`, err);
      }
    }
  }

  /**
   * Centralized FIFO rate limiter enforcing global max 25 msg/s (40ms token spacing)
   */
  private enqueueGlobalSend(sendFn: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.globalSendQueue.push(async () => {
        try {
          await sendFn();
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      this.processGlobalQueue();
    });
  }

  private async processGlobalQueue(): Promise<void> {
    if (this.isProcessingGlobalQueue) return;
    this.isProcessingGlobalQueue = true;

    while (this.globalSendQueue.length > 0) {
      const task = this.globalSendQueue.shift();
      if (task) {
        try {
          await task();
        } catch {}
        // Enforce 25 msg/sec global limit (40ms spacing)
        await new Promise((r) => setTimeout(r, 40));
      }
    }

    this.isProcessingGlobalQueue = false;
  }
}
