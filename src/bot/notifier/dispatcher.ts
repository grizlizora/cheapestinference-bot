import { Bot, InlineKeyboard } from "grammy";
import PQueue from "p-queue";
import { BotContext } from "../../types/context.js";
import { DiffEvent } from "../../types/domain.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { UserDAO } from "../../db/dao/users.js";
import { NotificationLogDAO } from "../../db/dao/notificationLogs.js";
import { translate, SupportedLanguage } from "../../i18n/index.js";

export class NotificationDispatcher {
  // Global queue constrained to 25 msg/s (under Telegram's 30 msg/s ceiling)
  private queue = new PQueue({
    concurrency: 25,
    intervalCap: 25,
    interval: 1000,
  });

  private lastUserSendTime = new Map<number, number>();
  private pendingUserEvents = new Map<number, DiffEvent[]>();
  private batchTimers = new Map<number, NodeJS.Timeout>();
  private lastPruneTime = Date.now();

  constructor(
    private readonly bot: Bot<BotContext>,
    private readonly subDao: SubscriptionDAO,
    private readonly userDao: UserDAO,
    private readonly logDao: NotificationLogDAO
  ) {}

  public handleDiffEvents(events: DiffEvent[]): void {
    this.pruneSendTimesIfNeeded();

    for (const event of events) {
      if (
        event.type === "SLOT_APPEARED" ||
        event.type === "SLOT_DISAPPEARED" ||
        event.type === "PRICE_CHANGED"
      ) {
        // For price changes, notify users interested in available slots
        const eventType = event.type === "SLOT_DISAPPEARED" ? "sold_out" : "available";
        const subscribers = this.subDao.findSubscribersForSlot(
          event.poolSlug,
          event.block,
          eventType
        );

        for (const sub of subscribers) {
          this.enqueueUserEvent(sub.telegram_id, event);
        }
      }
    }
  }

  private pruneSendTimesIfNeeded(): void {
    const now = Date.now();
    if (now - this.lastPruneTime > 300_000) {
      // Prune every 5 minutes
      this.lastPruneTime = now;
      for (const [tgId, time] of this.lastUserSendTime.entries()) {
        if (now - time > 3600_000) {
          this.lastUserSendTime.delete(tgId);
        }
      }
    }
  }

  private enqueueUserEvent(telegramId: number, event: DiffEvent): void {
    const list = this.pendingUserEvents.get(telegramId) || [];
    list.push(event);
    this.pendingUserEvents.set(telegramId, list);

    if (this.batchTimers.has(telegramId)) {
      return; // Batch window already ticking
    }

    const timer = setTimeout(() => {
      this.batchTimers.delete(telegramId);
      const eventsToFlush = this.pendingUserEvents.get(telegramId) || [];
      this.pendingUserEvents.delete(telegramId);

      if (eventsToFlush.length > 0) {
        this.queue.add(() => this.dispatchForUser(telegramId, eventsToFlush));
      }
    }, 2500); // 2.5s aggregation window

    this.batchTimers.set(telegramId, timer);
  }

  private async dispatchForUser(telegramId: number, events: DiffEvent[]): Promise<void> {
    const user = this.userDao.getByTelegramId(telegramId);
    if (!user || user.is_active === 0) return;

    const lang: SupportedLanguage = user.language || "uk";

    // Throttle 1 message per 1.5s per chat
    const now = Date.now();
    const lastSent = this.lastUserSendTime.get(telegramId) || 0;
    if (now - lastSent < 1500) {
      await new Promise((res) => setTimeout(res, 1500 - (now - lastSent)));
    }

    if (events.length === 1) {
      await this.sendSingleAlert(user.id, telegramId, lang, user.is_muted === 1, events[0]);
    } else {
      // Chunk batches into max 12 events per message to stay strictly under 4096 chars
      for (let i = 0; i < events.length; i += 12) {
        const chunk = events.slice(i, i + 12);
        await this.sendBatchAlert(user.id, telegramId, lang, user.is_muted === 1, chunk);
      }
    }

    this.lastUserSendTime.set(telegramId, Date.now());
  }

