import Database from "better-sqlite3";
import { NotificationLogRecord } from "../../types/db.js";

export class NotificationLogDAO {
  private stmtInsert: Database.Statement;
  private stmtCountRecent: Database.Statement;

  constructor(private db: Database.Database) {
    this.stmtInsert = db.prepare(`
      INSERT INTO notification_logs (user_id, pool_slug, block_id, event_type)
      VALUES (?, ?, ?, ?)
    `);

    this.stmtCountRecent = db.prepare(`
      SELECT COUNT(*) as count FROM notification_logs
      WHERE sent_at >= datetime('now', '-1 hour')
    `);
  }

  logNotification(userId: number, poolSlug: string, blockId: string, eventType: string): void {
    this.stmtInsert.run(userId, poolSlug, blockId, eventType);
  }

  getRecentHourCount(): number {
    const row = this.stmtCountRecent.get() as any;
    return Number(row?.count || 0);
  }
}
