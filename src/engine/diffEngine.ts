import { DiffEvent, PoolData, PoolsSnapshot } from "../types/domain.js";
import { SlotHistoryDAO } from "../db/dao/slotHistory.js";
import { CatalogHistoryDAO } from "../db/dao/catalogHistory.js";
import { ModelSemanticMatcher } from "./modelSemanticMatcher.js";

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

        // 2. Pool Base Price Diffing
        const prevMin = parseFloat(prevPool.minPricePerDay || "0");
        const newMin = parseFloat(pool.minPricePerDay || "0");
        if (!isNaN(prevMin) && !isNaN(newMin) && Math.abs(prevMin - newMin) > 0.01) {
          const delta = newMin - prevMin;
          const pct = prevMin > 0 ? (delta / prevMin) * 100 : 0;
          const basePricePayload = {
            previousMinPrice: prevPool.minPricePerDay,
            newMinPrice: pool.minPricePerDay,
            priceDelta: parseFloat(delta.toFixed(2)),
            percentageDelta: parseFloat(pct.toFixed(2)),
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
            previousPrice: prevPool.minPricePerDay,
            newPrice: pool.minPricePerDay,
            timestamp: now,
            basePrice: basePricePayload,
          });
        }

        // 3. Tier Terms & Metadata Diffing
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

      // 4. Regional Slot Block Diffing
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

        // 5. Regional Slot Price Changed (SLOT_PRICE_CHANGED)
        const oldPriceNum = parseFloat(prevSlot.pricePerMonth || "0");
        const newPriceNum = parseFloat(block.pricePerMonth || "0");
        if (
          prevSlot.pricePerMonth !== block.pricePerMonth &&
          block.pricePerMonth !== "" &&
          block.pricePerMonth !== "0" &&
          !isNaN(oldPriceNum) &&
          !isNaN(newPriceNum)
        ) {
          const delta = newPriceNum - oldPriceNum;
          const pct = oldPriceNum > 0 ? (delta / oldPriceNum) * 100 : 0;
          const slotPricePayload = {
            block: block.block,
            hoursUtc: block.hoursUtc,
            previousPrice: prevSlot.pricePerMonth,
            newPrice: block.pricePerMonth,
            priceDelta: parseFloat(delta.toFixed(2)),
            percentageDelta: parseFloat(pct.toFixed(2)),
            isDiscount: delta < 0,
          };

          this.catalogHistoryDao?.recordSlotPriceChange(
            pool.slug,
            block.block,
            prevSlot.pricePerMonth,
            block.pricePerMonth,
            slotPricePayload.priceDelta,
            slotPricePayload.percentageDelta
          );

          events.push({
            id: crypto.randomUUID(),
            type: "SLOT_PRICE_CHANGED",
            poolSlug: pool.slug,
            poolName: pool.modelName,
            block: block.block,
            models: pool.models || [],
            hoursUtc: block.hoursUtc,
            previousPrice: prevSlot.pricePerMonth,
            newPrice: block.pricePerMonth,
            newStatus: block.status,
            timestamp: now,
            slotPrice: slotPricePayload,
          });
          prevSlot.pricePerMonth = block.pricePerMonth;
        }

        prevSlot.hoursUtc = block.hoursUtc;
        prevSlot.models = pool.models || [];
        prevSlot.lastSeenAt = now;
      }
    }

    // Reconcile and prune vanished pools / slots with K=2 confirmation gate
    for (const [key, slot] of this.inMemorySlots.entries()) {
      if (!incomingSlotKeys.has(key)) {
        if (slot.status === "available" || slot.status === "limited") {
          const count = (this.pendingDisappearances.get(key) || 0) + 1;
          this.pendingDisappearances.set(key, count);

          if (count >= 2) {
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
            this.inMemorySlots.delete(key);
            this.pendingDisappearances.delete(key);
          }
        } else {
          this.inMemorySlots.delete(key);
          this.pendingDisappearances.delete(key);
        }
      }
    }

    for (const slug of this.inMemoryPools.keys()) {
      if (!incomingPoolSlugs.has(slug)) {
        this.inMemoryPools.delete(slug);
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
