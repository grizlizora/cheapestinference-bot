import Database from "better-sqlite3";
import { SupportedLanguage } from "../../types/db.js";

export const FREE_USER_INACTIVITY_LIMIT_MS = 14 * 24 * 60 * 60 * 1000; // 14 days = 1,209,600,000 ms
export const STAR_GRACE_EXTENSION_MS = 24 * 60 * 60 * 1000;            // +1 day per 1 Star = 86,400,000 ms

export function computeUserInactivityLimitMs(stars: number = 0): number {
  return FREE_USER_INACTIVITY_LIMIT_MS + Math.max(0, stars) * STAR_GRACE_EXTENSION_MS;
}

export interface PackedUserProfile {
  userId: number;
  telegramId: number;
  language: SupportedLanguage;
  isMuted: boolean;
  isActive: boolean;
  isAdmin?: boolean;
  totalDonatedStars?: number;
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
  // Explicit Exclusions: "pool_slug:block_id:event_type" -> Set of User Primary Keys (id)
  private exclusions = new Map<string, Set<number>>();
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
    this.exclusions.clear();
    this.profiles.clear();
    this.tgIdToUserId.clear();

    // 1. Stream Users (with dynamic schema backward compatibility)
    const tableInfo = this.db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>;
    const cols = new Set(tableInfo.map((c) => c.name));
    const hasAdmin = cols.has("is_admin") ? "COALESCE(is_admin, 0) as is_admin" : "0 as is_admin";
    const hasStars = cols.has("total_donated_stars") ? "COALESCE(total_donated_stars, 0) as total_donated_stars" : "0 as total_donated_stars";

