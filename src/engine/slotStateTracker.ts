/**
 * src/engine/slotStateTracker.ts
 * In-Memory Slot & Pool State Tracker with K=1 Fast-Track & K=2 Noise-Gate FSM
 */

import {
  PoolData,
  PoolBlock,
  PoolsSnapshot,
  DiffEvent,
  DemandCategory,
  DropPatternType,
  isSlotAvailable,
  normalizeSlotStatus,
} from "../types/domain.js";
import { SlotHistoryDAO } from "../db/dao/slotHistory.js";
import { PriceDiffEvaluator, StagedSlotPriceChange } from "./priceDiffEvaluator.js";
import { PredictiveAnalyticsEngine } from "./predictiveEngine.js";

export interface TrackedSlot {
  poolSlug: string;
  poolName: string;
  models: string[];
  block: string;
  hoursUtc: string;
  status: string;
  pricePerMonth: string;
  lastSeenAt: number;
}

export interface DaoBootstrapRecord {
  pool_slug: string;
  pool_name: string;
  models_json: string;
  block_id: string;
  status: string;
  hours_utc: string;
  price_month: string;
  min_price_day: string;
  annual_discount: number;
  description: string;
  infra_spec?: string;
  manual_provisioning?: number;
}

export interface SlotSyncResult {
  events: DiffEvent[];
  stagedPriceChanges: Map<string, StagedSlotPriceChange[]>;
  incomingSlotKeys: Set<string>;
  incomingPoolSlugs: Set<string>;
}

export class SlotStateTracker {
  private inMemorySlots = new Map<string, TrackedSlot>();
  private inMemoryPools = new Map<string, PoolData>();
  private pendingDisappearances = new Map<string, number>();
  private pendingPoolDisappearances = new Map<string, number>();
  private isInitialized = false;

  public isReady(): boolean {
    return this.isInitialized;
  }

  public getPool(slug: string): PoolData | undefined {
    return this.inMemoryPools.get(slug);
  }

  public setPool(slug: string, pool: PoolData): void {
    this.inMemoryPools.set(slug, pool);
  }

  public getSnapshot(): PoolsSnapshot | null {
    if (!this.isInitialized) return null;
    const pools: PoolData[] = [];
    for (const [slug, pool] of this.inMemoryPools) {
      const blocks: PoolBlock[] = [];
      for (const [, slot] of this.inMemorySlots) {
        if (slot.poolSlug === slug) {
          blocks.push({
            block: slot.block,
            hoursUtc: slot.hoursUtc,
            pricePerMonth: slot.pricePerMonth,
            status: normalizeSlotStatus(slot.status),
          });
        }
      }
      pools.push({
        ...pool,
        blocks: blocks.length > 0 ? blocks : pool.blocks,
      });
    }
    return {
      success: true,
      data: pools,
    };
  }

  /**
   * Hydrates baseline state from SQLite records without emitting false alerts.
   */
  public bootstrapFromDao(records: DaoBootstrapRecord[]): void {
    const poolsMap = new Map<string, PoolData>();

    for (const row of records) {
      let models: string[] = [];
      try {
        models = JSON.parse(row.models_json);
      } catch {
        models = [];
      }

      const key = `${row.pool_slug}:${row.block_id}`;
      const normalizedStatus = normalizeSlotStatus(row.status);
      this.inMemorySlots.set(key, {
        poolSlug: row.pool_slug,
        poolName: row.pool_name,
        models,
        block: row.block_id,
        hoursUtc: row.hours_utc || "",
        status: normalizedStatus,
        pricePerMonth: row.price_month,
        lastSeenAt: Date.now(),
      });

      if (!poolsMap.has(row.pool_slug)) {
        poolsMap.set(row.pool_slug, {
          id: row.pool_slug,
          slug: row.pool_slug,
          modelId: row.pool_slug,
          modelName: row.pool_name,
          models,
          blocks: [],
          status: row.status,
          minPricePerDay: row.min_price_day,
          annualDiscount: row.annual_discount,
          description: row.description,
          infraSpec: row.infra_spec,
          manualProvisioning: row.manual_provisioning === 1,
        });
      }

      const p = poolsMap.get(row.pool_slug)!;
      p.blocks.push({
        block: row.block_id,
        hoursUtc: row.hours_utc || "",
        status: normalizedStatus,
        pricePerMonth: row.price_month,
      });
    }

    for (const [slug, pool] of poolsMap) {
      this.inMemoryPools.set(slug, pool);
    }

    this.isInitialized = true;
    console.log(
      `✅ [SlotDiffEngine] Hydrated baseline from SQLite with ${this.inMemorySlots.size} slots across ${this.inMemoryPools.size} pools.`
    );
  }

