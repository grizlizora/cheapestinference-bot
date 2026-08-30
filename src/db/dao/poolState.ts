import Database from "better-sqlite3";
import { PoolStateRecord } from "../../types/db.js";
import { PoolData, PoolsSnapshot, isSlotAvailable } from "../../types/domain.js";
import { tursoCloudSync } from "../tursoSync.js";

export class PoolStateDAO {
  private stmtGetBySlugAndBlock: Database.Statement;
  private stmtGetAll: Database.Statement;
  private stmtGetBySlug: Database.Statement;
  private stmtUpsert: Database.Statement;
  private stmtDeleteMissing: Database.Statement;
  private stmtUpsertMeta: Database.Statement;
  private stmtGetMeta: Database.Statement;
  private txSaveSnapshot: (pools: PoolData[]) => void;

  constructor(private db: Database.Database) {
    this.stmtGetBySlugAndBlock = db.prepare(`
      SELECT * FROM pool_state WHERE pool_slug = ? AND block_id = ?
    `);
    this.stmtGetAll = db.prepare(`
      SELECT * FROM pool_state ORDER BY id ASC
    `);
    this.stmtGetBySlug = db.prepare(`
      SELECT * FROM pool_state WHERE pool_slug = ? ORDER BY id ASC
    `);
    this.stmtDeleteMissing = db.prepare(`
      DELETE FROM pool_state WHERE pool_slug NOT IN (SELECT value FROM json_each(?))
    `);
    this.stmtUpsert = db.prepare(`
      INSERT INTO pool_state (
        pool_slug, pool_name, models_json, block_id, status, 
        hours_utc, price_month, min_price_day, annual_discount, description,
        infra_spec, manual_provisioning,
        last_changed_at, updated_at
      ) VALUES (
        @pool_slug, @pool_name, @models_json, @block_id, @status,
        @hours_utc, @price_month, @min_price_day, @annual_discount, @description,
        @infra_spec, @manual_provisioning,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      ON CONFLICT(pool_slug, block_id) DO UPDATE SET
        pool_name = excluded.pool_name,
        models_json = excluded.models_json,
        status = excluded.status,
        hours_utc = excluded.hours_utc,
        price_month = excluded.price_month,
        min_price_day = excluded.min_price_day,
        annual_discount = excluded.annual_discount,
        description = excluded.description,
        infra_spec = excluded.infra_spec,
        manual_provisioning = excluded.manual_provisioning,
        last_changed_at = CASE WHEN pool_state.status != excluded.status THEN CURRENT_TIMESTAMP ELSE pool_state.last_changed_at END,
        updated_at = CURRENT_TIMESTAMP
    `);

    this.stmtUpsertMeta = db.prepare(`
      INSERT INTO system_metadata (key, value, updated_at)
      VALUES (@key, @value, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `);

    this.stmtGetMeta = db.prepare(`
      SELECT value, updated_at FROM system_metadata WHERE key = ?
    `);

    this.txSaveSnapshot = this.db.transaction((pools: PoolData[]) => {
      if (!pools || pools.length === 0) return;
      const validSlugs = pools.map((p) => p.slug);
      this.stmtDeleteMissing.run(JSON.stringify(validSlugs));
      for (const pool of pools) {
        for (const block of pool.blocks) {
          this.stmtUpsert.run({
            pool_slug: pool.slug,
            pool_name: pool.modelName,
            models_json: JSON.stringify(pool.models || []),
            block_id: block.block,
            status: block.status,
            hours_utc: block.hoursUtc,
            price_month: block.pricePerMonth,
            min_price_day: pool.minPricePerDay || "0.00",
            annual_discount: typeof pool.annualDiscount === "number" ? pool.annualDiscount : 0.15,
            description: pool.description || "",
            infra_spec: pool.infraSpec || "",
            manual_provisioning: pool.manualProvisioning ? 1 : 0,
          });

          tursoCloudSync.pushMutation(
            `INSERT INTO pool_state (
              pool_slug, pool_name, models_json, block_id, status, 
              hours_utc, price_month, min_price_day, annual_discount, description,
              infra_spec, manual_provisioning, last_changed_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(pool_slug, block_id) DO UPDATE SET
              pool_name = excluded.pool_name,
              models_json = excluded.models_json,
              status = excluded.status,
              hours_utc = excluded.hours_utc,
              price_month = excluded.price_month,
              min_price_day = excluded.min_price_day,
              annual_discount = excluded.annual_discount,
              description = excluded.description,
              infra_spec = excluded.infra_spec,
              manual_provisioning = excluded.manual_provisioning,
              last_changed_at = CASE WHEN pool_state.status != excluded.status THEN CURRENT_TIMESTAMP ELSE pool_state.last_changed_at END,
              updated_at = CURRENT_TIMESTAMP`,
            [
              pool.slug,
              pool.modelName,
              JSON.stringify(pool.models || []),
              block.block,
              block.status,
              block.hoursUtc,
              block.pricePerMonth,
              pool.minPricePerDay || "0.00",
              typeof pool.annualDiscount === "number" ? pool.annualDiscount : 0.15,
              pool.description || "",
              pool.infraSpec || "",
              pool.manualProvisioning ? 1 : 0,
            ]
          );
        }
      }
    });
  }

