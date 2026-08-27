import Database from "better-sqlite3";
import { SubscriptionRecord } from "../../types/db.js";

export interface SubscriptionFlags {
  notify_on_available: number;
  notify_on_sold_out: number;
  notify_on_models: number;
  notify_on_prices: number;
}

export class SubscriptionDAO {
  private stmtAddSub: Database.Statement;
  private stmtRemoveSub: Database.Statement;
  private stmtCountActiveSubs: Database.Statement;
  private stmtHasSub: Database.Statement;
  private stmtGetSub: Database.Statement;
  private stmtUpsertSubWithFlags: Database.Statement;
  private stmtUpdateExistingChildren: Database.Statement;
  private stmtGetSubsForUser: Database.Statement;
  private stmtGetAllSubs: Database.Statement;
  private stmtGetAnyPoolSub: Database.Statement;

  private txTogglePool: (userId: number, poolSlug: string, newState: boolean, blockIds: string[]) => void;
  private txToggleBlock: (userId: number, poolSlug: string, blockId: string, newBlockState: boolean, allBlockIds: string[]) => void;
  private txToggleGlobal: (userId: number, newState: boolean, pools: Array<{ slug: string; blocks: string[] }>) => void;

  constructor(public readonly db: Database.Database) {
    this.stmtGetSub = db.prepare(`
      SELECT * FROM subscriptions WHERE user_id = ? AND pool_slug = ? AND block_id = ?
    `);

    this.stmtGetAnyPoolSub = db.prepare(`
      SELECT * FROM subscriptions WHERE user_id = ? AND pool_slug = ? LIMIT 1
    `);

    this.stmtGetSubsForUser = db.prepare(`
      SELECT * FROM subscriptions WHERE user_id = ?
    `);

    this.stmtGetAllSubs = db.prepare(`
      SELECT * FROM subscriptions
    `);

    this.stmtUpdateExistingChildren = db.prepare(`
      UPDATE subscriptions 
      SET notify_on_available = @avail, 
          notify_on_sold_out = @sold, 
          notify_on_models = @models, 
          notify_on_prices = @prices
      WHERE user_id = @user_id AND pool_slug = @pool_slug AND block_id != 'ALL'
    `);

    this.stmtUpsertSubWithFlags = db.prepare(`
      INSERT INTO subscriptions (
        user_id, pool_slug, block_id, notify_on_available, notify_on_sold_out, notify_on_models, notify_on_prices
      ) VALUES (@user_id, @pool_slug, @block_id, @avail, @sold, @models, @prices)
      ON CONFLICT(user_id, pool_slug, block_id) DO UPDATE SET
        notify_on_available = excluded.notify_on_available,
        notify_on_sold_out = excluded.notify_on_sold_out,
        notify_on_models = excluded.notify_on_models,
        notify_on_prices = excluded.notify_on_prices
    `);

    this.stmtAddSub = db.prepare(`
      INSERT INTO subscriptions (
        user_id, pool_slug, block_id, notify_on_available, notify_on_sold_out, notify_on_models, notify_on_prices
      ) VALUES (?, ?, ?, 1, 0, 1, 1)
      ON CONFLICT(user_id, pool_slug, block_id) DO UPDATE SET
        notify_on_available = 1,
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

  getSubscription(userId: number, poolSlug: string, blockId: string): SubscriptionRecord | undefined {
    return this.stmtGetSub.get(userId, poolSlug, blockId) as SubscriptionRecord | undefined;
  }

  getPoolFlags(userId: number, poolSlug: string): { available: boolean; soldOut: boolean; models: boolean; prices: boolean; isSubscribed: boolean } {
    let sub = this.getSubscription(userId, poolSlug, "ALL");
    if (!sub) {
      // Check if user is subscribed to any regional block of this pool
      const childSub = this.stmtGetAnyPoolSub.get(userId, poolSlug) as SubscriptionRecord | undefined;
      if (childSub) {
        sub = childSub;
      }
    }
    if (!sub) {
      return { available: true, soldOut: false, models: true, prices: true, isSubscribed: false };
    }
    return {
      available: sub.notify_on_available === 1,
      soldOut: sub.notify_on_sold_out === 1,
      models: sub.notify_on_models === 1,
      prices: sub.notify_on_prices === 1,
      isSubscribed: true,
    };
  }

  /**
   * Atomic Granular Event Filter Toggle for a specific pool:
   * Synchronously updates SQLite in WAL mode and propagates only to active regional blocks.
   */
  togglePoolEventCategory(
    userId: number,
    poolSlug: string,
    category: "available" | "sold_out" | "models" | "prices",
    blockIds: string[] = ["asia", "europe", "americas"]
  ): { newState: boolean; flags: SubscriptionFlags } {
    return this.db.transaction(() => {
      const hasAll = this.hasSubscription(userId, poolSlug, "ALL");
      let current = this.getSubscription(userId, poolSlug, "ALL");
      if (!current) {
        const childSub = this.stmtGetAnyPoolSub.get(userId, poolSlug) as SubscriptionRecord | undefined;
        if (childSub) current = childSub;
      }

      const currentFlags = {
        avail: current?.notify_on_available ?? 1,
        sold: current?.notify_on_sold_out ?? 0,
        models: current?.notify_on_models ?? 1,
        prices: current?.notify_on_prices ?? 1,
      };

      if (category === "available") currentFlags.avail = currentFlags.avail === 1 ? 0 : 1;
      if (category === "sold_out") currentFlags.sold = currentFlags.sold === 1 ? 0 : 1;
      if (category === "models") currentFlags.models = currentFlags.models === 1 ? 0 : 1;
      if (category === "prices") currentFlags.prices = currentFlags.prices === 1 ? 0 : 1;

      // Only upsert pool master 'ALL' if user already has an active ALL subscription
      if (hasAll) {
        this.stmtUpsertSubWithFlags.run({
          user_id: userId,
          pool_slug: poolSlug,
          block_id: "ALL",
          ...currentFlags,
        });
      }

      // Synchronize only EXISTING child blocks (never insert phantom blocks for disabled regions)
      this.stmtUpdateExistingChildren.run({
        user_id: userId,
        pool_slug: poolSlug,
        ...currentFlags,
      });

      const newState = (category === "available" ? currentFlags.avail :
                        category === "sold_out" ? currentFlags.sold :
                        category === "models" ? currentFlags.models : currentFlags.prices) === 1;

      return {
        newState,
        flags: {
          notify_on_available: currentFlags.avail,
          notify_on_sold_out: currentFlags.sold,
          notify_on_models: currentFlags.models,
          notify_on_prices: currentFlags.prices,
        },
      };
    })();
  }

  getSubscriptionsForUser(userId: number): SubscriptionRecord[] {
    return this.stmtGetSubsForUser.all(userId) as SubscriptionRecord[];
  }

  getAllSubscriptions(): SubscriptionRecord[] {
    return this.stmtGetAllSubs.all() as SubscriptionRecord[];
  }

  updateUserGlobalCategory(
    userId: number,
    category: "available" | "sold_out" | "models" | "prices",
    enabled: boolean
  ): void {
    const col =
      category === "available"
        ? "notify_on_available"
        : category === "sold_out"
        ? "notify_on_sold_out"
        : category === "models"
        ? "notify_on_models"
        : "notify_on_prices";
    this.db
      .prepare(`UPDATE subscriptions SET ${col} = ? WHERE user_id = ?`)
      .run(enabled ? 1 : 0, userId);
  }
}
