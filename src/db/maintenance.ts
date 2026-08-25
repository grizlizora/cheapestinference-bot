import Database from "better-sqlite3";

export class DatabaseMaintenanceManager {
  private stmtPruneLogsBatch: Database.Statement;
  private stmtPruneSlotHistoryBatch: Database.Statement;
  private stmtCountOldLogs: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.stmtCountOldLogs = db.prepare(`
      SELECT COUNT(*) as count FROM notification_logs 
      WHERE sent_at < datetime('now', '-30 days')
    `);

    this.stmtPruneLogsBatch = db.prepare(`
      DELETE FROM notification_logs 
      WHERE id IN (
        SELECT id FROM notification_logs 
        WHERE sent_at < datetime('now', '-30 days') 
        LIMIT 2000
      )
    `);

    this.stmtPruneSlotHistoryBatch = db.prepare(`
      DELETE FROM slot_lifecycle_history 
      WHERE id IN (
        SELECT id FROM slot_lifecycle_history 
        WHERE closed_at IS NOT NULL AND closed_at < datetime('now', '-90 days') 
        LIMIT 2000
      )
    `);
  }

  /**
   * Non-blocking chunked rolling purge of logs and slot history older than retention window
   */
  public pruneOldLogs(): { deletedCount: number; durationMs: number } {
    const start = Date.now();
    let totalDeleted = 0;

    // 1. Purge notification logs
    while (true) {
      const result = this.stmtPruneLogsBatch.run();
      totalDeleted += result.changes;
      if (result.changes < 2000) break;
    }

    // 2. Purge stale closed slot lifecycle history (>90 days)
    try {
      const histResult = this.stmtPruneSlotHistoryBatch.run();
      totalDeleted += histResult.changes;
    } catch {}

    // 3. Reclaim freed pages back to OS
    try {
      this.db.pragma("incremental_vacuum(500)");
    } catch {}

    // 4. Truncate WAL file back to 0 bytes
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
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
          console.log(`🧹 [DB Maintenance] Pruned ${res.deletedCount} records & compacted DB in ${res.durationMs}ms`);
        }
      } catch (err: any) {
        console.error("⚠️ [DB Maintenance] Failed to prune old logs:", err.message);
      }
    }, cronIntervalMs);

    timer.unref();
    return timer;
  }
}
