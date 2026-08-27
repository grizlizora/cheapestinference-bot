import Database from "better-sqlite3";
import { SupportedLanguage } from "../../types/db.js";

export interface PackedUserProfile {
  userId: number;
  telegramId: number;
  language: SupportedLanguage;
  isMuted: boolean;
  isActive: boolean;
  notifyAvailableGlobal: boolean;
  notifySoldOutGlobal: boolean;
  notifyModelsGlobal: boolean;
  notifyPricesGlobal: boolean;
  lastActiveAt?: number;
  lastDbTouchAt?: number;
}

export class SubscriberInvertedIndex {
  // Composite Key: "pool_slug:block_id:event_type" -> Set of User Primary Keys (id)
  private index = new Map<string, Set<number>>();
  // poolSlug -> Set of known blockIds
  private poolBlocks = new Map<string, Set<string>>();
  // User Primary Key (id) -> Packed Profile
  private profiles = new Map<number, PackedUserProfile>();
  // Telegram ID -> User Primary Key (id)
  private tgIdToUserId = new Map<number, number>();

  constructor(private db: Database.Database) {
    this.hydrateFromDatabase();
  }

  /**
   * Cold-start initialization using streaming iterator (zero heap spikes)
   */
  public hydrateFromDatabase(): void {
    console.log("⚡ [InvertedIndex] Hydrating subscriber cache from SQLite...");
    const startTime = performance.now();

    this.index.clear();
    this.profiles.clear();
    this.tgIdToUserId.clear();

    // 1. Stream Users
    const userStmt = this.db.prepare(`
      SELECT 
        id, telegram_id, language, is_muted, is_active,
        COALESCE(notify_available_global, 1) as notify_available_global,
        COALESCE(notify_sold_out_global, 0) as notify_sold_out_global,
        COALESCE(notify_models_global, 1) as notify_models_global,
        COALESCE(notify_prices_global, 1) as notify_prices_global,
        last_active_at
      FROM users
    `);

    for (const row of userStmt.iterate() as Iterable<{
      id: number;
      telegram_id: number;
      language: string;
      is_muted: number;
      is_active: number;
      notify_available_global: number;
      notify_sold_out_global: number;
      notify_models_global: number;
      notify_prices_global: number;
      last_active_at?: string;
    }>) {
      this.profiles.set(row.id, {
        userId: row.id,
        telegramId: row.telegram_id,
        language: (row.language as SupportedLanguage) || "en",
        isMuted: row.is_muted === 1,
        isActive: row.is_active === 1,
        notifyAvailableGlobal: row.notify_available_global === 1,
        notifySoldOutGlobal: row.notify_sold_out_global === 1,
        notifyModelsGlobal: row.notify_models_global === 1,
        notifyPricesGlobal: row.notify_prices_global === 1,
        lastActiveAt: row.last_active_at ? (Date.parse(row.last_active_at.replace(" ", "T") + "Z") || Date.parse(row.last_active_at) || 0) : 0,
        lastDbTouchAt: row.last_active_at ? (Date.parse(row.last_active_at.replace(" ", "T") + "Z") || Date.parse(row.last_active_at) || 0) : 0,
      });
      this.tgIdToUserId.set(row.telegram_id, row.id);
    }

    // 2. Stream Subscriptions
    const subStmt = this.db.prepare(`
      SELECT 
        user_id, pool_slug, block_id,
        COALESCE(notify_on_available, 1) as notify_on_available,
        COALESCE(notify_on_sold_out, 0) as notify_on_sold_out,
        COALESCE(notify_on_models, 1) as notify_on_models,
        COALESCE(notify_on_prices, 1) as notify_on_prices
      FROM subscriptions
    `);

    let subCount = 0;
    for (const row of subStmt.iterate() as Iterable<{
      user_id: number;
      pool_slug: string;
      block_id: string;
      notify_on_available: number;
      notify_on_sold_out: number;
      notify_on_models: number;
      notify_on_prices: number;
    }>) {
      if (row.notify_on_available === 1) {
        this.addIndexEntry(`${row.pool_slug}:${row.block_id}:available`, row.user_id);
      }
      if (row.notify_on_sold_out === 1) {
        this.addIndexEntry(`${row.pool_slug}:${row.block_id}:sold_out`, row.user_id);
      }
      if (row.notify_on_models === 1) {
        this.addIndexEntry(`${row.pool_slug}:${row.block_id}:models`, row.user_id);
      }
      if (row.notify_on_prices === 1) {
        this.addIndexEntry(`${row.pool_slug}:${row.block_id}:prices`, row.user_id);
      }
      subCount++;
    }

    const elapsed = (performance.now() - startTime).toFixed(2);
    console.log(
      `✅ [InvertedIndex] Loaded ${this.profiles.size} users, ${subCount} subscriptions in ${elapsed}ms`
    );
  }

  private addIndexEntry(key: string, userId: number): void {
    let set = this.index.get(key);
    if (!set) {
      set = new Set<number>();
      this.index.set(key, set);
    }
    set.add(userId);

    const parts = key.split(":");
    if (parts.length >= 2 && parts[0] !== "ALL" && parts[1] !== "ALL") {
      let blocks = this.poolBlocks.get(parts[0]);
      if (!blocks) {
        blocks = new Set<string>();
        this.poolBlocks.set(parts[0], blocks);
      }
      blocks.add(parts[1]);
    }
  }

