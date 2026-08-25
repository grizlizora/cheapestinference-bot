import Database from "better-sqlite3";

export interface SlotLifecycleRecord {
  id: number;
  pool_slug: string;
  block_id: string;
  opened_at: string;
  closed_at: string | null;
  duration_seconds: number | null;
  initial_status: string;
  price_month: string;
}

export interface SlotAnalytics {
  avgDurationSeconds: number | null;
  minDurationSeconds: number | null;
  maxDurationSeconds: number | null;
  totalOpenings: number;
  lastOpenedAt: string | null;
  demandCategory: "hot" | "moderate" | "stable" | "unknown";
  avgDurationFormatted: string;
}

export class SlotHistoryDAO {
  private stmtOpenSlot: Database.Statement;
  private stmtCloseActiveSlot: Database.Statement;
  private stmtGetAnalytics: Database.Statement;
  private stmtGetActiveSlot: Database.Statement;

  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS slot_lifecycle_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pool_slug TEXT NOT NULL,
        block_id TEXT NOT NULL,
        opened_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        closed_at DATETIME,
        duration_seconds INTEGER,
        initial_status TEXT NOT NULL,
        price_month TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_slot_history_lookup 
      ON slot_lifecycle_history(pool_slug, block_id, opened_at);
    `);

    this.stmtOpenSlot = db.prepare(`
      INSERT INTO slot_lifecycle_history (pool_slug, block_id, initial_status, price_month, opened_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    this.stmtCloseActiveSlot = db.prepare(`
      UPDATE slot_lifecycle_history
      SET closed_at = CURRENT_TIMESTAMP,
          duration_seconds = CAST((strftime('%s', 'now') - strftime('%s', opened_at)) AS INTEGER)
      WHERE pool_slug = ? AND block_id = ? AND closed_at IS NULL
    `);

    this.stmtGetActiveSlot = db.prepare(`
      SELECT * FROM slot_lifecycle_history
      WHERE pool_slug = ? AND block_id = ? AND closed_at IS NULL
      ORDER BY id DESC LIMIT 1
    `);

    this.stmtGetAnalytics = db.prepare(`
      SELECT 
        COUNT(*) as total_openings,
        AVG(duration_seconds) as avg_duration,
        MIN(duration_seconds) as min_duration,
        MAX(duration_seconds) as max_duration,
        MAX(opened_at) as last_opened_at
      FROM slot_lifecycle_history
      WHERE pool_slug = ? AND block_id = ? AND duration_seconds IS NOT NULL
    `);
  }

  public recordSlotOpened(
    poolSlug: string,
    blockId: string,
    initialStatus: string,
    priceMonth: string
  ): void {
    // Close any previous dangling unclosed record for safety
    this.recordSlotClosed(poolSlug, blockId);
    this.stmtOpenSlot.run(poolSlug, blockId, initialStatus, priceMonth);
  }

  public recordSlotClosed(poolSlug: string, blockId: string): void {
    this.stmtCloseActiveSlot.run(poolSlug, blockId);
  }

  public getActiveSlot(poolSlug: string, blockId: string): SlotLifecycleRecord | undefined {
    return this.stmtGetActiveSlot.get(poolSlug, blockId) as SlotLifecycleRecord | undefined;
  }

  public getSlotAnalytics(poolSlug: string, blockId: string): SlotAnalytics {
    const row = this.stmtGetAnalytics.get(poolSlug, blockId) as any;
    const total = Number(row?.total_openings || 0);
    const avgSec = row?.avg_duration ? Math.round(Number(row.avg_duration)) : null;

    let demandCategory: SlotAnalytics["demandCategory"] = "unknown";
    if (avgSec !== null) {
      if (avgSec <= 1800) {
        // Less than 30 minutes average duration -> Hot / High demand
        demandCategory = "hot";
      } else if (avgSec <= 7200) {
        // 30 min - 2 hours -> Moderate
        demandCategory = "moderate";
      } else {
        // > 2 hours -> Stable
        demandCategory = "stable";
      }
    }

    let avgDurationFormatted = "";
    if (avgSec !== null) {
      if (avgSec < 60) {
        avgDurationFormatted = `~${avgSec}с`;
      } else if (avgSec < 3600) {
        avgDurationFormatted = `~${Math.round(avgSec / 60)} хв`;
      } else {
        avgDurationFormatted = `~${(avgSec / 3600).toFixed(1)} год`;
      }
    }

    return {
      avgDurationSeconds: avgSec,
      minDurationSeconds: row?.min_duration ? Number(row.min_duration) : null,
      maxDurationSeconds: row?.max_duration ? Number(row.max_duration) : null,
      totalOpenings: total,
      lastOpenedAt: row?.last_opened_at || null,
      demandCategory,
      avgDurationFormatted,
    };
  }
}
