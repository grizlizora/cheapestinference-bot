import { DiffEvent, PoolData, PoolsSnapshot } from "../types/domain.js";
import { SlotHistoryDAO } from "../db/dao/slotHistory.js";
import { CatalogHistoryDAO } from "../db/dao/catalogHistory.js";
import { ModelSemanticMatcher } from "./modelSemanticMatcher.js";

function parseCleanPrice(val: string | undefined | null): number {
  if (!val) return 0;
  const cleaned = String(val).replace(/[^0-9.-]/g, "");
  const num = parseFloat(cleaned);
  if (isNaN(num)) return 0;
  return Math.round(num * 100) / 100;
}

function cleanDelta(val: number): number {
  const rounded = Math.round(val * 100) / 100;
  return Object.is(rounded, -0) || rounded === 0 ? 0 : rounded;
}

interface TrackedSlot {
  poolSlug: string;
  poolName: string;
  models: string[];
  block: string;
  hoursUtc: string;
  status: string;
  pricePerMonth: string;
  lastSeenAt: number;
}

export class SlotDiffEngine {
  private inMemorySlots = new Map<string, TrackedSlot>();
  private inMemoryPools = new Map<string, PoolData>();
  private pendingDisappearances = new Map<string, number>();
  private pendingPoolDisappearances = new Map<string, number>();
  private isInitialized = false;

  constructor(
    private readonly historyDao?: SlotHistoryDAO,
    private readonly catalogHistoryDao?: CatalogHistoryDAO
  ) {}

  public isReady(): boolean {
    return this.isInitialized;
  }

  public getSnapshot(): PoolsSnapshot | null {
    if (!this.isInitialized) return null;
    return {
      success: true,
      data: Array.from(this.inMemoryPools.values()),
    };
  }

  public bootstrapFromDao(records: Array<{
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
  }>): void {
    if (this.isInitialized || records.length === 0) return;

    const poolsMap = new Map<string, PoolData>();
    const now = Date.now();

    for (const r of records) {
      let models: string[] = [];
      try {
        models = JSON.parse(r.models_json);
      } catch {
        models = [];
      }

      const key = `${r.pool_slug}:${r.block_id}`;
      this.inMemorySlots.set(key, {
        poolSlug: r.pool_slug,
        poolName: r.pool_name,
        models,
        block: r.block_id,
        hoursUtc: r.hours_utc,
        status: r.status,
        pricePerMonth: r.price_month,
        lastSeenAt: now,
      });

      let pool = poolsMap.get(r.pool_slug);
      if (!pool) {
        pool = {
          id: r.pool_slug,
          slug: r.pool_slug,
          modelId: r.pool_slug,
          modelName: r.pool_name,
          models,
          description: r.description || "",
          status: "active",
          minPricePerDay: r.min_price_day || "0",
          annualDiscount: typeof r.annual_discount === "number" ? r.annual_discount : 0.15,
          infraSpec: r.infra_spec || undefined,
          manualProvisioning: Boolean(r.manual_provisioning),
          blocks: [],
        };
        poolsMap.set(r.pool_slug, pool);
      }

      pool.blocks.push({
        block: r.block_id,
        hoursUtc: r.hours_utc,
        pricePerMonth: r.price_month,
        status: r.status,
      });
    }

    for (const [slug, pool] of poolsMap.entries()) {
      this.inMemoryPools.set(slug, pool);
    }

    this.isInitialized = true;
    console.log(
      `✅ [SlotDiffEngine] Hydrated baseline from SQLite with ${this.inMemorySlots.size} slots across ${this.inMemoryPools.size} pools.`
    );
  }

