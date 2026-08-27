/**
 * src/engine/diffEngine.ts
 * High-Performance Slot & Catalog Diffing Coordinator
 */

import {
  DiffEvent,
  PoolsSnapshot,
  DropPatternType,
  DemandCategory,
  DropClassification,
} from "../types/domain.js";
import { SlotHistoryDAO } from "../db/dao/slotHistory.js";
import { CatalogHistoryDAO } from "../db/dao/catalogHistory.js";
import { ModelSemanticMatcher } from "./modelSemanticMatcher.js";
import { PredictiveAnalyticsEngine } from "./predictiveEngine.js";
import { SlotStateTracker, DaoBootstrapRecord } from "./slotStateTracker.js";
import { PriceDiffEvaluator } from "./priceDiffEvaluator.js";

export { PriceDiffEvaluator };
export { SlotStateTracker };
export type { DaoBootstrapRecord };

export class SlotDiffEngine {
  private readonly stateTracker: SlotStateTracker;
  private readonly predictiveEngine?: PredictiveAnalyticsEngine;

  constructor(
    private readonly historyDao?: SlotHistoryDAO,
    private readonly catalogHistoryDao?: CatalogHistoryDAO
  ) {
    this.stateTracker = new SlotStateTracker();
    if (historyDao) {
      this.predictiveEngine = new PredictiveAnalyticsEngine(historyDao);
    }
  }

  public isReady(): boolean {
    return this.stateTracker.isReady();
  }

  public getSnapshot(): PoolsSnapshot | null {
    return this.stateTracker.getSnapshot();
  }

  public bootstrapFromDao(records: DaoBootstrapRecord[]): void {
    this.stateTracker.bootstrapFromDao(records);
  }

  public processSnapshot(snapshot: PoolsSnapshot): DiffEvent[] {
    const now = Date.now();
    const events: DiffEvent[] = [];

    if (!this.stateTracker.isReady()) {
      this.stateTracker.bootstrap(snapshot);
      return [];
    }

    // 1. Catalog Diffing & Tier Metadata Matching
    for (const pool of snapshot.data) {
      const prevPool = this.stateTracker.getPool(pool.slug);

      if (prevPool) {
        // 1a. Model Catalog Semantic Diffing
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

        // 1b. Tier Terms & Metadata Diffing
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
    }

    // 2. Slot Lifecycle Sync & Price Change Staging
    const syncResult = this.stateTracker.syncSnapshotSlots(
      snapshot,
      this.historyDao,
      this.predictiveEngine,
      now
    );
    events.push(...syncResult.events);

    // 3. Decoupled Price Evaluation (Tariff vs Regional Slot)
    for (const pool of snapshot.data) {
      const prevPool = this.stateTracker.getPool(pool.slug);
      if (prevPool) {
        const stagedChanges = syncResult.stagedPriceChanges.get(pool.slug) || [];
        const priceResult = PriceDiffEvaluator.evaluatePriceDiffs(
          pool,
          prevPool,
          stagedChanges,
          this.catalogHistoryDao,
          now
        );
        events.push(...priceResult.events);
      }
      this.stateTracker.setPool(pool.slug, pool);
    }

    // 4. Missing Slots & Pools Reconciler (K=2 Noise Gate)
    const missingEvents = this.stateTracker.reconcileMissingEntities(
      syncResult.incomingSlotKeys,
      syncResult.incomingPoolSlugs,
      this.historyDao,
      now
    );
    events.push(...missingEvents);

    // 5. Predictive Analytics & Drop Pattern Classification Enrichment
    this.enrichAppearedEvents(events);

    return events;
  }

  private enrichAppearedEvents(events: DiffEvent[]): void {
    const appearedEvents = events.filter((e) => e.type === "SLOT_APPEARED");
    if (appearedEvents.length === 0) return;

    const totalAppearedCount = appearedEvents.length;
    const isGlobalBatchDrop = totalAppearedCount >= 2;

    const poolAppearedMap = new Map<string, number>();
    for (const e of appearedEvents) {
      poolAppearedMap.set(e.poolSlug, (poolAppearedMap.get(e.poolSlug) || 0) + 1);
    }

    const hasCatalogMutation = events.some(
      (e) =>
        e.type === "MODEL_UPGRADE_EVENT" ||
        e.type === "POOL_BASE_PRICE_CHANGED" ||
        e.type === "TIER_UPDATED_EVENT"
    );

    for (const event of appearedEvents) {
      const poolAppearedCount = poolAppearedMap.get(event.poolSlug) || 0;
      const effectiveCluster = Math.max(totalAppearedCount, poolAppearedCount);

      let dropClassification: DropClassification | undefined;
      if (this.predictiveEngine) {
        dropClassification = this.predictiveEngine.classifyDrop(
          event.poolSlug,
          event.block,
          event.timestamp,
          effectiveCluster,
          hasCatalogMutation
        );
      }

      const isBatchDrop = dropClassification
        ? dropClassification.dropType === "BATCH_CAPACITY_EXPANSION"
        : isGlobalBatchDrop || poolAppearedCount >= 2;

      const dropPattern: DropPatternType = isBatchDrop ? "BATCH_DROP" : "SINGLE_SLOT_RELEASE";

      let avgLifespanFormatted = "";
      let demandCategory: DemandCategory = "unknown";
      let avgLifespanSeconds: number | null = null;
      let totalOpenings = 0;
      let lastOpenedAt: string | null = null;

      if (this.historyDao) {
        const analytics = this.historyDao.getBlockPredictiveAnalytics(
          event.poolSlug,
          event.block
        );
        avgLifespanFormatted = analytics.avgDurationFormatted;
        demandCategory = analytics.demandCategory;
        avgLifespanSeconds = analytics.avgDurationSeconds;
        totalOpenings = analytics.totalOpenings;
        lastOpenedAt = analytics.lastOpenedAt;
      }

      event.analytics = {
        avgLifespanFormatted,
        avgLifespanSeconds,
        demandCategory,
        isBatchDrop,
        dropPattern,
        totalOpenings,
        lastOpenedAt,
        dropClassification,
      };
    }
  }
}
