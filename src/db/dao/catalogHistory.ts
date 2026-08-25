import Database from "better-sqlite3";
import { TierUpdatedPayload, PoolBasePricePayload } from "../../types/domain.js";
import { ModelCatalogDiff } from "../../engine/modelSemanticMatcher.js";

export class CatalogHistoryDAO {
  private stmtInsertModelUpgrade: Database.Statement;
  private stmtInsertTierUpdate: Database.Statement;
  private stmtInsertBasePriceUpdate: Database.Statement;
  private stmtInsertSlotPriceHistory: Database.Statement;

  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS catalog_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pool_slug TEXT NOT NULL,
        pool_name TEXT NOT NULL,
        event_type TEXT NOT NULL,
        added_models_json TEXT NOT NULL DEFAULT '[]',
        upgraded_models_json TEXT NOT NULL DEFAULT '[]',
        removed_models_json TEXT NOT NULL DEFAULT '[]',
        all_models_json TEXT NOT NULL,
        previous_min_price TEXT,
        new_min_price TEXT,
        metadata_json TEXT DEFAULT '{}',
        detected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_catalog_hist_slug ON catalog_history(pool_slug, detected_at);

      CREATE TABLE IF NOT EXISTS slot_price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pool_slug TEXT NOT NULL,
        block_id TEXT NOT NULL,
        old_price TEXT NOT NULL,
        new_price TEXT NOT NULL,
        price_delta REAL NOT NULL,
        percent_delta REAL NOT NULL,
        changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_slot_price_hist ON slot_price_history(pool_slug, block_id, changed_at);
    `);

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
  }
}
