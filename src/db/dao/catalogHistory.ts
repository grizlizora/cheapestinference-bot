import Database from "better-sqlite3";
import { TierUpdatedPayload, PoolBasePricePayload, PriceAnalyticsPayload, PriceRating } from "../../types/domain.js";
import { ModelCatalogDiff } from "../../engine/modelSemanticMatcher.js";
import { tursoCloudSync } from "../tursoSync.js";

export class CatalogHistoryDAO {
  private stmtInsertModelUpgrade: Database.Statement;
  private stmtInsertTierUpdate: Database.Statement;
  private stmtInsertBasePriceUpdate: Database.Statement;
  private stmtInsertSlotPriceHistory: Database.Statement;
  private stmtGetBlockPriceAnalytics: Database.Statement;
  private stmtGetPoolPriceAnalytics: Database.Statement;

  constructor(private db: Database.Database) {
    this.stmtInsertModelUpgrade = db.prepare(`
      INSERT INTO catalog_history (
        pool_slug, pool_name, event_type, added_models_json, 
        upgraded_models_json, removed_models_json, all_models_json, detected_at
      ) VALUES (
        @pool_slug, @pool_name, 'MODEL_UPGRADE', @added,
        @upgraded, @removed, @all_models, CURRENT_TIMESTAMP
      )
    `);

    this.stmtInsertTierUpdate = db.prepare(`
      INSERT INTO catalog_history (
        pool_slug, pool_name, event_type, all_models_json, metadata_json, detected_at
      ) VALUES (
        @pool_slug, @pool_name, 'TIER_UPDATE', @all_models, @metadata, CURRENT_TIMESTAMP
      )
    `);

    this.stmtInsertBasePriceUpdate = db.prepare(`
      INSERT INTO catalog_history (
        pool_slug, pool_name, event_type, all_models_json,
        previous_min_price, new_min_price, metadata_json, detected_at
      ) VALUES (
        @pool_slug, @pool_name, 'BASE_PRICE', @all_models,
        @old_price, @new_price, @metadata, CURRENT_TIMESTAMP
      )
    `);

    this.stmtInsertSlotPriceHistory = db.prepare(`
      INSERT INTO slot_price_history (
        pool_slug, block_id, old_price, new_price, new_price_num, price_delta, percent_delta, changed_at
      ) VALUES (
        @pool_slug, @block_id, @old_price, @new_price, @new_price_num, @price_delta, @percent_delta, CURRENT_TIMESTAMP
      )
    `);

    this.stmtGetBlockPriceAnalytics = db.prepare(`
      SELECT 
        COUNT(*) as count,
        MIN(CASE WHEN new_price_num > 0 THEN new_price_num ELSE CAST(REPLACE(REPLACE(new_price, '$', ''), ',', '') AS REAL) END) as min_p,
        MAX(CASE WHEN new_price_num > 0 THEN new_price_num ELSE CAST(REPLACE(REPLACE(new_price, '$', ''), ',', '') AS REAL) END) as max_p,
        AVG(CASE WHEN new_price_num > 0 THEN new_price_num ELSE CAST(REPLACE(REPLACE(new_price, '$', ''), ',', '') AS REAL) END) as avg_p
      FROM slot_price_history
      WHERE pool_slug = ? AND block_id = ? AND (new_price_num > 0 OR new_price != '')
    `);

    this.stmtGetPoolPriceAnalytics = db.prepare(`
      SELECT 
        COUNT(*) as count,
        MIN(CASE WHEN new_price_num > 0 THEN new_price_num ELSE CAST(REPLACE(REPLACE(new_price, '$', ''), ',', '') AS REAL) END) as min_p,
        MAX(CASE WHEN new_price_num > 0 THEN new_price_num ELSE CAST(REPLACE(REPLACE(new_price, '$', ''), ',', '') AS REAL) END) as max_p,
        AVG(CASE WHEN new_price_num > 0 THEN new_price_num ELSE CAST(REPLACE(REPLACE(new_price, '$', ''), ',', '') AS REAL) END) as avg_p
      FROM slot_price_history
      WHERE pool_slug = ? AND (new_price_num > 0 OR new_price != '')
    `);
  }

