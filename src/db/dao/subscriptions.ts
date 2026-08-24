import Database from "better-sqlite3";
import { SubscriberMatch, SubscriptionRecord } from "../../types/db.js";

export class SubscriptionDAO {
  private stmtFindSubscribers: Database.Statement;
  private stmtGetUserSubs: Database.Statement;
  private stmtAddSub: Database.Statement;
  private stmtRemoveSub: Database.Statement;
  private stmtCountActiveSubs: Database.Statement;
  private stmtHasSub: Database.Statement;

  constructor(private db: Database.Database) {
    // Matches 3 hierarchical subscription levels:
    // 1. Global: ('ALL', 'ALL')
    // 2. Pool-wide: (poolSlug, 'ALL')
    // 3. Slot-specific: (poolSlug, blockId)
    this.stmtFindSubscribers = db.prepare(`
      SELECT DISTINCT u.telegram_id, u.language, u.is_muted
      FROM subscriptions s
      JOIN users u ON s.user_id = u.id
      WHERE u.is_active = 1
        AND (
          (s.pool_slug = 'ALL' AND s.block_id = 'ALL')
          OR (s.pool_slug = ? AND s.block_id = 'ALL')
          OR (s.pool_slug = ? AND s.block_id = ?)
        )
        AND (
          (? = 'available' AND s.notify_on_available = 1)
          OR (? = 'sold_out' AND s.notify_on_sold_out = 1)
        )
    `);

    this.stmtGetUserSubs = db.prepare(`
      SELECT * FROM subscriptions WHERE user_id = ?
    `);

    this.stmtAddSub = db.prepare(`
      INSERT INTO subscriptions (user_id, pool_slug, block_id, notify_on_available, notify_on_sold_out)
      VALUES (?, ?, ?, 1, 1)
      ON CONFLICT(user_id, pool_slug, block_id) DO UPDATE SET
        notify_on_available = 1,
        notify_on_sold_out = 1
    `);

    this.stmtRemoveSub = db.prepare(`
      DELETE FROM subscriptions WHERE user_id = ? AND pool_slug = ? AND block_id = ?
    `);

    this.stmtCountActiveSubs = db.prepare(`
      SELECT COUNT(*) as total FROM subscriptions
    `);

    this.stmtHasSub = db.prepare(`
      SELECT id FROM subscriptions WHERE user_id = ? AND pool_slug = ? AND block_id = ?
    `);
  }

  findSubscribersForSlot(
    poolSlug: string,
    blockId: string,
    eventType: "available" | "sold_out"
  ): SubscriberMatch[] {
    return this.stmtFindSubscribers.all(
      poolSlug,
      poolSlug,
      blockId,
      eventType,
      eventType
    ) as SubscriberMatch[];
  }

  getUserSubscriptions(userId: number): SubscriptionRecord[] {
    return this.stmtGetUserSubs.all(userId) as SubscriptionRecord[];
  }

  hasSubscription(userId: number, poolSlug: string, blockId: string): boolean {
    const row = this.stmtHasSub.get(userId, poolSlug, blockId);
    return !!row;
  }

  toggleSubscription(userId: number, poolSlug: string, blockId: string): boolean {
    const exists = this.hasSubscription(userId, poolSlug, blockId);
    if (exists) {
      this.stmtRemoveSub.run(userId, poolSlug, blockId);
      return false; // Now unsubscribed
    } else {
      this.stmtAddSub.run(userId, poolSlug, blockId);
      return true; // Now subscribed
    }
  }

  setSubscription(userId: number, poolSlug: string, blockId: string, active: boolean): void {
    if (active) {
      this.stmtAddSub.run(userId, poolSlug, blockId);
    } else {
      this.stmtRemoveSub.run(userId, poolSlug, blockId);
    }
  }

  getTotalActiveSubscriptions(): number {
    const row = this.stmtCountActiveSubs.get() as any;
    return Number(row?.total || 0);
  }
}
