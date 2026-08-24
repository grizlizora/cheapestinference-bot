import { DiffEvent, PoolData, PoolsSnapshot } from "../types/domain.js";

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

  /**
   * Process a fresh scrape snapshot and compute real state diff events
   */
  public processSnapshot(snapshot: PoolsSnapshot): DiffEvent[] {
    const now = Date.now();
    const events: DiffEvent[] = [];

    // Cold boot: silently establish baseline
    if (!this.isInitialized) {
      this.bootstrap(snapshot);
      return [];
    }

    const incomingSlotKeys = new Set<string>();

    for (const pool of snapshot.data) {
      const prevPool = this.inMemoryPools.get(pool.slug);

      // Check if models array or pool metadata updated dynamically
      if (prevPool) {
        const prevModels = (prevPool.models || []).slice().sort().join(",");
        const newModels = (pool.models || []).slice().sort().join(",");
        if (prevModels !== newModels || prevPool.modelName !== pool.modelName) {
          events.push({
            id: crypto.randomUUID(),
            type: "CATALOG_UPDATED",
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
      } else {
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

      for (const block of pool.blocks) {
        const key = `${pool.slug}:${block.block}`;
        incomingSlotKeys.add(key);

        const prevSlot = this.inMemorySlots.get(key);

        if (!prevSlot) {
          // New slot block discovered
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

        // Slot already tracked; check transitions
        const wasInStock = prevSlot.status === "available" || prevSlot.status === "limited";
        const isNowInStock = block.status === "available" || block.status === "limited";
        const isNowSoldOut = block.status === "sold-out";

        // Status changed
        if (prevSlot.status !== block.status) {
          if (!wasInStock && isNowInStock) {
            // SLOT_APPEARED: Fast path K=1 (immediate notification)
            this.pendingDisappearances.delete(key);
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
            // SLOT_DISAPPEARED: K=2 confirmation gate to prevent false alarms
            const pendingCount = (this.pendingDisappearances.get(key) || 0) + 1;
            this.pendingDisappearances.set(key, pendingCount);

            if (pendingCount >= 2) {
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
            // limited <-> available
            events.push({
              id: crypto.randomUUID(),
              type: "SLOT_STATUS_CHANGED",
              poolSlug: pool.slug,
              poolName: pool.modelName,
              block: block.block,
              models: pool.models || [],
              hoursUtc: block.hoursUtc,
              previousStatus: prevSlot.status,
              newStatus: block.status,
              newPrice: block.pricePerMonth,
              timestamp: now,
            });
            prevSlot.status = block.status;
          }
        } else {
          // Status same, reset pending disappearance
          this.pendingDisappearances.delete(key);
        }

        // Price change
        if (prevSlot.pricePerMonth !== block.pricePerMonth) {
          events.push({
            id: crypto.randomUUID(),
            type: "PRICE_CHANGED",
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
          prevSlot.pricePerMonth = block.pricePerMonth;
        }

        // Always update metadata
        prevSlot.models = pool.models || [];
        prevSlot.poolName = pool.modelName;
        prevSlot.hoursUtc = block.hoursUtc;
        prevSlot.lastSeenAt = now;
      }
    }

    // Reconcile decommissioned / removed slots
    for (const [key, slot] of this.inMemorySlots.entries()) {
      if (!incomingSlotKeys.has(key)) {
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
            previousPrice: slot.pricePerMonth,
            newPrice: slot.pricePerMonth,
            timestamp: now,
          });
        }
        this.inMemorySlots.delete(key);
        this.pendingDisappearances.delete(key);
      }
    }

    return events;
  }

  private bootstrap(snapshot: PoolsSnapshot): void {
    const now = Date.now();
    this.inMemorySlots.clear();
    this.inMemoryPools.clear();
    this.pendingDisappearances.clear();

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
    console.log(`✅ [SlotDiffEngine] Bootstrapped baseline with ${this.inMemorySlots.size} slots across ${this.inMemoryPools.size} pools.`);
  }
}