  public recordModelUpgrade(diff: ModelCatalogDiff): void {
    this.stmtInsertModelUpgrade.run({
      pool_slug: diff.poolSlug,
      pool_name: diff.poolName,
      added: JSON.stringify(diff.added),
      upgraded: JSON.stringify(diff.upgraded),
      removed: JSON.stringify(diff.removed),
      all_models: JSON.stringify(diff.currentModels),
    });
    tursoCloudSync.pushMutation(
      `INSERT INTO catalog_history (
        pool_slug, pool_name, event_type, added_models_json, upgraded_models_json, removed_models_json, all_models_json, detected_at
      ) VALUES (?, ?, 'MODEL_UPGRADE', ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        diff.poolSlug,
        diff.poolName,
        JSON.stringify(diff.added),
        JSON.stringify(diff.upgraded),
        JSON.stringify(diff.removed),
        JSON.stringify(diff.currentModels),
      ],
      true
    );
  }

  public recordTierUpdate(poolSlug: string, poolName: string, allModels: string[], payload: TierUpdatedPayload): void {
    this.stmtInsertTierUpdate.run({
      pool_slug: poolSlug,
      pool_name: poolName,
      all_models: JSON.stringify(allModels),
      metadata: JSON.stringify({
        previousDescription: payload.previousDescription,
        newDescription: payload.newDescription,
        previousAnnualDiscount: payload.previousAnnualDiscount,
        newAnnualDiscount: payload.newAnnualDiscount,
        previousInfraSpec: payload.previousInfraSpec,
        newInfraSpec: payload.newInfraSpec,
        previousManualProvisioning: payload.previousManualProvisioning,
        newManualProvisioning: payload.newManualProvisioning,
      }),
    });
    tursoCloudSync.pushMutation(
      `INSERT INTO catalog_history (
        pool_slug, pool_name, event_type, all_models_json, metadata_json, detected_at
      ) VALUES (?, ?, 'TIER_UPDATE', ?, ?, CURRENT_TIMESTAMP)`,
      [
        poolSlug,
        poolName,
        JSON.stringify(allModels),
        JSON.stringify({
          previousDescription: payload.previousDescription,
          newDescription: payload.newDescription,
          previousAnnualDiscount: payload.previousAnnualDiscount,
          newAnnualDiscount: payload.newAnnualDiscount,
          previousInfraSpec: payload.previousInfraSpec,
          newInfraSpec: payload.newInfraSpec,
          previousManualProvisioning: payload.previousManualProvisioning,
          newManualProvisioning: payload.newManualProvisioning,
        }),
      ],
      true
    );
  }

  public recordBasePriceUpdate(poolSlug: string, poolName: string, allModels: string[], payload: PoolBasePricePayload): void {
    const isDiscount = payload.priceDelta < 0;
    this.stmtInsertBasePriceUpdate.run({
      pool_slug: poolSlug,
      pool_name: poolName,
      all_models: JSON.stringify(allModels),
      old_price: payload.previousMinPrice,
      new_price: payload.newMinPrice,
      metadata: JSON.stringify({
        priceDelta: payload.priceDelta,
        percentageDelta: payload.percentageDelta,
        isDiscount,
      }),
    });
    tursoCloudSync.pushMutation(
      `INSERT INTO catalog_history (
        pool_slug, pool_name, event_type, all_models_json, previous_min_price, new_min_price, metadata_json, detected_at
      ) VALUES (?, ?, 'BASE_PRICE', ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        poolSlug,
        poolName,
        JSON.stringify(allModels),
        payload.previousMinPrice,
        payload.newMinPrice,
        JSON.stringify({
          priceDelta: payload.priceDelta,
          percentageDelta: payload.percentageDelta,
          isDiscount,
        }),
      ],
      true
    );
  }

  public recordSlotPriceChange(
    poolSlug: string,
    blockId: string,
    oldPrice: string,
    newPrice: string,
    priceDelta: number,
    percentDelta: number
  ): void {
    const parseNum = (v: string) => parseFloat(String(v).replace(/[^0-9.-]/g, "")) || 0;
    const newPriceNum = parseNum(newPrice);

    this.stmtInsertSlotPriceHistory.run({
      pool_slug: poolSlug,
      block_id: blockId,
      old_price: oldPrice,
      new_price: newPrice,
      new_price_num: newPriceNum,
      price_delta: priceDelta,
      percent_delta: percentDelta,
    });
    tursoCloudSync.pushMutation(
      `INSERT INTO slot_price_history (
        pool_slug, block_id, old_price, new_price, new_price_num, price_delta, percent_delta, changed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [poolSlug, blockId, oldPrice, newPrice, newPriceNum, priceDelta, percentDelta],
      true
    );
  }

  /**
   * Computes historical price benchmarks (min, max, avg) and rates the current price
   * with sample size gating (requires >= 3 records).
   */
  public getPriceAnalytics(poolSlug: string, blockId?: string, currentPrice?: number): PriceAnalyticsPayload {
    let row: any;
    if (blockId && blockId !== "ALL") {
      row = this.stmtGetBlockPriceAnalytics.get(poolSlug, blockId);
    } else {
      row = this.stmtGetPoolPriceAnalytics.get(poolSlug);
    }

    const count = Number(row?.count || 0);
    const minP = row?.min_p != null ? Math.round(Number(row.min_p) * 100) / 100 : null;
    const maxP = row?.max_p != null ? Math.round(Number(row.max_p) * 100) / 100 : null;
    const avgP = row?.avg_p != null ? Math.round(Number(row.avg_p) * 100) / 100 : null;

    if (count < 3 || currentPrice == null || isNaN(currentPrice) || avgP == null) {
      return {
        rating: "insufficient_data",
        minPrice: minP,
        avgPrice: avgP,
        maxPrice: maxP,
        sampleCount: count,
      };
    }

    let rating: PriceRating = "fair";
    if (minP !== null && currentPrice <= minP) {
      rating = "all_time_low";
    } else if (currentPrice < avgP * 0.95) {
      rating = "below_average";
    } else if (currentPrice > avgP * 1.05) {
      rating = "above_average";
    }

    return {
      rating,
      minPrice: minP,
      avgPrice: avgP,
      maxPrice: maxP,
      sampleCount: count,
    };
  }
}
