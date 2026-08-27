import Database from "better-sqlite3";
import { tursoCloudSync } from "../tursoSync.js";
import { DemandCategory } from "../../types/domain.js";

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
  demandCategory: DemandCategory;
  avgDurationFormatted: string;
}

export class SlotHistoryDAO {
  private stmtOpenSlot: Database.Statement;
  private stmtCloseActiveSlot: Database.Statement;
  private stmtGetAnalytics: Database.Statement;
  private stmtGetActiveSlot: Database.Statement;
  private txRecordOpened: (poolSlug: string, blockId: string, status: string, price: string) => void;

  constructor(private db: Database.Database) {
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

    this.txRecordOpened = this.db.transaction((poolSlug, blockId, status, price) => {
      this.stmtCloseActiveSlot.run(poolSlug, blockId);
      this.stmtOpenSlot.run(poolSlug, blockId, status, price);
    });
  }

  public recordSlotOpened(
    poolSlug: string,
    blockId: string,
    initialStatus: string,
    priceMonth: string
  ): void {
    this.txRecordOpened(poolSlug, blockId, initialStatus, priceMonth);
    tursoCloudSync.pushMutation(
      `UPDATE slot_lifecycle_history 
       SET closed_at = CURRENT_TIMESTAMP,
           duration_seconds = CAST((strftime('%s', 'now') - strftime('%s', opened_at)) AS INTEGER)
       WHERE pool_slug = ? AND block_id = ? AND closed_at IS NULL`,
      [poolSlug, blockId]
    );
    tursoCloudSync.pushMutation(
      `INSERT INTO slot_lifecycle_history (pool_slug, block_id, initial_status, price_month, opened_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [poolSlug, blockId, initialStatus, priceMonth]
    );
  }

  public recordSlotClosed(poolSlug: string, blockId: string): void {
    this.stmtCloseActiveSlot.run(poolSlug, blockId);
    tursoCloudSync.pushMutation(
      `UPDATE slot_lifecycle_history 
       SET closed_at = CURRENT_TIMESTAMP,
           duration_seconds = CAST((strftime('%s', 'now') - strftime('%s', opened_at)) AS INTEGER)
       WHERE pool_slug = ? AND block_id = ? AND closed_at IS NULL`,
      [poolSlug, blockId]
    );
  }

  public getActiveSlot(poolSlug: string, blockId: string): SlotLifecycleRecord | undefined {
    return this.stmtGetActiveSlot.get(poolSlug, blockId) as SlotLifecycleRecord | undefined;
  }

  public getSlotAnalytics(poolSlug: string, blockId: string): SlotAnalytics {
    const row = this.stmtGetAnalytics.get(poolSlug, blockId) as any;
    const total = Number(row?.total_openings || 0);
    const avgSec = row?.avg_duration != null ? Math.round(Number(row.avg_duration)) : null;

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
        avgDurationFormatted = `~${avgSec}s`;
      } else if (avgSec < 3600) {
        avgDurationFormatted = `~${Math.round(avgSec / 60)} min`;
      } else {
        avgDurationFormatted = `~${(avgSec / 3600).toFixed(1)} h`;
      }
    }

    return {
      avgDurationSeconds: avgSec,
      minDurationSeconds: row?.min_duration != null ? Number(row.min_duration) : null,
      maxDurationSeconds: row?.max_duration != null ? Number(row.max_duration) : null,
      totalOpenings: total,
      lastOpenedAt: row?.last_opened_at || null,
      demandCategory,
      avgDurationFormatted,
    };
  }

  /**
   * Fetches the last 50 completed durations (in seconds) for a specific pool block.
   * Filtered to closed slots with valid duration >= 5s.
   */
  public getRawDurations(poolSlug: string, blockId: string, limit = 50): number[] {
    const rows = this.db
      .prepare(`
        SELECT duration_seconds 
        FROM slot_lifecycle_history
        WHERE pool_slug = ? AND block_id = ? 
          AND closed_at IS NOT NULL 
          AND duration_seconds IS NOT NULL 
          AND duration_seconds >= 5
        ORDER BY opened_at DESC
        LIMIT ?
      `)
      .all(poolSlug, blockId, limit) as Array<{ duration_seconds: number }>;

    return rows.map((r) => Number(r.duration_seconds)).filter((d) => !isNaN(d) && d > 0);
  }

  /**
   * Computes historical downtime intervals ΔT = T_open(k) - T_close(k-1)
   * in seconds for strict (pool_slug, block_id) isolation.
   */
  public getDowntimeIntervals(poolSlug: string, blockId: string, limit = 30): number[] {
    const rows = this.db
      .prepare(`
        WITH OrderedIntervals AS (
          SELECT 
            opened_at,
            closed_at,
            strftime('%s', opened_at) AS open_epoch,
            strftime('%s', closed_at) AS close_epoch,
            LAG(strftime('%s', closed_at)) OVER (
              PARTITION BY pool_slug, block_id 
              ORDER BY opened_at ASC
            ) AS prev_close_epoch
          FROM slot_lifecycle_history
          WHERE pool_slug = ? AND block_id = ?
        )
        SELECT 
          (open_epoch - prev_close_epoch) AS downtime_seconds
        FROM OrderedIntervals
        WHERE prev_close_epoch IS NOT NULL AND (open_epoch - prev_close_epoch) > 0
        ORDER BY open_epoch DESC
        LIMIT ?
      `)
      .all(poolSlug, blockId, limit) as Array<{ downtime_seconds: number }>;

    return rows.map((r) => Number(r.downtime_seconds)).filter((d) => !isNaN(d) && d > 0);
  }

  /**
   * Gets the epoch timestamp (seconds) of the last closed slot for this block.
   */
  public getLastClosedEpoch(poolSlug: string, blockId: string): number | null {
    const row = this.db
      .prepare(`
        SELECT strftime('%s', closed_at) AS closed_epoch
        FROM slot_lifecycle_history
        WHERE pool_slug = ? AND block_id = ? AND closed_at IS NOT NULL
        ORDER BY closed_at DESC
        LIMIT 1
      `)
      .get(poolSlug, blockId) as { closed_epoch?: string | number } | undefined;

    return row?.closed_epoch ? Number(row.closed_epoch) : null;
  }

  /**
   * Gets the most recent closed slot record for this block.
   */
  public getLastClosedSlotRecord(poolSlug: string, blockId: string): SlotLifecycleRecord | undefined {
    return this.db
      .prepare(`
        SELECT * FROM slot_lifecycle_history
        WHERE pool_slug = ? AND block_id = ? AND closed_at IS NOT NULL
        ORDER BY closed_at DESC
        LIMIT 1
      `)
      .get(poolSlug, blockId) as SlotLifecycleRecord | undefined;
  }

  /**
   * Alias for getSlotAnalytics with extended predictive format
   */
  public getBlockPredictiveAnalytics(poolSlug: string, blockId: string): SlotAnalytics {
    return this.getSlotAnalytics(poolSlug, blockId);
  }
}

