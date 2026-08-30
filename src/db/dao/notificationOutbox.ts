import Database from "better-sqlite3";
import { BroadcastPriority } from "../../bot/notifier/alertFormatter.js";

export interface OutboxItem {
  id: string;
  userId: number;
  telegramId: number;
  priority: BroadcastPriority;
  messageText: string;
  replyMarkupJson?: string;
  disableNotification: boolean;
  eventType: string;
  poolSlug?: string;
  blockId?: string;
  isBroadcast?: boolean;
  language?: string;
  status: "pending" | "dispatched" | "failed";
  attempts: number;
  lastError?: string;
  createdAt?: string;
  dispatchedAt?: string;
}

export class NotificationOutboxDAO {
  private stmtEnqueue: Database.Statement;
  private stmtGetPending: Database.Statement;
  private stmtMarkDispatched: Database.Statement;
  private stmtMarkFailed: Database.Statement;
  private stmtMarkTerminalFailed: Database.Statement;
  private stmtPruneOld: Database.Statement;
  private txEnqueueBatch: (items: OutboxItem[]) => void;

  constructor(public readonly db: Database.Database) {
    this.stmtEnqueue = db.prepare(`
      INSERT OR IGNORE INTO notification_outbox (
        id, user_id, telegram_id, priority, message_text, reply_markup_json,
        disable_notification, event_type, pool_slug, block_id, is_broadcast, language, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `);

    this.stmtGetPending = db.prepare(`
      SELECT 
        id, user_id as userId, telegram_id as telegramId, priority, message_text as messageText,
        reply_markup_json as replyMarkupJson, disable_notification as disableNotification,
        event_type as eventType, pool_slug as poolSlug, block_id as blockId,
        is_broadcast as isBroadcast, language, status, attempts,
        created_at as createdAt
      FROM notification_outbox
      WHERE status = 'pending'
      ORDER BY priority ASC, created_at ASC
      LIMIT ?
    `);

    this.stmtMarkDispatched = db.prepare(`
      UPDATE notification_outbox 
      SET status = 'dispatched', dispatched_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    this.stmtMarkFailed = db.prepare(`
      UPDATE notification_outbox 
      SET attempts = attempts + 1, last_error = ?, status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END
      WHERE id = ?
    `);

    this.stmtMarkTerminalFailed = db.prepare(`
      UPDATE notification_outbox 
      SET attempts = attempts + 1, last_error = ?, status = 'failed'
      WHERE id = ?
    `);

    this.stmtPruneOld = db.prepare(`
      DELETE FROM notification_outbox 
      WHERE (status = 'dispatched' AND dispatched_at < datetime('now', '-1 day'))
         OR (status = 'failed' AND created_at < datetime('now', '-3 days'))
         OR (status = 'pending' AND created_at < datetime('now', '-6 hours'))
    `);

    this.txEnqueueBatch = db.transaction((items: OutboxItem[]) => {
      for (const item of items) {
        this.stmtEnqueue.run(
          item.id,
          item.userId,
          item.telegramId,
          item.priority,
          item.messageText,
          item.replyMarkupJson || null,
          item.disableNotification ? 1 : 0,
          item.eventType,
          item.poolSlug || null,
          item.blockId || null,
          item.isBroadcast ? 1 : 0,
          item.language || "en"
        );
      }
    });
  }

  public enqueueBatch(items: OutboxItem[]): void {
    if (items.length === 0) return;
    this.txEnqueueBatch(items);
  }

  public enqueue(item: OutboxItem): void {
    this.stmtEnqueue.run(
      item.id,
      item.userId,
      item.telegramId,
      item.priority,
      item.messageText,
      item.replyMarkupJson || null,
      item.disableNotification ? 1 : 0,
      item.eventType,
      item.poolSlug || null,
      item.blockId || null,
      item.isBroadcast ? 1 : 0,
      item.language || "en"
    );
  }

  public getPending(limit = 200): OutboxItem[] {
    const rows = this.stmtGetPending.all(limit) as any[];
    return rows.map((r) => ({
      ...r,
      disableNotification: r.disableNotification === 1,
      isBroadcast: r.isBroadcast === 1,
    }));
  }

  public markDispatched(id: string): void {
    this.stmtMarkDispatched.run(id);
  }

  public markFailed(id: string, errorMsg: string): void {
    this.stmtMarkFailed.run(errorMsg, id);
  }

  public markTerminalFailed(id: string, errorMsg: string): void {
    this.stmtMarkTerminalFailed.run(errorMsg, id);
  }

  public pruneOld(): number {
    const res = this.stmtPruneOld.run();
    return res.changes;
  }
}
