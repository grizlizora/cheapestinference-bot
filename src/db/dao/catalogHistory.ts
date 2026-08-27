import Database from "better-sqlite3";
import { TierUpdatedPayload, PoolBasePricePayload } from "../../types/domain.js";
import { ModelCatalogDiff } from "../../engine/modelSemanticMatcher.js";
import { tursoCloudSync } from "../tursoSync.js";

export class CatalogHistoryDAO {
  private stmtInsertModelUpgrade: Database.Statement;
  private stmtInsertTierUpdate: Database.Statement;
  private stmtInsertBasePriceUpdate: Database.Statement;
  private stmtInsertSlotPriceHistory: Database.Statement;

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
        pool_slug, block_id, old_price, new_price, price_delta, percent_delta, changed_at
      ) VALUES (
        @pool_slug, @block_id, @old_price, @new_price, @price_delta, @percent_delta, CURRENT_TIMESTAMP
      )
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
        pool_slug, pool_name, event_type, added_models_json, 
        upgraded_models_json, removed_models_json, all_models_json, detected_at
      ) VALUES (?, ?, 'MODEL_UPGRADE', ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        diff.poolSlug,
        diff.poolName,
        JSON.stringify(diff.added),
        JSON.stringify(diff.upgraded),
        JSON.stringify(diff.removed),
        JSON.stringify(diff.currentModels),
      ]
    );
  }

  public recordTierUpdate(
    poolSlug: string,
    poolName: string,
    models: string[],
    payload: TierUpdatedPayload
  ): void {
    this.stmtInsertTierUpdate.run({
      pool_slug: poolSlug,
      pool_name: poolName,
      all_models: JSON.stringify(models),
      metadata: JSON.stringify(payload),
    });
    tursoCloudSync.pushMutation(
      `INSERT INTO catalog_history (
        pool_slug, pool_name, event_type, all_models_json, metadata_json, detected_at
      ) VALUES (?, ?, 'TIER_UPDATE', ?, ?, CURRENT_TIMESTAMP)`,
      [poolSlug, poolName, JSON.stringify(models), JSON.stringify(payload)]
    );
  }

  public recordBasePriceUpdate(
    poolSlug: string,
    poolName: string,
    models: string[],
    payload: PoolBasePricePayload
  ): void {
    this.stmtInsertBasePriceUpdate.run({
      pool_slug: poolSlug,
      pool_name: poolName,
      all_models: JSON.stringify(models),
      old_price: payload.previousMinPrice,
      new_price: payload.newMinPrice,
      metadata: JSON.stringify(payload),
    });
    tursoCloudSync.pushMutation(
      `INSERT INTO catalog_history (
        pool_slug, pool_name, event_type, all_models_json,
        previous_min_price, new_min_price, metadata_json, detected_at
      ) VALUES (?, ?, 'BASE_PRICE', ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        poolSlug,
        poolName,
        JSON.stringify(models),
        payload.previousMinPrice,
        payload.newMinPrice,
        JSON.stringify(payload),
      ]
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
    this.stmtInsertSlotPriceHistory.run({
      pool_slug: poolSlug,
      block_id: blockId,
      old_price: oldPrice,
      new_price: newPrice,
      price_delta: priceDelta,
      percent_delta: percentDelta,
    });
    tursoCloudSync.pushMutation(
      `INSERT INTO slot_price_history (
        pool_slug, block_id, old_price, new_price, price_delta, percent_delta, changed_at
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [poolSlug, blockId, oldPrice, newPrice, priceDelta, percentDelta]
    );
  }
}
