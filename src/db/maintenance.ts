import Database from "better-sqlite3";

export class DatabaseMaintenanceManager {
  private stmtPruneLogsBatch: Database.Statement;
  private stmtPruneSlotHistoryBatch: Database.Statement;
  private stmtPruneCatalogHistoryBatch: Database.Statement;
  private stmtPruneSlotPriceHistoryBatch: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    private readonly retentionDays = 30
  ) {
    this.stmtPruneLogsBatch = db.prepare(`
      DELETE FROM notification_logs 
      WHERE id IN (
        SELECT id FROM notification_logs 
        WHERE sent_at < datetime('now', '-' || ? || ' days')
        ORDER BY id ASC
        LIMIT 2000
      )
    `);

    this.stmtPruneSlotHistoryBatch = db.prepare(`
      DELETE FROM slot_lifecycle_history 
      WHERE id IN (
        SELECT id FROM slot_lifecycle_history 
        WHERE closed_at IS NOT NULL 
          AND closed_at < datetime('now', '-90 days')
        ORDER BY id ASC
        LIMIT 2000
      )
    `);

    this.stmtPruneCatalogHistoryBatch = db.prepare(`
      DELETE FROM catalog_history 
      WHERE id IN (
        SELECT id FROM catalog_history 
        WHERE detected_at < datetime('now', '-90 days')
        ORDER BY id ASC
        LIMIT 2000
      )
    `);

    this.stmtPruneSlotPriceHistoryBatch = db.prepare(`
      DELETE FROM slot_price_history 
      WHERE id IN (
        SELECT id FROM slot_price_history 
        WHERE changed_at < datetime('now', '-90 days')
        ORDER BY id ASC
        LIMIT 2000
      )
    `);
  }

  /**
   * Non-blocking chunked rolling purge of logs and historical data
   */
  public pruneOldLogs(): { deletedCount: number; durationMs: number } {
    const start = Date.now();
    let totalDeleted = 0;

    // 1. Purge notification logs in chunks of 2,000
    try {
      while (true) {
        const result = this.stmtPruneLogsBatch.run(this.retentionDays);
        totalDeleted += result.changes;
        if (result.changes < 2000) break;
      }
    } catch {}

    // 2. Purge stale closed slot lifecycle history (>90 days)
    try {
      while (true) {
        const histResult = this.stmtPruneSlotHistoryBatch.run();
        totalDeleted += histResult.changes;
        if (histResult.changes < 2000) break;
      }
    } catch {}

    // 3. Purge catalog upgrades (>90 days)
    try {
      while (true) {
        const catResult = this.stmtPruneCatalogHistoryBatch.run();
        totalDeleted += catResult.changes;
        if (catResult.changes < 2000) break;
      }
    } catch {}

    // 4. Purge slot price history (>90 days)
    try {
      while (true) {
        const priceResult = this.stmtPruneSlotPriceHistoryBatch.run();
        totalDeleted += priceResult.changes;
        if (priceResult.changes < 2000) break;
      }
    } catch {}

    // 5. Reclaim freed pages back to OS
    try {
      this.db.pragma("incremental_vacuum(1000)");
    } catch {}

    // 6. Non-blocking WAL checkpoint (PASSIVE avoids acquiring EXCLUSIVE lock)
    try {
      this.db.pragma("wal_checkpoint(PASSIVE)");
    } catch {}

    // 7. Update SQLite query optimizer statistics
    try {
      this.db.pragma("optimize");
    } catch {}

    // 8. Reclaim unused memory buffers back to OS
    try {
      this.db.pragma("shrink_memory");
    } catch {}

    // 9. Request V8 memory compaction if exposure flag is set
    try {
      if (typeof global.gc === "function") {
        global.gc();
      }
    } catch {}

    return {
      deletedCount: totalDeleted,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Start daily automated maintenance timer (24h) with initial startup run
   */
  public startDailyMaintenance(cronIntervalMs = 24 * 60 * 60 * 1000): NodeJS.Timeout {
    // Initial startup maintenance after 60s grace period
    setTimeout(() => {
      try {
        const res = this.pruneOldLogs();
        if (res.deletedCount > 0) {
          console.log(`🧹 [DB Maintenance] Initial startup prune: cleaned ${res.deletedCount} records in ${res.durationMs}ms`);
        }
      } catch (err: any) {
        console.warn("⚠️ [DB Maintenance] Initial startup prune error:", err.message);
      }
    }, 60_000).unref();

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