    const userStmt = this.db.prepare(`
      SELECT 
        id, telegram_id, language, is_muted, is_active,
        ${hasAdmin},
        ${hasStars},
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
      is_admin: number;
      total_donated_stars: number;
      notify_available_global: number;
      notify_sold_out_global: number;
      notify_models_global: number;
      notify_prices_global: number;
      last_active_at?: string;
    }>) {
        const parsedLastActive = row.last_active_at
          ? (Date.parse(row.last_active_at.replace(" ", "T") + "Z") || Date.parse(row.last_active_at) || Date.now())
          : Date.now();

        this.profiles.set(row.id, {
          userId: row.id,
          telegramId: row.telegram_id,
          language: (row.language as SupportedLanguage) || "en",
          isMuted: row.is_muted === 1,
          isActive: row.is_active === 1,
          isAdmin: row.is_admin === 1,
          totalDonatedStars: row.total_donated_stars || 0,
          notifyAvailableGlobal: row.notify_available_global === 1,
          notifySoldOutGlobal: row.notify_sold_out_global === 1,
          notifyModelsGlobal: row.notify_models_global === 1,
          notifyPricesGlobal: row.notify_prices_global === 1,
          lastActiveAt: parsedLastActive,
          lastDbTouchAt: parsedLastActive,
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
      } else {
        this.addExclusionEntry(`${row.pool_slug}:${row.block_id}:available`, row.user_id);
      }

      if (row.notify_on_sold_out === 1) {
        this.addIndexEntry(`${row.pool_slug}:${row.block_id}:sold_out`, row.user_id);
      } else {
        this.addExclusionEntry(`${row.pool_slug}:${row.block_id}:sold_out`, row.user_id);
      }

      if (row.notify_on_models === 1) {
        this.addIndexEntry(`${row.pool_slug}:${row.block_id}:models`, row.user_id);
      } else {
        this.addExclusionEntry(`${row.pool_slug}:${row.block_id}:models`, row.user_id);
      }

      if (row.notify_on_prices === 1) {
        this.addIndexEntry(`${row.pool_slug}:${row.block_id}:prices`, row.user_id);
      } else {
        this.addExclusionEntry(`${row.pool_slug}:${row.block_id}:prices`, row.user_id);
      }
      subCount++;
    }

    const elapsed = (performance.now() - startTime).toFixed(2);
    console.log(
      `✅ [InvertedIndex] Loaded ${this.profiles.size} users, ${subCount} subscriptions in ${elapsed}ms`
    );
  }

  /**
   * Add a composite index mapping in O(1)
   */
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

  private addExclusionEntry(key: string, userId: number): void {
    let set = this.exclusions.get(key);
    if (!set) {
      set = new Set<number>();
      this.exclusions.set(key, set);
    }
    set.add(userId);
  }

  private removeExclusionEntry(key: string, userId: number): void {
    const set = this.exclusions.get(key);
    if (set) {
      set.delete(userId);
      if (set.size === 0) {
        this.exclusions.delete(key);
      }
    }
  }

  /**
   * O(1) Hierarchical Subscriber Resolution with 3-Tier Priority Queue Sorting & Exclusion Filtering:
   * 1. Admins first (instant delivery)
   * 2. Top Donors (totalDonatedStars DESC — higher Stars = earlier alert delivery)
   * 3. Engagement-based active users (lastActiveAt DESC)
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

    // Apply explicit exclusions (block-specific, pool-specific, or global)
    const blockExclusions = blockId !== "ALL" ? this.exclusions.get(`${poolSlug}:${blockId}:${eventType}`) : undefined;
    const poolExclusions = this.exclusions.get(`${poolSlug}:ALL:${eventType}`);
    const globalExclusions = this.exclusions.get(`ALL:ALL:${eventType}`);

    if (blockExclusions) {
      for (const id of blockExclusions) matchedUserIds.delete(id);
    }
    if (poolExclusions) {
      for (const id of poolExclusions) matchedUserIds.delete(id);
    }
    if (globalExclusions) {
      for (const id of globalExclusions) matchedUserIds.delete(id);
    }

    // 3-Bucket Linear Partition (Dial's Scheme): O(k) linear separation with Inactivity Engine
    const admins: PackedUserProfile[] = [];
    const donors: PackedUserProfile[] = [];
    const freeUsers: PackedUserProfile[] = [];
    const now = Date.now();

    for (const userId of matchedUserIds) {
      const profile = this.profiles.get(userId);
      if (!profile || !profile.isActive) continue;

      const timeSinceActive = now - (profile.lastActiveAt || 0);

      // Invariant 1: Admins always exempt with infinite lifetime immunity (Priority P0)
      if (profile.isAdmin) {
        admins.push(profile);
        continue;
      }

      // Invariant 2: Smart Proportional Star Retention Window
      // Base: 14 days. Each donated Star dynamically adds +1 day of active notification retention!
      const userStars = profile.totalDonatedStars || 0;
      const userCutoffLimitMs = computeUserInactivityLimitMs(userStars);

      if (timeSinceActive <= userCutoffLimitMs) {
        if (userStars > 0) {
          donors.push(profile);
        } else {
          freeUsers.push(profile);
        }
      }
    }

    // Sort only small donor and free user sub-arrays
    if (donors.length > 1) {
      donors.sort((a, b) => {
        const diff = (b.totalDonatedStars || 0) - (a.totalDonatedStars || 0);
        if (diff !== 0) return diff;
        return (b.lastActiveAt || 0) - (a.lastActiveAt || 0);
      });
    }
    if (freeUsers.length > 1) {
      freeUsers.sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
    }

    return [...admins, ...donors, ...freeUsers];
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
      if (flags.available) {
        this.addIndexEntry(availKey, userId);
        this.removeExclusionEntry(availKey, userId);
      } else {
        this.removeIndexEntry(availKey, userId);
        this.addExclusionEntry(availKey, userId);
      }
    }
    if (flags.soldOut !== undefined) {
      if (flags.soldOut) {
        this.addIndexEntry(soldKey, userId);
        this.removeExclusionEntry(soldKey, userId);
      } else {
        this.removeIndexEntry(soldKey, userId);
        this.addExclusionEntry(soldKey, userId);
      }
    }
    if (flags.models !== undefined) {
      if (flags.models) {
        this.addIndexEntry(modelKey, userId);
        this.removeExclusionEntry(modelKey, userId);
      } else {
        this.removeIndexEntry(modelKey, userId);
        this.addExclusionEntry(modelKey, userId);
      }
    }
    if (flags.prices !== undefined) {
      if (flags.prices) {
        this.addIndexEntry(priceKey, userId);
        this.removeExclusionEntry(priceKey, userId);
      } else {
        this.removeIndexEntry(priceKey, userId);
        this.addExclusionEntry(priceKey, userId);
      }
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
    if (!profile.lastActiveAt) {
      profile.lastActiveAt = Date.now();
    }
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
      for (const set of this.index.values()) {
        set.delete(userId);
      }
    }
  }

  public addDonationStars(telegramId: number, stars: number): void {
    const userId = this.tgIdToUserId.get(telegramId);
    if (userId) {
      const profile = this.profiles.get(userId);
      if (profile) {
        profile.totalDonatedStars = (profile.totalDonatedStars || 0) + stars;
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
