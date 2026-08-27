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
  private stmtUpdateGlobalAvail: Database.Statement;
  private stmtUpdateGlobalSold: Database.Statement;
  private stmtUpdateGlobalModels: Database.Statement;
  private stmtUpdateGlobalPrices: Database.Statement;

  private txTogglePool: (userId: number, poolSlug: string, newState: boolean, blockIds: string[]) => void;
  private txToggleBlock: (userId: number, poolSlug: string, blockId: string, newBlockState: boolean, allBlockIds: string[]) => void;
  private txToggleGlobal: (userId: number, newState: boolean, pools: Array<{ slug: string; blocks: string[] }>) => void;
  private txTogglePoolCategory: (userId: number, poolSlug: string, category: "available" | "sold_out" | "models" | "prices") => { newState: boolean; flags: SubscriptionFlags };

  constructor(public readonly db: Database.Database) {
    this.stmtUpdateGlobalAvail = db.prepare(`UPDATE subscriptions SET notify_on_available = ? WHERE user_id = ?`);
    this.stmtUpdateGlobalSold = db.prepare(`UPDATE subscriptions SET notify_on_sold_out = ? WHERE user_id = ?`);
    this.stmtUpdateGlobalModels = db.prepare(`UPDATE subscriptions SET notify_on_models = ? WHERE user_id = ?`);
    this.stmtUpdateGlobalPrices = db.prepare(`UPDATE subscriptions SET notify_on_prices = ? WHERE user_id = ?`);

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
      SELECT 1 FROM subscriptions WHERE user_id = ? AND pool_slug = ? AND block_id = ? LIMIT 1
    `);

    this.txTogglePool = db.transaction((userId: number, poolSlug: string, newState: boolean, blockIds: string[]) => {
      if (newState) {
        this.stmtAddSub.run(userId, poolSlug, "ALL");
        for (const b of blockIds) {
          this.stmtRemoveSub.run(userId, poolSlug, b);
        }
      } else {
        this.stmtRemoveSub.run(userId, poolSlug, "ALL");
        for (const b of blockIds) {
          this.stmtRemoveSub.run(userId, poolSlug, b);
        }
      }
    });

    this.txToggleBlock = db.transaction((userId: number, poolSlug: string, blockId: string, newBlockState: boolean, allBlockIds: string[]) => {
      const hasAll = this.hasSubscription(userId, poolSlug, "ALL");
      if (hasAll) {
        this.stmtRemoveSub.run(userId, poolSlug, "ALL");
        for (const b of allBlockIds) {
          if (b === blockId) {
            if (newBlockState) this.stmtAddSub.run(userId, poolSlug, b);
          } else {
            this.stmtAddSub.run(userId, poolSlug, b);
          }
        }
        return;
      }

      if (newBlockState) {
        this.stmtAddSub.run(userId, poolSlug, blockId);
      } else {
        this.stmtRemoveSub.run(userId, poolSlug, blockId);
      }
    });

    this.txToggleGlobal = db.transaction((userId: number, newState: boolean, pools: Array<{ slug: string; blocks: string[] }>) => {
      if (newState) {
        this.stmtAddSub.run(userId, "ALL", "ALL");
        for (const p of pools) {
          this.stmtRemoveSub.run(userId, p.slug, "ALL");
          for (const b of p.blocks) {
            this.stmtRemoveSub.run(userId, p.slug, b);
          }
        }
      } else {
        this.stmtRemoveSub.run(userId, "ALL", "ALL");
        for (const p of pools) {
          this.stmtRemoveSub.run(userId, p.slug, "ALL");
          for (const b of p.blocks) {
            this.stmtRemoveSub.run(userId, p.slug, b);
          }
        }
      }
    });

    this.txTogglePoolCategory = db.transaction((userId: number, poolSlug: string, category: "available" | "sold_out" | "models" | "prices") => {
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

      // Upsert pool master 'ALL' with custom flags to persist preferences even before subscribing
      if (hasAll || !current) {
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
    });
  }

  setSubscription(userId: number, poolSlug: string, blockId: string, enabled: boolean): void {
    if (enabled) {
      this.stmtAddSub.run(userId, poolSlug, blockId);
    } else {
      this.stmtRemoveSub.run(userId, poolSlug, blockId);
    }
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

  getSubscriptionStats(): { totalRules: number; subscribedUsers: number } {
    const row = this.db.prepare(`
      SELECT 
        COUNT(*) as total_rules,
        COUNT(DISTINCT user_id) as subscribed_users
      FROM subscriptions
    `).get() as any;
    return {
      totalRules: Number(row?.total_rules || 0),
      subscribedUsers: Number(row?.subscribed_users || 0),
    };
  }

  togglePoolWithBlocks(userId: number, poolSlug: string, blockIds: string[] = ["asia", "europe", "americas"]): boolean {
    const hasAll = this.hasSubscription(userId, poolSlug, "ALL");
    const newState = !hasAll;
    this.txTogglePool(userId, poolSlug, newState, blockIds);
    return newState;
  }

  toggleBlockAndUpdatePool(
    userId: number,
    poolSlug: string,
    blockId: string,
    allBlockIds: string[] = ["asia", "europe", "americas"]
  ): { isBlockSubscribed: boolean; isPoolSubscribed: boolean } {
    const isBlockSubscribed = this.hasSubscription(userId, poolSlug, blockId);
    const newBlockState = !isBlockSubscribed;
    this.txToggleBlock(userId, poolSlug, blockId, newBlockState, allBlockIds);

    return {
      isBlockSubscribed: newBlockState,
      isPoolSubscribed: this.hasSubscription(userId, poolSlug, "ALL"),
    };
  }

  toggleGlobalWithAllPools(
    userId: number,
    pools: Array<{ slug: string; blocks: string[] }>
  ): boolean {
    const hasGlobal = this.hasSubscription(userId, "ALL", "ALL");
    const newState = !hasGlobal;
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
    _blockIds: string[] = ["asia", "europe", "americas"]
  ): { newState: boolean; flags: SubscriptionFlags } {
    return this.txTogglePoolCategory(userId, poolSlug, category);
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
    const val = enabled ? 1 : 0;
    if (category === "available") this.stmtUpdateGlobalAvail.run(val, userId);
    else if (category === "sold_out") this.stmtUpdateGlobalSold.run(val, userId);
    else if (category === "models") this.stmtUpdateGlobalModels.run(val, userId);
    else if (category === "prices") this.stmtUpdateGlobalPrices.run(val, userId);
  }
}