  public processSnapshot(snapshot: PoolsSnapshot): DiffEvent[] {
    const now = Date.now();
    const events: DiffEvent[] = [];

    if (!this.isInitialized) {
      this.bootstrap(snapshot);
      return [];
    }

    const incomingSlotKeys = new Set<string>();
    const incomingPoolSlugs = new Set<string>();

    for (const pool of snapshot.data) {
      incomingPoolSlugs.add(pool.slug);
      const prevPool = this.inMemoryPools.get(pool.slug);

      if (prevPool) {
        // 1. Model Catalog Granular Diffing (ModelSemanticMatcher)
        const modelDiff = ModelSemanticMatcher.diffModelLists(
          pool.slug,
          pool.modelName,
          prevPool.models || [],
          pool.models || []
        );

        if (modelDiff.hasChanges) {
          this.catalogHistoryDao?.recordModelUpgrade(modelDiff);
          events.push({
            id: crypto.randomUUID(),
            type: "MODEL_UPGRADE_EVENT",
            poolSlug: pool.slug,
            poolName: pool.modelName,
            block: "ALL",
            models: pool.models || [],
            hoursUtc: "",
            newStatus: pool.status,
            newPrice: pool.minPricePerDay,
            timestamp: now,
            modelUpgrade: {
              added: modelDiff.added,
              upgraded: modelDiff.upgraded,
              removed: modelDiff.removed,
              allActiveModels: pool.models || [],
            },
          });
        }

        // 2. Tier Terms & Metadata Diffing
        const descChanged = (prevPool.description || "") !== (pool.description || "");
        const discountChanged = (prevPool.annualDiscount || 0) !== (pool.annualDiscount || 0);
        const infraChanged = (prevPool.infraSpec || "") !== (pool.infraSpec || "");
        const manualProvChanged = (prevPool.manualProvisioning || false) !== (pool.manualProvisioning || false);

        if (descChanged || discountChanged || infraChanged || manualProvChanged) {
          const tierPayload = {
            previousDescription: prevPool.description,
            newDescription: pool.description,
            previousAnnualDiscount: prevPool.annualDiscount,
            newAnnualDiscount: pool.annualDiscount || 0.15,
            previousInfraSpec: prevPool.infraSpec,
            newInfraSpec: pool.infraSpec,
            previousManualProvisioning: prevPool.manualProvisioning,
            newManualProvisioning: pool.manualProvisioning,
            manualProvisioningChanged: manualProvChanged,
          };
          this.catalogHistoryDao?.recordTierUpdate(
            pool.slug,
            pool.modelName,
            pool.models || [],
            tierPayload
          );
          events.push({
            id: crypto.randomUUID(),
            type: "TIER_UPDATED_EVENT",
            poolSlug: pool.slug,
            poolName: pool.modelName,
            block: "ALL",
            models: pool.models || [],
            hoursUtc: "",
            timestamp: now,
            tierUpdate: tierPayload,
          });
        }
      } else {
        // Brand new pool listed
        events.push({
          id: crypto.randomUUID(),
          type: "NEW_POOL_EVENT",
          poolSlug: pool.slug,
          poolName: pool.modelName,
          block: "ALL",
          models: pool.models || [],
          hoursUtc: "",
          newStatus: pool.status,
          newPrice: pool.minPricePerDay,
          timestamp: now,
        });
      }

      this.inMemoryPools.set(pool.slug, pool);

      // 3. Regional Slot Block Diffing & Price Change Staging
      interface StagedSlotPriceChange {
        block: string;
        hoursUtc: string;
        prevPrice: string;
        newPrice: string;
        delta: number;
        pct: number;
        status: string;
      }
      const stagedSlotPriceChanges: StagedSlotPriceChange[] = [];

      for (const block of pool.blocks) {
        const key = `${pool.slug}:${block.block}`;
        incomingSlotKeys.add(key);
        const prevSlot = this.inMemorySlots.get(key);

        if (!prevSlot) {
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

          if (block.status === "available" || block.status === "limited") {
            this.historyDao?.recordSlotOpened(
              pool.slug,
              block.block,
              block.status,
              block.pricePerMonth
            );
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
              timestamp: now,
            });
          }
          continue;
        }

        const wasInStock = prevSlot.status === "available" || prevSlot.status === "limited";
        const isNowInStock = block.status === "available" || block.status === "limited";
        const isNowSoldOut = block.status === "sold-out";

        // Status transitions
        if (prevSlot.status !== block.status) {
          if (!wasInStock && isNowInStock) {
            // Fast-path K=1
            this.pendingDisappearances.delete(key);
            this.historyDao?.recordSlotOpened(
              pool.slug,
              block.block,
              block.status,
              block.pricePerMonth
            );
            events.push({
              id: crypto.randomUUID(),
              type: "SLOT_APPEARED",
              poolSlug: pool.slug,
              poolName: pool.modelName,
              block: block.block,
              models: pool.models || [],
              hoursUtc: block.hoursUtc,
              previousStatus: prevSlot.status,
              newStatus: block.status,
              previousPrice: prevSlot.pricePerMonth,
              newPrice: block.pricePerMonth,
              timestamp: now,
            });
            prevSlot.status = block.status;
          } else if (wasInStock && isNowSoldOut) {
            // K=2 Confirmation Gate
            const pendingCount = (this.pendingDisappearances.get(key) || 0) + 1;
            this.pendingDisappearances.set(key, pendingCount);

            if (pendingCount >= 2) {
              this.historyDao?.recordSlotClosed(pool.slug, block.block);
              events.push({
                id: crypto.randomUUID(),
                type: "SLOT_DISAPPEARED",
                poolSlug: pool.slug,
                poolName: pool.modelName,
                block: block.block,
                models: pool.models || [],
                hoursUtc: block.hoursUtc,
                previousStatus: prevSlot.status,
                newStatus: block.status,
                previousPrice: prevSlot.pricePerMonth,
                newPrice: block.pricePerMonth,
                timestamp: now,
              });
              prevSlot.status = block.status;
              this.pendingDisappearances.delete(key);
            }
          } else {
            // Status transition between active states (available <-> limited)
            this.pendingDisappearances.delete(key);
            prevSlot.status = block.status;
          }
        } else {
          if (this.pendingDisappearances.has(key)) {
            this.pendingDisappearances.delete(key);
          }
        }

        // Stage Regional Slot Price Changed (SLOT_PRICE_CHANGED)
        const oldPriceNum = parseCleanPrice(prevSlot.pricePerMonth);
        const newPriceNum = parseCleanPrice(block.pricePerMonth);
        if (
          prevSlot.pricePerMonth !== block.pricePerMonth &&
          block.pricePerMonth !== "" &&
          block.pricePerMonth !== "0" &&
          oldPriceNum > 0 &&
          newPriceNum > 0 &&
          Math.abs(newPriceNum - oldPriceNum) >= 0.01
        ) {
          const delta = cleanDelta(newPriceNum - oldPriceNum);
          const pct = oldPriceNum > 0 ? cleanDelta((delta / oldPriceNum) * 100) : 0;
          stagedSlotPriceChanges.push({
            block: block.block,
            hoursUtc: block.hoursUtc,
            prevPrice: prevSlot.pricePerMonth,
            newPrice: block.pricePerMonth,
            delta,
            pct,
            status: block.status,
          });
        }
        if (block.pricePerMonth !== "" && newPriceNum > 0) {
          prevSlot.pricePerMonth = block.pricePerMonth;
        }
        prevSlot.hoursUtc = block.hoursUtc;
        prevSlot.models = pool.models || [];
        prevSlot.lastSeenAt = now;
      }