  /**
   * Cold-start baseline bootstrap from live snapshot.
   */
  public bootstrap(snapshot: PoolsSnapshot): void {
    const now = Date.now();
    for (const pool of snapshot.data) {
      this.inMemoryPools.set(pool.slug, pool);
      for (const block of pool.blocks) {
        const key = `${pool.slug}:${block.block}`;
        this.inMemorySlots.set(key, {
          poolSlug: pool.slug,
          poolName: pool.modelName,
          models: pool.models || [],
          block: block.block,
          hoursUtc: block.hoursUtc,
          status: block.status,
          pricePerMonth: block.pricePerMonth,
          lastSeenAt: now,
        });
      }
    }
    this.isInitialized = true;
    console.log(
      `✅ [SlotDiffEngine] Bootstrapped baseline with ${this.inMemorySlots.size} slots across ${this.inMemoryPools.size} pools.`
    );
  }

  /**
   * Processes all incoming pools and blocks in the snapshot against current state.
   */
  public syncSnapshotSlots(
    snapshot: PoolsSnapshot,
    historyDao: SlotHistoryDAO | undefined,
    predictiveEngine: PredictiveAnalyticsEngine | undefined,
    timestamp: number
  ): SlotSyncResult {
    const events: DiffEvent[] = [];
    const stagedPriceChanges = new Map<string, StagedSlotPriceChange[]>();
    const incomingSlotKeys = new Set<string>();
    const incomingPoolSlugs = new Set<string>();

    for (const pool of snapshot.data) {
      incomingPoolSlugs.add(pool.slug);
      for (const block of pool.blocks) {
        const key = `${pool.slug}:${block.block}`;
        incomingSlotKeys.add(key);

        const prevSlot = this.inMemorySlots.get(key);

        if (prevSlot) {
          const wasAvailable = isSlotAvailable(prevSlot.status);
          const isAvailable = isSlotAvailable(block.status);
          let targetStatus = block.status;

          // Status Transition: Became Available (K=1 Fast-Track)
          if (!wasAvailable && isAvailable) {
            this.pendingDisappearances.delete(key);
            targetStatus = block.status;
            historyDao?.recordSlotOpened(pool.slug, block.block, block.status, block.pricePerMonth);

            events.push({
              id: crypto.randomUUID(),
              type: "SLOT_APPEARED",
              poolSlug: pool.slug,
              poolName: pool.modelName,
              block: block.block,
              models: pool.models || [],
              hoursUtc: block.hoursUtc,
              newStatus: block.status,
              newPrice: block.pricePerMonth,
              timestamp,
            });
          }
          // Status Transition: Became Sold-Out (K=2 Noise Gate Confirmation)
          else if (wasAvailable && !isAvailable) {
            const count = (this.pendingDisappearances.get(key) || 0) + 1;
            if (count >= 2) {
              this.pendingDisappearances.delete(key);
              targetStatus = block.status; // Confirmed: switch status in memory to "sold-out"
              historyDao?.recordSlotClosed(pool.slug, block.block);

              let eta = undefined;
              if (predictiveEngine) {
                eta = predictiveEngine.predictNextAvailability(pool.slug, block.block, "sold-out");
              }

              let avgLifespanFormatted = "";
              let demandCategory: DemandCategory = "unknown";
              let avgLifespanSeconds: number | null = null;
              let totalOpenings = 0;

              if (historyDao) {
                const analytics = historyDao.getBlockPredictiveAnalytics(pool.slug, block.block);
                avgLifespanFormatted = analytics.avgDurationFormatted;
                demandCategory = analytics.demandCategory;
                avgLifespanSeconds = analytics.avgDurationSeconds;
                totalOpenings = analytics.totalOpenings;
              }

              events.push({
                id: crypto.randomUUID(),
                type: "SLOT_DISAPPEARED",
                poolSlug: pool.slug,
                poolName: pool.modelName,
                block: block.block,
                models: pool.models || [],
                hoursUtc: block.hoursUtc,
                newStatus: block.status,
                newPrice: block.pricePerMonth,
                timestamp,
                analytics: {
                  avgLifespanFormatted,
                  avgLifespanSeconds,
                  demandCategory,
                  isBatchDrop: false,
                  dropPattern: "UNKNOWN",
                  totalOpenings,
                  eta,
                },
              });
            } else {
              this.pendingDisappearances.set(key, count);
              targetStatus = prevSlot.status; // K=1 unconfirmed: hold "available" in memory
            }
          } else {
            if (isAvailable) {
              this.pendingDisappearances.delete(key);
            }
            targetStatus = block.status;
          }

          // Price Change Detection & Staging
          if (block.pricePerMonth !== prevSlot.pricePerMonth) {
            const prevPriceNum = PriceDiffEvaluator.parseCleanPrice(prevSlot.pricePerMonth);
            const newPriceNum = PriceDiffEvaluator.parseCleanPrice(block.pricePerMonth);
            const priceDelta = PriceDiffEvaluator.cleanDelta(newPriceNum - prevPriceNum);
            const pctDelta =
              prevPriceNum > 0
                ? PriceDiffEvaluator.cleanDelta((priceDelta / prevPriceNum) * 100)
                : 0;

            const isValidPrev = prevSlot.pricePerMonth !== undefined && prevSlot.pricePerMonth !== "" && !isNaN(prevPriceNum);
            const isValidNew = block.pricePerMonth !== undefined && block.pricePerMonth !== "" && !isNaN(newPriceNum);
            if (priceDelta !== 0 && isValidPrev && isValidNew && prevPriceNum >= 0 && newPriceNum >= 0) {
              if (!stagedPriceChanges.has(pool.slug)) {
                stagedPriceChanges.set(pool.slug, []);
              }
              stagedPriceChanges.get(pool.slug)!.push({
                block: block.block,
                hoursUtc: block.hoursUtc,
                prevPrice: prevSlot.pricePerMonth,
                newPrice: block.pricePerMonth,
                delta: priceDelta,
                pct: pctDelta,
                status: block.status,
              });
            }
          }

          // Update in-memory state with authoritative targetStatus
          this.inMemorySlots.set(key, {
            poolSlug: pool.slug,
            poolName: pool.modelName,
            models: pool.models || [],
            block: block.block,
            hoursUtc: block.hoursUtc,
            status: targetStatus,
            pricePerMonth: block.pricePerMonth,
            lastSeenAt: timestamp,
          });
        } else {
          // Discovered new regional block for pool
          this.inMemorySlots.set(key, {
            poolSlug: pool.slug,
            poolName: pool.modelName,
            models: pool.models || [],
            block: block.block,
            hoursUtc: block.hoursUtc,
            status: block.status,
            pricePerMonth: block.pricePerMonth,
            lastSeenAt: timestamp,
          });

          if (isSlotAvailable(block.status)) {
            historyDao?.recordSlotOpened(pool.slug, block.block, block.status, block.pricePerMonth);
            events.push({
              id: crypto.randomUUID(),
              type: "SLOT_APPEARED",
              poolSlug: pool.slug,
              poolName: pool.modelName,
              block: block.block,
              models: pool.models || [],
              hoursUtc: block.hoursUtc,
              newStatus: block.status,
              newPrice: block.pricePerMonth,
              timestamp,
            });
          }
        }
      }
    }

    return { events, stagedPriceChanges, incomingSlotKeys, incomingPoolSlugs };
  }