  /**
   * O(1) Hierarchical Subscriber Resolution with Engagement-Based Active-First Sorting
   */
  public resolveSubscribers(
    poolSlug: string,
    blockId: string,
    eventType: "available" | "sold_out" | "models" | "prices"
  ): PackedUserProfile[] {
    const matchedUserIds = new Set<number>();

    // 1. Global: 'ALL:ALL'
    const globalSet = this.index.get(`ALL:ALL:${eventType}`);
    if (globalSet) for (const id of globalSet) matchedUserIds.add(id);

    // 2. Pool-level: 'poolSlug:ALL'
    const poolSet = this.index.get(`${poolSlug}:ALL:${eventType}`);
    if (poolSet) for (const id of poolSet) matchedUserIds.add(id);

    // 3. Exact Block: 'poolSlug:blockId'
    if (blockId !== "ALL") {
      const blockSet = this.index.get(`${poolSlug}:${blockId}:${eventType}`);
      if (blockSet) for (const id of blockSet) matchedUserIds.add(id);
    } else {
      // 4. Pool-wide event: query all known regional blocks in O(1)
      const blocks = this.poolBlocks.get(poolSlug) || new Set(["asia", "europe", "americas"]);
      for (const b of blocks) {
        const regionalSet = this.index.get(`${poolSlug}:${b}:${eventType}`);
        if (regionalSet) for (const id of regionalSet) matchedUserIds.add(id);
      }
    }

    // Filter active users
    const results: PackedUserProfile[] = [];
    for (const userId of matchedUserIds) {
      const profile = this.profiles.get(userId);
      if (!profile || !profile.isActive) continue;

      results.push(profile);
    }

    // Engagement-Based Sorting: Most recently active users are placed at the front of the queue
    results.sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));

    return results;
  }

  /**
   * Fast-path Write-Through update on user subscription change
   */
  private removeIndexEntry(key: string, userId: number): void {
    const set = this.index.get(key);
    if (set) {
      set.delete(userId);
      if (set.size === 0) {
        this.index.delete(key);
      }
    }
  }

  /**
   * Fast-path Write-Through update on user subscription change
   */
  public updateSubscription(
    userId: number,
    poolSlug: string,
    blockId: string,
    flags: {
      available?: boolean;
      soldOut?: boolean;
      models?: boolean;
      prices?: boolean;
    }
  ): void {
    const availKey = `${poolSlug}:${blockId}:available`;
    const soldKey = `${poolSlug}:${blockId}:sold_out`;
    const modelKey = `${poolSlug}:${blockId}:models`;
    const priceKey = `${poolSlug}:${blockId}:prices`;

    if (flags.available !== undefined) {
      if (flags.available) this.addIndexEntry(availKey, userId);
      else this.removeIndexEntry(availKey, userId);
    }
    if (flags.soldOut !== undefined) {
      if (flags.soldOut) this.addIndexEntry(soldKey, userId);
      else this.removeIndexEntry(soldKey, userId);
    }
    if (flags.models !== undefined) {
      if (flags.models) this.addIndexEntry(modelKey, userId);
      else this.removeIndexEntry(modelKey, userId);
    }
    if (flags.prices !== undefined) {
      if (flags.prices) this.addIndexEntry(priceKey, userId);
      else this.removeIndexEntry(priceKey, userId);
    }
  }

  /**
   * Fast-path user preference update
   */
  public updateUserPreferences(
    telegramId: number,
    prefs: Partial<PackedUserProfile>
  ): void {
    const userId = this.tgIdToUserId.get(telegramId);
    if (userId) {
      const profile = this.profiles.get(userId);
      if (profile) {
        Object.assign(profile, prefs);
      }
    }
  }

  /**
   * Upsert or register user in memory
   */
  public upsertUserProfile(profile: PackedUserProfile): void {
    this.profiles.set(profile.userId, profile);
    this.tgIdToUserId.set(profile.telegramId, profile.userId);
  }

  /**
   * Instant user block / deactivation (removes from RAM immediately)
   */
  public markUserDeactivated(telegramId: number): void {
    const userId = this.tgIdToUserId.get(telegramId);
    if (userId) {
      const profile = this.profiles.get(userId);
      if (profile) {
        profile.isActive = false;
      }
    }
  }

  public getProfileByTgId(telegramId: number): PackedUserProfile | undefined {
    const userId = this.tgIdToUserId.get(telegramId);
    return userId ? this.profiles.get(userId) : undefined;
  }

  public getMemoryStats(): { userCount: number; indexKeys: number; approxBytes: number } {
    let setEntries = 0;
    for (const set of this.index.values()) {
      setEntries += set.size;
    }
    const approxBytes = this.profiles.size * 64 + setEntries * 8 + this.index.size * 64;
    return {
      userCount: this.profiles.size,
      indexKeys: this.index.size,
      approxBytes,
    };
  }
}
