/**
 * src/db/sync/tursoHydrator.ts
 * Zero-Allocation Cold-Boot SQLite Hydration Engine (All 8 Tables)
 */

import Database from "better-sqlite3";
import { RemoteSchemaManager } from "./remoteSchema.js";

export class TursoHydrator {
  constructor(
    private executePipeline: (requests: Array<{ type: string; stmt: { sql: string; args?: any[] } }>, timeoutMs?: number) => Promise<any[]>,
    private isEnabled: () => boolean,
    private schemaManager: RemoteSchemaManager
  ) {}

  /**
   * Pulls latest state from Turso Cloud and populates local SQLite on cold boot
   */
  public async pullStateFromTurso(db: Database.Database): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      console.log("☁️ [TursoSync] Pulling state from Turso Cloud...");
      const startTime = performance.now();

      await this.schemaManager.initRemoteSchema();

      const results = await this.executePipeline(
        [
          { type: "execute", stmt: { sql: "SELECT * FROM users" } },
          { type: "execute", stmt: { sql: "SELECT * FROM subscriptions" } },
          { type: "execute", stmt: { sql: "SELECT * FROM donations" } },
          { type: "execute", stmt: { sql: "SELECT * FROM pool_state" } },
          { type: "execute", stmt: { sql: "SELECT * FROM active_dashboards" } },
          { type: "execute", stmt: { sql: "SELECT * FROM slot_lifecycle_history" } },
          { type: "execute", stmt: { sql: "SELECT * FROM slot_price_history" } },
          { type: "execute", stmt: { sql: "SELECT * FROM catalog_history" } },
        ],
        15_000
      );

      const usersResult = results[0]?.response?.result;
      const subsResult = results[1]?.response?.result;
      const donResult = results[2]?.response?.result;
      const poolResult = results[3]?.response?.result;
      const dashResult = results[4]?.response?.result;
      const lifeResult = results[5]?.response?.result;
      const priceResult = results[6]?.response?.result;
      const catResult = results[7]?.response?.result;

      let userCount = 0;
      let subCount = 0;
      let donCount = 0;
      let poolCount = 0;
      let dashCount = 0;
      let lifeCount = 0;
      let priceCount = 0;
      let catCount = 0;

      const extractRows = (result: any) => {
        if (!result || !result.rows || !result.cols) return [];
        const cols: string[] = result.cols.map((c: any) => c.name);
        return result.rows.map((row: any[]) => {
          const obj: Record<string, any> = {};
          cols.forEach((colName, idx) => {
            obj[colName] = row[idx]?.value !== undefined ? row[idx].value : null;
          });
          return obj;
        });
      };

      const toNullableNum = (val: any) => {
        if (val === null || val === undefined || val === "") return null;
        const n = Number(val);
        return Number.isFinite(n) ? n : null;
      };

      const toNum = (val: any, fallback = 0) => {
        if (val === null || val === undefined || val === "") return fallback;
        const n = Number(val);
        return Number.isFinite(n) ? n : fallback;
      };