  /**
   * Reconciles vanished slots and pools missing from the current scrape tick.
   */
  public reconcileMissingEntities(
    incomingSlotKeys: Set<string>,
    incomingPoolSlugs: Set<string>,
    historyDao: SlotHistoryDAO | undefined,
    timestamp: number
  ): DiffEvent[] {
    const events: DiffEvent[] = [];

    // 1. Missing Slots
    for (const [key, slot] of this.inMemorySlots) {
      if (!incomingSlotKeys.has(key)) {
        const wasAvailable = slot.status === "available" || slot.status === "limited";
        if (wasAvailable) {
          const count = (this.pendingDisappearances.get(key) || 0) + 1;
          if (count >= 2) {
            this.pendingDisappearances.delete(key);
            historyDao?.recordSlotClosed(slot.poolSlug, slot.block);
            this.inMemorySlots.delete(key);

            events.push({
              id: crypto.randomUUID(),
              type: "SLOT_DISAPPEARED",
              poolSlug: slot.poolSlug,
              poolName: slot.poolName,
              block: slot.block,
              models: slot.models || [],
              hoursUtc: slot.hoursUtc,
              newStatus: "sold-out",
              newPrice: slot.pricePerMonth,
              timestamp,
            });
          } else {
            this.pendingDisappearances.set(key, count);
          }
        } else {
          this.inMemorySlots.delete(key);
          this.pendingDisappearances.delete(key);
        }
      }
    }

    // 2. Missing Pools
    for (const [slug] of this.inMemoryPools) {
      if (!incomingPoolSlugs.has(slug)) {
        const pCount = (this.pendingPoolDisappearances.get(slug) || 0) + 1;
        if (pCount >= 2) {
          this.pendingPoolDisappearances.delete(slug);
          this.inMemoryPools.delete(slug);
        } else {
          this.pendingPoolDisappearances.set(slug, pCount);
        }
      } else {
        this.pendingPoolDisappearances.delete(slug);
      }
    }

    return events;
  }
}
