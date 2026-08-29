import Database from "better-sqlite3";

export class DatabaseMaintenanceManager {
  private stmtPruneLogsBatch: Database.Statement;
  private stmtPruneSlotHistoryBatch: Database.Statement;
  private stmtPruneCatalogHistoryBatch: Database.Statement;
  private stmtPruneSlotPriceHistoryBatch: Database.Statement;
  private stmtPruneActiveDashboardsBatch: Database.Statement;
  private stmtPruneOutboxBatch: Database.Statement;
  private stmtFreelistCount: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    private readonly retentionDays = 30
  ) {
    this.stmtPruneLogsBatch = db.prepare(`
      DELETE FROM notification_logs 
      WHERE id IN (
        SELECT id FROM notification_logs 
        WHERE sent_at < datetime('now', '-' || ? || ' days')
        LIMIT 2000
      )
    `);

    this.stmtPruneSlotHistoryBatch = db.prepare(`
      DELETE FROM slot_lifecycle_history 
      WHERE id IN (
        SELECT id FROM slot_lifecycle_history 
        WHERE closed_at IS NOT NULL 
          AND closed_at < datetime('now', '-90 days')
        LIMIT 2000
      )
    `);

    this.stmtPruneCatalogHistoryBatch = db.prepare(`
      DELETE FROM catalog_history 
      WHERE id IN (
        SELECT id FROM catalog_history 
        WHERE detected_at < datetime('now', '-90 days')
        LIMIT 2000
      )
    `);

    this.stmtPruneSlotPriceHistoryBatch = db.prepare(`
      DELETE FROM slot_price_history 
      WHERE id IN (
        SELECT id FROM slot_price_history 
        WHERE changed_at < datetime('now', '-90 days')
        LIMIT 2000
      )
    `);

    this.stmtPruneActiveDashboardsBatch = db.prepare(`
      DELETE FROM active_dashboards 
      WHERE chat_id IN (
        SELECT chat_id FROM active_dashboards 
        WHERE last_interaction_at < datetime('now', '-48 hours')
           OR consecutive_errors >= 3
        LIMIT 2000
      )
    `);

    this.stmtPruneOutboxBatch = db.prepare(`
      DELETE FROM notification_outbox 
      WHERE id IN (
        SELECT id FROM notification_outbox 
        WHERE (status = 'dispatched' AND dispatched_at < datetime('now', '-24 hours'))
           OR (status = 'failed' AND created_at < datetime('now', '-3 days'))
           OR (status = 'pending' AND created_at < datetime('now', '-6 hours'))
        LIMIT 2000
      )
    `);

    this.stmtFreelistCount = db.prepare("PRAGMA freelist_count");
  }

  /**
   * Non-blocking chunked rolling purge of logs and historical data
   */
  public pruneOldLogs(): { deletedCount: number; durationMs: number; pagesReclaimed: number } {
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

    // 5. Purge expired active dashboards (>48 hours)
    try {
      while (true) {
        const dashResult = this.stmtPruneActiveDashboardsBatch.run();
        totalDeleted += dashResult.changes;
        if (dashResult.changes < 2000) break;
      }
    } catch {}

    // 6. Purge stale outbox records (>24 hours dispatched, >3 days failed, >6 hours pending)
    try {
      while (true) {
        const outboxResult = this.stmtPruneOutboxBatch.run();
        totalDeleted += outboxResult.changes;
        if (outboxResult.changes < 2000) break;
      }
    } catch {}

    // 7. Reclaim freed pages back to OS via dynamic incremental vacuum
    let pagesReclaimed = 0;
    try {
      let prevFreelist = Infinity;
      let maxPasses = 50;
      while (maxPasses-- > 0) {
        const row = this.stmtFreelistCount.get() as any;
        const freelist = Number(row?.freelist_count || 0);
        if (freelist <= 0 || freelist >= prevFreelist) break;
        prevFreelist = freelist;
        const batch = Math.min(freelist, 2000);
        this.db.pragma(`incremental_vacuum(${batch})`);
        pagesReclaimed += batch;
      }
    } catch {}

    // 6. Non-blocking WAL checkpoint and truncate to 0 bytes
    try {
      const res = this.db.pragma("wal_checkpoint(TRUNCATE)", { simple: false }) as any;
      if (res && res[0]?.busy === 1) {
        this.db.pragma("wal_checkpoint(PASSIVE)");
      }
    } catch {
      try {
        this.db.pragma("wal_checkpoint(PASSIVE)");
      } catch {}
    }

    // 7. Update SQLite query optimizer statistics
    try {
      this.db.pragma("optimize");
    } catch {}

    return {
      deletedCount: totalDeleted,
      durationMs: Date.now() - start,
      pagesReclaimed,
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

    // Periodic non-blocking WAL flush every 10 minutes to guarantee persistent disk safety
    setInterval(() => {
      try {
        this.db.pragma("wal_checkpoint(PASSIVE)");
      } catch {}
    }, 10 * 60 * 1000).unref();

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

