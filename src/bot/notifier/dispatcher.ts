import { Bot, InlineKeyboard } from "grammy";
import { BotContext } from "../../types/context.js";
import { DiffEvent } from "../../types/domain.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { UserDAO } from "../../db/dao/users.js";
import { NotificationLogDAO } from "../../db/dao/notificationLogs.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { translate, SupportedLanguage } from "../../i18n/index.js";

export class NotificationDispatcher {
  private pendingUserEvents = new Map<number, DiffEvent[]>();
  private batchTimers = new Map<number, NodeJS.Timeout>();
  private lastUserSendTime = new Map<number, number>();

  constructor(
    private bot: Bot<BotContext>,
    private subDao: SubscriptionDAO,
    private userDao: UserDAO,
    private logDao: NotificationLogDAO,
    private historyDao?: SlotHistoryDAO
  ) {
    // Periodically prune stale send times every 15 minutes to prevent unbounded memory growth
    setInterval(() => {
      const cutoff = Date.now() - 3600_000;
      for (const [id, time] of this.lastUserSendTime.entries()) {
        if (time < cutoff) {
          this.lastUserSendTime.delete(id);
        }
      }
    }, 900_000).unref();
  }

  public handleDiffEvents(events: DiffEvent[]): void {
    for (const event of events) {
      this.dispatchSingleDiffEvent(event);
    }
  }

  private dispatchSingleDiffEvent(event: DiffEvent): void {
    const eventType =
      event.type === "SLOT_DISAPPEARED" ? "sold_out" : "available";

    const matches = this.subDao.findSubscribersForSlot(
      event.poolSlug,
      event.block,
      eventType
    );

    if (matches.length === 0) return;

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
      const userEvents = this.pendingUserEvents.get(telegramId) || [];
      this.pendingUserEvents.delete(telegramId);

      if (userEvents.length > 0) {
        await this.flushUserEvents(telegramId, userEvents);
      }
    }, 2500);

    this.batchTimers.set(telegramId, timer);
  }

  private async flushUserEvents(
    telegramId: number,
    events: DiffEvent[]
  ): Promise<void> {
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

      if (this.historyDao) {
        const analytics = this.historyDao.getSlotAnalytics(event.poolSlug, event.block);
        if (analytics.avgDurationFormatted) {
          text += `\n\n📊 <i>Статистика бота: зазвичай цей слот залишається вільним ${analytics.avgDurationFormatted}!</i>`;
        }
      }

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
    } else if (event.type === "CATALOG_UPDATED" || event.type === "NEW_POOL_EVENT") {
      text = `📦 <b>CheapestInference Catalog Update</b>\n\nPool: <b>${event.poolName}</b>\nModels: <code>${event.models.join(", ")}</code>\nPrice: from <b>$${event.newPrice}/mo</b>`;
      keyboard
        .url(
          translate(lang, "alerts.btn_claim_slot"),
          `https://cheapestinference.com/pools/${event.poolSlug}`
        )
        .row();
    }

    try {
      await this.bot.api.sendMessage(telegramId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
        disable_notification: isMuted,
        link_preview_options: { is_disabled: true },
      });

      this.logDao.logNotification(
        userId,
        event.poolSlug,
        event.block,
        event.type
      );
    } catch (err: any) {
      console.error(`Failed to send alert to user ${telegramId}:`, err?.message);

      if (err?.error_code === 403) {
        this.userDao.deactivateUser(telegramId);
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

    const lines = events.map((e) => {
      const blockName = translate(lang, `common.block_${e.block}`) || e.block;
      let badge = "🔄";
      if (e.type === "SLOT_APPEARED") badge = "🟢";
      else if (e.type === "SLOT_DISAPPEARED") badge = "🔴";
      else if (e.type === "PRICE_CHANGED") badge = "💰";

      return `${badge} <b>${e.poolName}</b> (${blockName}) -> <code>${e.type}</code> ($${e.newPrice}/mo)`;
    });

    const text = `${title}\n\n${lines.join("\n")}`;

    const keyboard = new InlineKeyboard().url(
      translate(lang, "common.open_site"),
      "https://cheapestinference.com/pools"
    );

    try {
      await this.bot.api.sendMessage(telegramId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
        disable_notification: isMuted,
        link_preview_options: { is_disabled: true },
      });

      for (const e of events) {
        this.logDao.logNotification(
          userId,
          e.poolSlug,
          e.block,
          e.type
        );
      }
    } catch (err: any) {
      console.error(`Failed to send batch alert to user ${telegramId}:`, err?.message);
      if (err?.error_code === 403) {
        this.userDao.deactivateUser(telegramId);
      }
    }
  }
}
