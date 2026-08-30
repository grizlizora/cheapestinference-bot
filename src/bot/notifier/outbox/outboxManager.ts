/**
 * src/bot/notifier/outbox/outboxManager.ts
 * SQLite Notification Outbox Persistence, Hydration & Batch Operations
 */

import { InlineKeyboard } from "grammy";
import { NotificationOutboxDAO } from "../../../db/dao/notificationOutbox.js";
import { NotificationLogDAO } from "../../../db/dao/notificationLogs.js";
import { UserDAO } from "../../../db/dao/users.js";
import { OutgoingAlertMessage, BroadcastPriority } from "../types.js";
import { DwrrScheduler } from "../queue/dwrrScheduler.js";
import { SubscriberInvertedIndex } from "../subscriberIndex.js";

export class OutboxManager {
  private readonly MAX_MESSAGE_AGE_MS = 10 * 60 * 1000; // 10 min TTL
  private blockedUsersBatch: number[] = [];
  private batchFlushTimer?: NodeJS.Timeout;

  constructor(
    private userDao: UserDAO,
    private logDao: NotificationLogDAO,
    private outboxDao?: NotificationOutboxDAO,
    private index?: SubscriberInvertedIndex
  ) {
    this.batchFlushTimer = setInterval(() => this.flushBlockedUsersToDb(), 5000);
    this.batchFlushTimer.unref?.();
  }

  public setIndex(index: SubscriberInvertedIndex): void {
    this.index = index;
  }

  public recordOutboxInsert(msg: OutgoingAlertMessage): void {
    if (!this.outboxDao) return;
    try {
      this.outboxDao.enqueue({
        id: msg.id,
        userId: msg.userId,
        telegramId: msg.telegramId,
        priority: msg.priority,
        messageText: msg.text,
        replyMarkupJson: msg.keyboard ? JSON.stringify(msg.keyboard.inline_keyboard) : undefined,
        disableNotification: msg.isMuted,
        eventType: msg.eventType,
        poolSlug: msg.poolSlug,
        blockId: msg.blockId,
        mediaType: msg.mediaType,
        fileId: msg.fileId,
        isBroadcast: msg.eventType === "ADMIN_BROADCAST",
        language: (msg as any).language,
        status: "pending",
        attempts: 0,
      });
    } catch (e: any) {
      console.warn("⚠️ [OutboxManager] Non-fatal outbox insert failure:", e.message);
    }
  }

  public recordOutboxInsertBatch(messages: OutgoingAlertMessage[]): void {
    if (!this.outboxDao || messages.length === 0) return;
    try {
      this.outboxDao.enqueueBatch(
        messages.map((msg) => ({
          id: msg.id,
          userId: msg.userId,
          telegramId: msg.telegramId,
          priority: msg.priority,
          messageText: msg.text,
          replyMarkupJson: msg.keyboard ? JSON.stringify(msg.keyboard.inline_keyboard) : undefined,
          disableNotification: msg.isMuted,
          eventType: msg.eventType,
          poolSlug: msg.poolSlug,
          blockId: msg.blockId,
          mediaType: msg.mediaType,
          fileId: msg.fileId,
          isBroadcast: msg.eventType === "ADMIN_BROADCAST",
          language: (msg as any).language,
          status: "pending",
          attempts: 0,
        }))
      );
    } catch (e: any) {
      console.warn("⚠️ [OutboxManager] Non-fatal outbox batch insert failure:", e.message);
    }
  }

  public markDispatched(msgId: string): void {
    try {
      this.outboxDao?.markDispatched(msgId);
    } catch {}
  }

  public markFailed(msgId: string, error: string): void {
    try {
      this.outboxDao?.markFailed(msgId, error);
    } catch {}
  }

  public markTerminalFailed(msgId: string, error: string): void {
    try {
      this.outboxDao?.markTerminalFailed(msgId, error);
    } catch {}
  }

  public handleUserBlocked(telegramId: number, msgId?: string): void {
    this.index?.markUserDeactivated(telegramId);
    this.blockedUsersBatch.push(telegramId);
    if (msgId) {
      this.markTerminalFailed(msgId, "User deactivated or blocked");
    }
  }

  public flushBlockedUsersToDb(): void {
    if (this.blockedUsersBatch.length === 0) return;
    const uniqueIds = Array.from(new Set(this.blockedUsersBatch));

    try {
      this.userDao.deactivateUsersBatch(uniqueIds);
      this.blockedUsersBatch = [];
      console.log(`🧹 [OutboxManager] Deactivated ${uniqueIds.length} unique blocked users in DB transaction.`);
    } catch (e: any) {
      console.error("[OutboxManager] Error persisting blocked users to DB:", e.message);
    }
  }

  public hydratePendingFromOutbox(scheduler: DwrrScheduler): void {
    if (!this.outboxDao) return;
    try {
      const pendingItems = this.outboxDao.getPending(10000);
      if (pendingItems.length === 0) return;
      console.log(`📦 [OutboxManager] Hydrated ${pendingItems.length} pending alerts from SQLite outbox.`);

      const now = Date.now();
      for (const item of pendingItems as any[]) {
        const rawCreatedAt = item.createdAt ?? item.created_at;
        const itemCreatedMs = rawCreatedAt
          ? (Date.parse(String(rawCreatedAt).replace(" ", "T") + "Z") || Date.parse(String(rawCreatedAt)) || now)
          : now;

        if (now - itemCreatedMs > this.MAX_MESSAGE_AGE_MS) {
          this.outboxDao.markTerminalFailed(item.id, "Expired TTL on startup hydration");
          continue;
        }

        const replyJson = item.replyMarkupJson ?? item.reply_markup_json;
        let keyboard: InlineKeyboard | undefined;
        if (replyJson) {
          try {
            const parsed = JSON.parse(replyJson);
            keyboard = new InlineKeyboard(parsed.inline_keyboard || parsed);
          } catch {}
        }

        const msg: OutgoingAlertMessage = {
          id: item.id,
          telegramId: Number(item.telegramId ?? item.telegram_id),
          userId: Number(item.userId ?? item.user_id),
          poolSlug: item.poolSlug ?? item.pool_slug ?? "unknown",
          blockId: item.blockId ?? item.block_id ?? "ALL",
          eventType: item.eventType ?? item.event_type ?? "NOTIFICATION",
          text: item.messageText ?? item.message_text ?? "",
          keyboard,
          isMuted: (item.disableNotification ?? item.disable_notification) === 1,
          priority: (item.priority as BroadcastPriority) || "P1",
          retries: Number(item.attempts || 0),
          enqueuedAt: itemCreatedMs,
          language: (item.language as any) || "en",
          mediaType: (item.mediaType ?? item.media_type) as any,
          fileId: item.fileId ?? item.file_id,
        };

        scheduler.enqueue(msg);
      }
    } catch (err: any) {
      console.error("❌ [OutboxManager] Failed to hydrate pending alerts from outbox:", err?.message || err);
    }
  }

  public recordDeliveryLog(msg: OutgoingAlertMessage, latencyMs: number): void {
    try {
      this.logDao.logNotification(msg.userId, msg.poolSlug, msg.blockId, msg.eventType);
    } catch (e: any) {
      console.warn("⚠️ [OutboxManager] Non-fatal log persistence failure:", e.message);
    }
  }

  public stop(): void {
    if (this.batchFlushTimer) {
      clearInterval(this.batchFlushTimer);
      this.batchFlushTimer = undefined;
    }
  }
}