      // 4. Decoupled Price Evaluation: Distinguish Tariff vs Slot Changes
      if (prevPool) {
        const prevMin = parseCleanPrice(prevPool.minPricePerDay);
        const newMin = parseCleanPrice(pool.minPricePerDay);
        const basePriceChanged = prevMin > 0 && newMin > 0 && Math.abs(newMin - prevMin) >= 0.01;

        const totalBlocks = pool.blocks.length;
        const allBlocksChanged = totalBlocks > 0 && stagedSlotPriceChanges.length === totalBlocks;
        const allBlocksHaveSamePrice =
          allBlocksChanged &&
          stagedSlotPriceChanges.every(
            (c) => parseCleanPrice(c.newPrice) === parseCleanPrice(stagedSlotPriceChanges[0].newPrice)
          );

        if (allBlocksHaveSamePrice || (basePriceChanged && stagedSlotPriceChanges.length === 0)) {
          // Case A: True Uniform Base Tariff Change across the entire pool
          const prevPriceStr = allBlocksHaveSamePrice
            ? stagedSlotPriceChanges[0].prevPrice
            : prevPool.minPricePerDay;
          const newPriceStr = allBlocksHaveSamePrice
            ? stagedSlotPriceChanges[0].newPrice
            : pool.minPricePerDay;

          const delta = allBlocksHaveSamePrice
            ? stagedSlotPriceChanges[0].delta
            : cleanDelta(newMin - prevMin);
          const pct = allBlocksHaveSamePrice
            ? stagedSlotPriceChanges[0].pct
            : cleanDelta(prevMin > 0 ? (delta / prevMin) * 100 : 0);

          const basePricePayload = {
            previousMinPrice: prevPriceStr,
            newMinPrice: newPriceStr,
            priceDelta: delta,
            percentageDelta: pct,
          };

          this.catalogHistoryDao?.recordBasePriceUpdate(
            pool.slug,
            pool.modelName,
            pool.models || [],
            basePricePayload
          );

          events.push({
            id: crypto.randomUUID(),
            type: "POOL_BASE_PRICE_CHANGED",
            poolSlug: pool.slug,
            poolName: pool.modelName,
            block: "ALL",
            models: pool.models || [],
            hoursUtc: "",
            previousPrice: prevPriceStr,
            newPrice: newPriceStr,
            timestamp: now,
            basePrice: basePricePayload,
          });
        } else {
          // Case B: Individual Regional Slot Price Changes (Suppress redundant POOL_BASE_PRICE_CHANGED!)
          for (const sp of stagedSlotPriceChanges) {
            const slotPricePayload = {
              block: sp.block,
              hoursUtc: sp.hoursUtc,
              previousPrice: sp.prevPrice,
              newPrice: sp.newPrice,
              priceDelta: sp.delta,
              percentageDelta: sp.pct,
              isDiscount: sp.delta < 0,
            };

            this.catalogHistoryDao?.recordSlotPriceChange(
              pool.slug,
              sp.block,
              sp.prevPrice,
              sp.newPrice,
              sp.delta,
              sp.pct
            );

            events.push({
              id: crypto.randomUUID(),
              type: "SLOT_PRICE_CHANGED",
              poolSlug: pool.slug,
              poolName: pool.modelName,
              block: sp.block,
              models: pool.models || [],
              hoursUtc: sp.hoursUtc,
              previousPrice: sp.prevPrice,
              newPrice: sp.newPrice,
              newStatus: sp.status,
              timestamp: now,
              slotPrice: slotPricePayload,
            });
          }
        }
      }
    }

    // Reconcile and prune vanished pools / slots with K=2 confirmation gate
    for (const [key, slot] of this.inMemorySlots.entries()) {
      if (!incomingSlotKeys.has(key)) {
        const count = (this.pendingDisappearances.get(key) || 0) + 1;
        this.pendingDisappearances.set(key, count);

        if (count >= 2) {
          if (slot.status === "available" || slot.status === "limited") {
            events.push({
              id: crypto.randomUUID(),
              type: "SLOT_DISAPPEARED",
              poolSlug: slot.poolSlug,
              poolName: slot.poolName,
              block: slot.block,
              models: slot.models,
              hoursUtc: slot.hoursUtc,
              previousStatus: slot.status,
              newStatus: "sold-out",
              timestamp: now,
            });

            this.historyDao?.recordSlotClosed(slot.poolSlug, slot.block);
          }
          this.inMemorySlots.delete(key);
          this.pendingDisappearances.delete(key);
        }
      }
    }

    for (const slug of this.inMemoryPools.keys()) {
      if (!incomingPoolSlugs.has(slug)) {
        const count = (this.pendingPoolDisappearances.get(slug) || 0) + 1;
        this.pendingPoolDisappearances.set(slug, count);
        if (count >= 2) {
          this.inMemoryPools.delete(slug);
          this.pendingPoolDisappearances.delete(slug);
        }
      } else {
        this.pendingPoolDisappearances.delete(slug);
      }
    }

    return events;
  }

  private bootstrap(snapshot: PoolsSnapshot): void {
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
          lastSeenAt: Date.now(),
        });
      }
    }
    this.isInitialized = true;
    console.log(
      `✅ [SlotDiffEngine] Bootstrapped baseline with ${this.inMemorySlots.size} slots across ${this.inMemoryPools.size} pools.`
    );
  }
}
