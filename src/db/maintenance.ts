import Database from "better-sqlite3";

export class DatabaseMaintenanceManager {
  private stmtPruneBatch: Database.Statement;
  private stmtCountOldLogs: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.stmtCountOldLogs = db.prepare(`
      SELECT COUNT(*) as count FROM notification_logs 
      WHERE sent_at < datetime('now', '-30 days')
    `);

    this.stmtPruneBatch = db.prepare(`
      DELETE FROM notification_logs 
      WHERE id IN (
        SELECT id FROM notification_logs 
        WHERE sent_at < datetime('now', '-30 days') 
        LIMIT 5000
      )
    `);
  }

  /**
   * Non-blocking chunked rolling purge of logs older than 30 days
   */
  public pruneOldLogs(): { deletedCount: number; durationMs: number } {
    const start = Date.now();
    let totalDeleted = 0;

    const initialOld = (this.stmtCountOldLogs.get() as any)?.count || 0;
    if (initialOld === 0) {
      return { deletedCount: 0, durationMs: Date.now() - start };
    }

    while (true) {
      const result = this.stmtPruneBatch.run();
      totalDeleted += result.changes;
      if (result.changes < 5000) break;
    }

    try {
      this.db.pragma("incremental_vacuum(500)");
    } catch {}

    return {
      deletedCount: totalDeleted,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Start daily automated maintenance timer (24h)
   */
  public startDailyMaintenance(cronIntervalMs = 24 * 60 * 60 * 1000): NodeJS.Timeout {
    const timer = setInterval(() => {
      try {
        const res = this.pruneOldLogs();
        if (res.deletedCount > 0) {
          console.log(`🧹 [DB Maintenance] Pruned ${res.deletedCount} old logs in ${res.durationMs}ms`);
        }
      } catch (err: any) {
        console.error("⚠️ [DB Maintenance] Failed to prune old logs:", err.message);
      }
    }, cronIntervalMs);

    timer.unref();
    return timer;
  }
}