  public async sendSingleAlert(
    userId: number,
    telegramId: number,
    lang: SupportedLanguage,
    isMuted: boolean,
    event: DiffEvent
  ): Promise<void> {
    const blockName = translate(lang, `common.block_${event.block}`) || event.block;
    const timeStr = new Date(event.timestamp).toISOString().replace("T", " ").substring(0, 19);

    let text = "";
    const keyboard = new InlineKeyboard();

    if (event.type === "SLOT_APPEARED") {
      const header = translate(lang, "alerts.slot_appeared_header");
      const body = translate(lang, "alerts.slot_appeared_body", {
        pool_name: event.poolName,
        block_name: blockName,
        hours_utc: event.hoursUtc,
        models: event.models.join(", "),
        price: event.newPrice,
        timestamp: timeStr,
      });
      text = `${header}\n\n${body}`;

      keyboard
        .url(
          translate(lang, "alerts.btn_claim_slot"),
          `https://cheapestinference.com/pools/${event.poolSlug}#${event.block}`
        )
        .row();
    } else if (event.type === "SLOT_DISAPPEARED") {
      const header = translate(lang, "alerts.slot_disappeared_header");
      const body = translate(lang, "alerts.slot_disappeared_body", {
        pool_name: event.poolName,
        block_name: blockName,
        timestamp: timeStr,
      });
      text = `${header}\n\n${body}`;
    } else if (event.type === "PRICE_CHANGED") {
      const header = translate(lang, "alerts.price_changed_header");
      const body = translate(lang, "alerts.price_changed_body", {
        pool_name: event.poolName,
        block_name: blockName,
        old_price: event.previousPrice || "N/A",
        new_price: event.newPrice,
        timestamp: timeStr,
      });
      text = `${header}\n\n${body}`;

      keyboard
        .url(
          translate(lang, "alerts.btn_claim_slot"),
          `https://cheapestinference.com/pools/${event.poolSlug}#${event.block}`
        )
        .row();
    }

    try {
      await this.bot.api.sendMessage(telegramId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
        disable_notification: isMuted,
      });

      this.logDao.logNotification(userId, event.poolSlug, event.block, event.type);
    } catch (err: any) {
      this.handleTelegramError(err, telegramId);
    }
  }

  private async sendBatchAlert(
    userId: number,
    telegramId: number,
    lang: SupportedLanguage,
    isMuted: boolean,
    events: DiffEvent[]
  ): Promise<void> {
    const timeStr = new Date().toISOString().replace("T", " ").substring(0, 19);
    let text = translate(lang, "alerts.batch_title", { count: events.length }) + "\n\n";

    for (const ev of events) {
      const blockName = translate(lang, `common.block_${ev.block}`) || ev.block;
      const icon = ev.type === "SLOT_APPEARED" ? "🟢" : ev.type === "PRICE_CHANGED" ? "🏷️" : "🔴";
      const statusText =
        ev.type === "SLOT_APPEARED"
          ? translate(lang, "common.status_available")
          : ev.type === "PRICE_CHANGED"
          ? translate(lang, "alerts.batch_price_update")
          : translate(lang, "common.status_sold_out");

      text += `${icon} <b>${ev.poolName}</b> (${blockName})\n`;
      text += `└ ${statusText} | 💵 <b>$${ev.newPrice}/mo</b>\n\n`;
    }

    text += `⏱ <i>${timeStr} UTC</i>`;

    const keyboard = new InlineKeyboard().url(
      translate(lang, "alerts.btn_claim_slot"),
      "https://cheapestinference.com/pools"
    );

    try {
      await this.bot.api.sendMessage(telegramId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
        disable_notification: isMuted,
      });

      for (const ev of events) {
        this.logDao.logNotification(userId, ev.poolSlug, ev.block, ev.type);
      }
    } catch (err: any) {
      this.handleTelegramError(err, telegramId);
    }
  }

  private handleTelegramError(err: any, telegramId: number): void {
    const code = err?.error_code || err?.response?.statusCode;
    const desc = err?.description || err?.message || "";

    if (code === 403 || desc.includes("bot was blocked by the user")) {
      console.warn(`[Dispatcher] User ${telegramId} blocked bot. Deactivating user.`);
      this.userDao.deactivateUser(telegramId);
    } else if (code === 429) {
      const retryAfter = err?.parameters?.retry_after || 5;
      console.warn(`[Dispatcher] Telegram 429 hit. Pausing queue for ${retryAfter}s.`);
      this.queue.pause();
      setTimeout(() => this.queue.start(), (retryAfter + 1) * 1000);
    } else {
      console.error(`[Dispatcher] Error sending to ${telegramId}:`, desc);
    }
  }
}