      // Perform atomic insertion into local SQLite inside transaction
      db.transaction(() => {
        // 1. Users
        if (usersResult && usersResult.rows?.length > 0) {
          const insertUser = db.prepare(`
            INSERT OR REPLACE INTO users (
              id, telegram_id, username, first_name, language, is_muted, is_active,
              notify_available_global, notify_sold_out_global, notify_models_global, notify_prices_global,
              notify_admin_new_users, is_admin, total_donated_stars, last_active_at, created_at, updated_at
            ) VALUES (
              @id, @telegram_id, @username, @first_name, @language, @is_muted, @is_active,
              @notify_available_global, @notify_sold_out_global, @notify_models_global, @notify_prices_global,
              @notify_admin_new_users, @is_admin, @total_donated_stars, @last_active_at, @created_at, @updated_at
            )
          `);

          const userObjects = extractRows(usersResult);
          for (const u of userObjects) {
            insertUser.run({
              id: toNum(u.id),
              telegram_id: toNum(u.telegram_id),
              username: u.username ?? null,
              first_name: u.first_name ?? null,
              language: u.language ?? "en",
              is_muted: toNum(u.is_muted, 0),
              is_active: toNum(u.is_active, 1),
              notify_available_global: toNum(u.notify_available_global, 1),
              notify_sold_out_global: toNum(u.notify_sold_out_global, 0),
              notify_models_global: toNum(u.notify_models_global, 1),
              notify_prices_global: toNum(u.notify_prices_global, 1),
              notify_admin_new_users: toNum(u.notify_admin_new_users, 1),
              is_admin: toNum(u.is_admin, 0),
              total_donated_stars: toNum(u.total_donated_stars, 0),
              last_active_at: u.last_active_at ?? new Date().toISOString(),
              created_at: u.created_at ?? new Date().toISOString(),
              updated_at: u.updated_at ?? new Date().toISOString(),
            });
            userCount++;
          }
        }

        // 2. Subscriptions
        if (subsResult && subsResult.rows?.length > 0) {
          const insertSub = db.prepare(`
            INSERT OR REPLACE INTO subscriptions (
              id, user_id, pool_slug, block_id, notify_on_available, notify_on_sold_out,
              notify_on_models, notify_on_prices, created_at, updated_at
            ) VALUES (
              @id, @user_id, @pool_slug, @block_id, @notify_on_available, @notify_on_sold_out,
              @notify_on_models, @notify_on_prices, @created_at, @updated_at
            )
          `);

          const subObjects = extractRows(subsResult);
          for (const s of subObjects) {
            insertSub.run({
              id: toNum(s.id),
              user_id: toNum(s.user_id),
              pool_slug: s.pool_slug,
              block_id: s.block_id,
              notify_on_available: toNum(s.notify_on_available, 1),
              notify_on_sold_out: toNum(s.notify_on_sold_out, 0),
              notify_on_models: toNum(s.notify_on_models, 1),
              notify_on_prices: toNum(s.notify_on_prices, 1),
              created_at: s.created_at ?? new Date().toISOString(),
              updated_at: s.updated_at ?? new Date().toISOString(),
            });
            subCount++;
          }
        }

        // 3. Donations
        if (donResult && donResult.rows?.length > 0) {
          const insertDon = db.prepare(`
            INSERT OR REPLACE INTO donations (
              id, user_id, telegram_id, amount_stars, currency,
              telegram_payment_charge_id, provider_payment_charge_id, created_at
            ) VALUES (
              @id, @user_id, @telegram_id, @amount_stars, @currency,
              @telegram_payment_charge_id, @provider_payment_charge_id, @created_at
            )
          `);

          const donObjects = extractRows(donResult);
          for (const d of donObjects) {
            insertDon.run({
              id: toNum(d.id),
              user_id: toNum(d.user_id),
              telegram_id: toNum(d.telegram_id),
              amount_stars: toNum(d.amount_stars),
              currency: d.currency ?? "XTR",
              telegram_payment_charge_id: d.telegram_payment_charge_id,
              provider_payment_charge_id: d.provider_payment_charge_id ?? null,
              created_at: d.created_at ?? new Date().toISOString(),
            });
            donCount++;
          }
        }

        // 4. Pool State
        if (poolResult && poolResult.rows?.length > 0) {
          const insertPool = db.prepare(`
            INSERT OR REPLACE INTO pool_state (
              id, pool_slug, block_id, status, price_per_month, hours_utc,
              models_json, infra_spec, manual_provisioning, updated_at
            ) VALUES (
              @id, @pool_slug, @block_id, @status, @price_per_month, @hours_utc,
              @models_json, @infra_spec, @manual_provisioning, @updated_at
            )
          `);

          const poolObjects = extractRows(poolResult);
          for (const p of poolObjects) {
            insertPool.run({
              id: toNum(p.id),
              pool_slug: p.pool_slug,
              block_id: p.block_id,
              status: p.status,
              price_per_month: p.price_per_month ?? null,
              hours_utc: p.hours_utc ?? null,
              models_json: p.models_json ?? null,
              infra_spec: p.infra_spec ?? null,
              manual_provisioning: toNum(p.manual_provisioning, 0),
              updated_at: p.updated_at ?? new Date().toISOString(),
            });
            poolCount++;
          }
        }

        // 5. Active Dashboards
        if (dashResult && dashResult.rows?.length > 0) {
          const insertDash = db.prepare(`
            INSERT OR REPLACE INTO active_dashboards (
              chat_id, message_id, user_id, language, last_rendered_text_hash,
              view_type, pool_slug, updated_at
            ) VALUES (
              @chat_id, @message_id, @user_id, @language, @last_rendered_text_hash,
              @view_type, @pool_slug, @updated_at
            )
          `);

          const dashObjects = extractRows(dashResult);
          for (const dash of dashObjects) {
            insertDash.run({
              chat_id: toNum(dash.chat_id),
              message_id: toNum(dash.message_id),
              user_id: toNum(dash.user_id),
              language: dash.language ?? dash.lang ?? "en",
              last_rendered_text_hash: toNum(dash.last_rendered_text_hash, 0),
              view_type: dash.view_type ?? dash.active_view ?? "dashboard",
              pool_slug: dash.pool_slug ?? dash.active_pool_slug ?? null,
              updated_at: dash.updated_at ?? dash.last_updated_at ?? new Date().toISOString(),
            });
            dashCount++;
          }
        }

        // 6. Slot Lifecycle History
        if (lifeResult && lifeResult.rows?.length > 0) {
          const insertLife = db.prepare(`
            INSERT OR REPLACE INTO slot_lifecycle_history (
              id, pool_slug, block_id, initial_status, price_month, opened_at, closed_at, duration_seconds
            ) VALUES (
              @id, @pool_slug, @block_id, @initial_status, @price_month, @opened_at, @closed_at, @duration_seconds
            )
          `);

          const lifeObjects = extractRows(lifeResult);
          for (const l of lifeObjects) {
            insertLife.run({
              id: toNum(l.id),
              pool_slug: l.pool_slug,
              block_id: l.block_id,
              initial_status: l.initial_status,
              price_month: l.price_month ?? null,
              opened_at: l.opened_at,
              closed_at: l.closed_at ?? null,
              duration_seconds: toNullableNum(l.duration_seconds),
            });
            lifeCount++;
          }
        }

        // 7. Slot Price History
        if (priceResult && priceResult.rows?.length > 0) {
          const insertPrice = db.prepare(`
            INSERT OR REPLACE INTO slot_price_history (
              id, pool_slug, block_id, old_price, new_price, new_price_num, price_delta, percent_delta, changed_at
            ) VALUES (
              @id, @pool_slug, @block_id, @old_price, @new_price, @new_price_num, @price_delta, @percent_delta, @changed_at
            )
          `);

          const priceObjects = extractRows(priceResult);
          for (const pr of priceObjects) {
            insertPrice.run({
              id: toNum(pr.id),
              pool_slug: pr.pool_slug,
              block_id: pr.block_id,
              old_price: pr.old_price,
              new_price: pr.new_price,
              new_price_num: toNum(pr.new_price_num, 0),
              price_delta: toNum(pr.price_delta, 0),
              percent_delta: toNum(pr.percent_delta, 0),
              changed_at: pr.changed_at ?? new Date().toISOString(),
            });
            priceCount++;
          }
        }

        // 8. Catalog History
        if (catResult && catResult.rows?.length > 0) {
          const insertCat = db.prepare(`
            INSERT OR REPLACE INTO catalog_history (
              id, pool_slug, pool_name, event_type, added_models_json, upgraded_models_json,
              removed_models_json, all_models_json, previous_min_price, new_min_price, metadata_json, detected_at
            ) VALUES (
              @id, @pool_slug, @pool_name, @event_type, @added_models_json, @upgraded_models_json,
              @removed_models_json, @all_models_json, @previous_min_price, @new_min_price, @metadata_json, @detected_at
            )
          `);

          const catObjects = extractRows(catResult);
          for (const c of catObjects) {
            insertCat.run({
              id: toNum(c.id),
              pool_slug: c.pool_slug,
              pool_name: c.pool_name,
              event_type: c.event_type,
              added_models_json: c.added_models_json ?? null,
              upgraded_models_json: c.upgraded_models_json ?? null,
              removed_models_json: c.removed_models_json ?? null,
              all_models_json: c.all_models_json ?? null,
              previous_min_price: c.previous_min_price ?? null,
              new_min_price: c.new_min_price ?? null,
              metadata_json: c.metadata_json ?? null,
              detected_at: c.detected_at ?? new Date().toISOString(),
            });
            catCount++;
          }
        }
      })();

      const duration = (performance.now() - startTime).toFixed(2);
      console.log(
        `✅ [TursoSync] Hydrated ${userCount} users, ${subCount} subscriptions, ${donCount} donations, ` +
        `${poolCount} pool states, ${dashCount} active dashboards, ${priceCount} price histories from Turso in ${duration}ms`
      );
    } catch (err: any) {
      console.error("❌ [TursoSync] Cold boot hydration error:", err?.message || err);
    }
  }
}
