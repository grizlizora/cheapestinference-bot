import Database from "better-sqlite3";
import { SubscriberMatch, SubscriptionRecord } from "../../types/db.js";

export class SubscriptionDAO {
  private stmtFindSubscribers: Database.Statement;
  private stmtGetUserSubs: Database.Statement;
  private stmtAddSub: Database.Statement;
  private stmtRemoveSub: Database.Statement;
  private stmtCountActiveSubs: Database.Statement;
  private stmtHasSub: Database.Statement;

  private txTogglePool: (userId: number, poolSlug: string, newState: boolean, blockIds: string[]) => void;
  private txToggleBlock: (userId: number, poolSlug: string, blockId: string, newBlockState: boolean, allBlockIds: string[]) => void;
  private txToggleGlobal: (userId: number, newState: boolean, pools: Array<{ slug: string; blocks: string[] }>) => void;

  constructor(public readonly db: Database.Database) {
    this.stmtFindSubscribers = db.prepare(`
      SELECT DISTINCT u.telegram_id, u.language, u.is_muted
      FROM subscriptions s
      JOIN users u ON s.user_id = u.id
      WHERE u.is_active = 1
        AND (
          (s.pool_slug = 'ALL' AND s.block_id = 'ALL')
          OR (s.pool_slug = ? AND s.block_id = 'ALL')
          OR (s.pool_slug = ? AND s.block_id = ?)
          OR (? = 'ALL' AND s.pool_slug = ?)
        )
        AND (
          (? = 'available' AND s.notify_on_available = 1 AND COALESCE(u.notify_available_global, 1) = 1)
          OR (? = 'sold_out' AND s.notify_on_sold_out = 1 AND COALESCE(u.notify_sold_out_global, 0) = 1)
          OR (? = 'models' AND s.notify_on_models = 1 AND COALESCE(u.notify_models_global, 1) = 1)
          OR (? = 'prices' AND s.notify_on_prices = 1 AND COALESCE(u.notify_prices_global, 1) = 1)
        )
    `);

    this.stmtGetUserSubs = db.prepare(`
      SELECT * FROM subscriptions WHERE user_id = ?
    `);

    this.stmtAddSub = db.prepare(`
      INSERT INTO subscriptions (
        user_id, pool_slug, block_id, notify_on_available, notify_on_sold_out, notify_on_models, notify_on_prices
      ) VALUES (?, ?, ?, 1, 1, 1, 1)
      ON CONFLICT(user_id, pool_slug, block_id) DO UPDATE SET
        notify_on_available = 1,
        notify_on_sold_out = 1,
        notify_on_models = 1,
        notify_on_prices = 1
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

    this.txTogglePool = this.db.transaction((userId: number, poolSlug: string, newState: boolean, blockIds: string[]) => {
      this.setSubscription(userId, poolSlug, "ALL", newState);
      for (const b of blockIds) {
        this.setSubscription(userId, poolSlug, b, newState);
      }
      if (!newState) {
        this.setSubscription(userId, "ALL", "ALL", false);
      }
    });

    this.txToggleBlock = this.db.transaction((
      userId: number,
      poolSlug: string,
      blockId: string,
      newBlockState: boolean,
      allBlockIds: string[]
    ) => {
      this.setSubscription(userId, poolSlug, blockId, newBlockState);

      let allActive = true;
      for (const b of allBlockIds) {
        const sub = b === blockId ? newBlockState : this.hasSubscription(userId, poolSlug, b);
        if (!sub) {
          allActive = false;
          break;
        }
      }

      this.setSubscription(userId, poolSlug, "ALL", allActive);
      if (!newBlockState) {
        this.setSubscription(userId, "ALL", "ALL", false);
      }
    });

    this.txToggleGlobal = this.db.transaction((
      userId: number,
      newState: boolean,
      pools: Array<{ slug: string; blocks: string[] }>
    ) => {
      this.setSubscription(userId, "ALL", "ALL", newState);
      for (const p of pools) {
        this.setSubscription(userId, p.slug, "ALL", newState);
        for (const b of p.blocks) {
          this.setSubscription(userId, p.slug, b, newState);
        }
      }
    });
  }

  findSubscribersForSlot(
    poolSlug: string,
    blockId: string,
    eventType: "available" | "sold_out" | "models" | "prices"
  ): SubscriberMatch[] {
    return this.stmtFindSubscribers.all(
      poolSlug,
      poolSlug,
      blockId,
      blockId,
      poolSlug,
      eventType,
      eventType,
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
      return false;
    } else {
      this.stmtAddSub.run(userId, poolSlug, blockId);
      return true;
    }
  }

  setSubscription(userId: number, poolSlug: string, blockId: string, active: boolean): void {
    if (active) {
      this.stmtAddSub.run(userId, poolSlug, blockId);
    } else {
      this.stmtRemoveSub.run(userId, poolSlug, blockId);
    }
  }

  /**
   * Cascading Master Toggle for an entire pool:
   * Toggling "Весь пул" synchronizes the pool ('ALL') and all its regional blocks ('asia', 'europe', 'americas').
   * Also deactivates 'ALL:ALL' if the pool is turned off.
   */
  togglePoolWithBlocks(userId: number, poolSlug: string, blockIds: string[] = ["asia", "europe", "americas"]): boolean {
    const isCurrentlySubscribed = this.hasSubscription(userId, poolSlug, "ALL");
    const newState = !isCurrentlySubscribed;
    this.txTogglePool(userId, poolSlug, newState, blockIds);
    return newState;
  }

  /**
   * Child Block Toggle:
   * Toggles a single regional block, and auto-updates the parent "Весь пул" state if all blocks are now active or not.
   * Also deactivates 'ALL:ALL' if any block is turned off.
   */
  toggleBlockAndUpdatePool(
    userId: number,
    poolSlug: string,
    blockId: string,
    allBlockIds: string[] = ["asia", "europe", "americas"]
  ): boolean {
    const isCurrentlySubscribed = this.hasSubscription(userId, poolSlug, blockId);
    const newBlockState = !isCurrentlySubscribed;
    this.txToggleBlock(userId, poolSlug, blockId, newBlockState, allBlockIds);
    return newBlockState;
  }

  /**
   * Global Master Toggle:
   * Synchronizes Global ('ALL:ALL') and all pools/blocks.
   */
  toggleGlobalWithAllPools(
    userId: number,
    pools: Array<{ slug: string; blocks: string[] }>
  ): boolean {
    const isGlobal = this.hasSubscription(userId, "ALL", "ALL");
    const newState = !isGlobal;
    this.txToggleGlobal(userId, newState, pools);
    return newState;
  }

  getTotalActiveSubscriptions(): number {
    const row = this.stmtCountActiveSubs.get() as any;
    return Number(row?.total || 0);
  }
}
