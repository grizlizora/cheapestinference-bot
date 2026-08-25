import Database from "better-sqlite3";
import { NotificationLogRecord } from "../../types/db.js";

interface PendingLogItem {
  userId: number;
  poolSlug: string;
  blockId: string;
  eventType: string;
}

export class NotificationLogDAO {
  private stmtInsert: Database.Statement;
  private stmtCountRecent: Database.Statement;
  private txBatchInsert: (logs: PendingLogItem[]) => void;
  private logBuffer: PendingLogItem[] = [];
  private flushTimer?: NodeJS.Timeout;

  constructor(private db: Database.Database) {
    this.stmtInsert = db.prepare(`
      INSERT INTO notification_logs (user_id, pool_slug, block_id, event_type)
      VALUES (?, ?, ?, ?)
    `);

    this.stmtCountRecent = db.prepare(`
      SELECT COUNT(*) as count FROM notification_logs
      WHERE sent_at >= datetime('now', '-1 hour')
    `);

    this.txBatchInsert = this.db.transaction((logs: PendingLogItem[]) => {
      for (const log of logs) {
        this.stmtInsert.run(log.userId, log.poolSlug, log.blockId, log.eventType);
      }
    });

    // Debounced automatic flush every 2 seconds
    this.flushTimer = setInterval(() => this.flush(), 2000);
    this.flushTimer.unref();
  }

  public logNotification(userId: number, poolSlug: string, blockId: string, eventType: string): void {
    this.logBuffer.push({ userId, poolSlug, blockId, eventType });
    if (this.logBuffer.length >= 100) {
      this.flush();
    }
  }

  public flush(): void {
    if (this.logBuffer.length === 0) return;
    if (!this.db.open) return;
    const batch = this.logBuffer;
    this.logBuffer = [];

    try {
      this.txBatchInsert(batch);
    } catch (err: any) {
      console.error("⚠️ [NotificationLogDAO] Batch log flush failed:", err.message);
    }
  }

  public close(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flush();
  }

  public getRecentHourCount(): number {
    this.flush();
    const row = this.stmtCountRecent.get() as any;
    return Number(row?.count || 0);
  }
}