  getSlot(poolSlug: string, blockId: string): PoolStateRecord | undefined {
    return this.stmtGetBySlugAndBlock.get(poolSlug, blockId) as PoolStateRecord | undefined;
  }

  getAll(): PoolStateRecord[] {
    return this.stmtGetAll.all() as PoolStateRecord[];
  }

  getPoolBlocks(poolSlug: string): PoolStateRecord[] {
    return this.stmtGetBySlug.all(poolSlug) as PoolStateRecord[];
  }

  touchVerified(source = "cache_304", latencyMs = 0): void {
    const meta = {
      timestamp: Date.now(),
      source,
      latencyMs,
    };
    this.stmtUpsertMeta.run({
      key: "last_verified",
      value: JSON.stringify(meta),
    });
  }

  getLastVerified(): { timestamp: number; source: string; latencyMs: number } | null {
    const row = this.stmtGetMeta.get("last_verified") as { value: string; updated_at: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  saveSnapshot(snapshot: PoolsSnapshot | PoolData[], source = "api", latencyMs = 0): void {
    const pools = Array.isArray(snapshot) ? snapshot : (snapshot?.data ?? []);
    this.txSaveSnapshot(pools);
    this.touchVerified(source, latencyMs);
  }

  getPoolSummaries(): Array<{
    slug: string;
    name: string;
    fullName: string;
    description: string;
    models: string[];
    min_price: string;
    available_count: number;
    total_blocks: number;
    blocks: Array<{ block: string; status: string; price: string; hours: string }>;
  }> {
    const all = this.getAll();
    const grouped = new Map<string, PoolStateRecord[]>();

    for (const record of all) {
      const list = grouped.get(record.pool_slug) || [];
      list.push(record);
      grouped.set(record.pool_slug, list);
    }

    const summaries: Array<any> = [];

    for (const [slug, records] of grouped.entries()) {
      const first = records[0];
      let models: string[] = [];
      try {
        models = JSON.parse(first.models_json);
      } catch {
        models = [];
      }

      const availableCount = records.filter(
        (r) => isSlotAvailable(r.status)
      ).length;

      // Lowest block price
      const parseNum = (v: string) => parseFloat(String(v).replace(/[^0-9.-]/g, "")) || 0;
      const prices = records.map((r) => parseNum(r.price_month)).filter((p) => p > 0);
      const minPrice = prices.length > 0 ? Math.min(...prices).toFixed(2) : "0.00";

      summaries.push({
        slug,
        name: first.pool_name.split("—")[0].trim() || slug.toUpperCase(),
        fullName: first.pool_name,
        description: first.description,
        models,
        min_price: minPrice,
        available_count: availableCount,
        total_blocks: records.length,
        blocks: records.map((r) => ({
          block: r.block_id,
          status: r.status,
          price: r.price_month,
          hours: r.hours_utc,
        })),
      });
    }

    return summaries;
  }
}
