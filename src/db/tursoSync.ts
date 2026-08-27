import Database from "better-sqlite3";
import { config } from "../config/env.js";

interface MutationItem {
  sql: string;
  args: any[];
}

export class TursoCloudSync {
  private url?: string;
  private token?: string;
  private pendingMutations: MutationItem[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushing = false;
  private isInitialized = false;

  constructor(url?: string, token?: string) {
    if (url && url.trim().length > 0) {
      let normalized = url.trim();
      if (normalized.startsWith("libsql://")) {
        normalized = normalized.replace("libsql://", "https://");
      } else if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
        normalized = `https://${normalized}`;
      }
      this.url = normalized.replace(/\/+$/, "");
    }
    if (token && token.trim().length > 0) {
      this.token = token.trim();
    }
  }

  public isEnabled(): boolean {
    return Boolean(this.url && this.token);
  }

  public getUrl(): string {
    return this.url || "";
  }

  /**
   * Executes remote Turso pipeline requests over HTTPS
   */
  private async executePipeline(requests: Array<{ type: string; stmt: { sql: string; args?: any[] } }>): Promise<any[]> {
    if (!this.isEnabled() || !this.url || !this.token) return [];

    const endpoint = `${this.url}/v2/pipeline`;
    const formattedRequests = requests.map((req) => ({
      type: "execute",
      stmt: {
        sql: req.stmt.sql,
        args: (req.stmt.args || []).map((val) => {
          if (val === null || val === undefined) return { type: "null" };
          if (typeof val === "number") {
            return Number.isInteger(val) ? { type: "integer", value: String(val) } : { type: "float", value: val };
          }
          if (typeof val === "boolean") return { type: "integer", value: val ? "1" : "0" };
          return { type: "text", value: String(val) };
        }),
      },
    }));

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests: formattedRequests }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Turso HTTP ${response.status}: ${errText}`);
    }

    const data: any = await response.json();
    return data?.results || [];
  }

  /**
   * Initializes remote tables in Turso on startup if they do not exist
   */
  public async initRemoteSchema(): Promise<void> {
    if (!this.isEnabled() || this.isInitialized) return;

    try {
      await this.executePipeline([
        {
          type: "execute",
          stmt: {
            sql: `
              CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                telegram_id INTEGER NOT NULL UNIQUE,
                username TEXT,
                first_name TEXT NOT NULL,
                language TEXT NOT NULL DEFAULT 'en',
                is_muted INTEGER NOT NULL DEFAULT 0,
                is_active INTEGER NOT NULL DEFAULT 1,
                notify_available_global INTEGER NOT NULL DEFAULT 1,
                notify_sold_out_global INTEGER NOT NULL DEFAULT 0,
                notify_models_global INTEGER NOT NULL DEFAULT 1,
                notify_prices_global INTEGER NOT NULL DEFAULT 1,
                notify_admin_new_users INTEGER NOT NULL DEFAULT 1,
                is_admin INTEGER NOT NULL DEFAULT 0,
                last_active_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
              );
            `,
          },
        },
        {
          type: "execute",
          stmt: {
            sql: `
              CREATE TABLE IF NOT EXISTS subscriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                pool_slug TEXT NOT NULL,
                block_id TEXT NOT NULL,
                notify_on_available INTEGER NOT NULL DEFAULT 1,
                notify_on_sold_out INTEGER NOT NULL DEFAULT 0,
                notify_on_models INTEGER NOT NULL DEFAULT 1,
                notify_on_prices INTEGER NOT NULL DEFAULT 1,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, pool_slug, block_id)
              );
            `,
          },
        },
        {
          type: "execute",
          stmt: {
            sql: `
              CREATE TABLE IF NOT EXISTS pool_state (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pool_slug TEXT NOT NULL,
                pool_name TEXT NOT NULL,
                models_json TEXT NOT NULL,
                block_id TEXT NOT NULL,
                status TEXT NOT NULL,
                hours_utc TEXT NOT NULL,
                price_month TEXT NOT NULL,
                min_price_day TEXT NOT NULL,
                annual_discount REAL NOT NULL DEFAULT 0.15,
                description TEXT NOT NULL DEFAULT '',
                infra_spec TEXT NOT NULL DEFAULT '',
                manual_provisioning INTEGER NOT NULL DEFAULT 0,
                last_changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(pool_slug, block_id)
              );
            `,
          },
        },
        {
          type: "execute",
          stmt: {
            sql: `
              CREATE TABLE IF NOT EXISTS slot_lifecycle_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pool_slug TEXT NOT NULL,
                block_id TEXT NOT NULL,
                opened_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                closed_at DATETIME,
                duration_seconds INTEGER,
                initial_status TEXT NOT NULL,
                price_month TEXT NOT NULL
              );
            `,
          },
        },
        {
          type: "execute",
          stmt: {
            sql: `
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
            `,
          },
        },
        {
          type: "execute",
          stmt: {
            sql: `
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
            `,
          },
        },
      ]);
      this.isInitialized = true;
    } catch (err: any) {
      console.warn("⚠️ [TursoSync] Remote schema check warning:", err?.message || err);
    }
  }

  /**
   * Hydrates local SQLite database from Turso Cloud on cold start
   */
  public async pullStateFromTurso(db: Database.Database): Promise<void> {
    if (!this.isEnabled()) return;

    const startTime = performance.now();
    console.log("☁️ [TursoSync] Pulling state from Turso Cloud...");

    try {
      await this.initRemoteSchema();

      const results = await this.executePipeline([
        { type: "execute", stmt: { sql: "SELECT * FROM users" } },
        { type: "execute", stmt: { sql: "SELECT * FROM subscriptions" } },
        { type: "execute", stmt: { sql: "SELECT * FROM pool_state" } },
      ]);

      const usersResult = results[0]?.response?.result;
      const subsResult = results[1]?.response?.result;
      const poolStateResult = results[2]?.response?.result;

      if (!usersResult && !subsResult && !poolStateResult) {
        console.log("☁️ [TursoSync] No remote state found in Turso.");
        return;
      }

      const upsertUserStmt = db.prepare(`
        INSERT INTO users (
          id, telegram_id, username, first_name, language, is_muted, is_active,
          notify_available_global, notify_sold_out_global, notify_models_global, notify_prices_global,
          notify_admin_new_users, is_admin, last_active_at, created_at, updated_at
        ) VALUES (
          @id, @telegram_id, @username, @first_name, @language, @is_muted, @is_active,
          @notify_available_global, @notify_sold_out_global, @notify_models_global, @notify_prices_global,
          @notify_admin_new_users, @is_admin, @last_active_at, @created_at, @updated_at
        )
        ON CONFLICT(telegram_id) DO UPDATE SET
          id = excluded.id,
          username = excluded.username,
          first_name = excluded.first_name,
          language = excluded.language,
          is_muted = excluded.is_muted,
          is_active = excluded.is_active,
          notify_available_global = excluded.notify_available_global,
          notify_sold_out_global = excluded.notify_sold_out_global,
          notify_models_global = excluded.notify_models_global,
          notify_prices_global = excluded.notify_prices_global,
          is_admin = excluded.is_admin,
          last_active_at = excluded.last_active_at,
          updated_at = excluded.updated_at
      `);

      const upsertSubStmt = db.prepare(`
        INSERT INTO subscriptions (
          user_id, pool_slug, block_id, notify_on_available, notify_on_sold_out, notify_on_models, notify_on_prices
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, pool_slug, block_id) DO UPDATE SET
          notify_on_available = excluded.notify_on_available,
          notify_on_sold_out = excluded.notify_on_sold_out,
          notify_on_models = excluded.notify_on_models,
          notify_on_prices = excluded.notify_on_prices
      `);

      const upsertPoolStateStmt = db.prepare(`
        INSERT INTO pool_state (
          pool_slug, pool_name, models_json, block_id, status, 
          hours_utc, price_month, min_price_day, annual_discount, description,
          infra_spec, manual_provisioning, last_changed_at, updated_at
        ) VALUES (
          @pool_slug, @pool_name, @models_json, @block_id, @status,
          @hours_utc, @price_month, @min_price_day, @annual_discount, @description,
          @infra_spec, @manual_provisioning, @last_changed_at, @updated_at
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
          last_changed_at = excluded.last_changed_at,
          updated_at = excluded.updated_at
      `);

      let loadedUsers = 0;
      let loadedSubs = 0;
      let loadedPools = 0;

      const hydrateTx = db.transaction(() => {
        if (usersResult?.rows) {
          const cols: string[] = usersResult.cols.map((c: any) => c.name);
          for (const row of usersResult.rows) {
            const userObj: any = {};
            cols.forEach((colName, idx) => {
              userObj[colName] = row[idx]?.value !== undefined ? row[idx].value : null;
            });
            try {
              upsertUserStmt.run({
                id: Number(userObj.id),
                telegram_id: Number(userObj.telegram_id),
                username: userObj.username || null,
                first_name: userObj.first_name || "User",
                language: userObj.language || "en",
                is_muted: Number(userObj.is_muted || 0),
                is_active: Number(userObj.is_active ?? 1),
                notify_available_global: Number(userObj.notify_available_global ?? 1),
                notify_sold_out_global: Number(userObj.notify_sold_out_global ?? 0),
                notify_models_global: Number(userObj.notify_models_global ?? 1),
                notify_prices_global: Number(userObj.notify_prices_global ?? 1),
                notify_admin_new_users: Number(userObj.notify_admin_new_users ?? 1),
                is_admin: Number(userObj.is_admin || 0),
                last_active_at: userObj.last_active_at || new Date().toISOString(),
                created_at: userObj.created_at || new Date().toISOString(),
                updated_at: userObj.updated_at || new Date().toISOString(),
              });
              loadedUsers++;
            } catch {}
          }
        }

        if (subsResult?.rows) {
          const cols: string[] = subsResult.cols.map((c: any) => c.name);
          for (const row of subsResult.rows) {
            const subObj: any = {};
            cols.forEach((colName, idx) => {
              subObj[colName] = row[idx]?.value !== undefined ? row[idx].value : null;
            });
            try {
              upsertSubStmt.run(
                Number(subObj.user_id),
                String(subObj.pool_slug),
                String(subObj.block_id),
                Number(subObj.notify_on_available ?? 1),
                Number(subObj.notify_on_sold_out ?? 0),
                Number(subObj.notify_on_models ?? 1),
                Number(subObj.notify_on_prices ?? 1)
              );
              loadedSubs++;
            } catch {}
          }
        }

        if (poolStateResult?.rows) {
          const cols: string[] = poolStateResult.cols.map((c: any) => c.name);
          for (const row of poolStateResult.rows) {
            const poolObj: any = {};
            cols.forEach((colName, idx) => {
              poolObj[colName] = row[idx]?.value !== undefined ? row[idx].value : null;
            });
            try {
              upsertPoolStateStmt.run({
                pool_slug: String(poolObj.pool_slug),
                pool_name: String(poolObj.pool_name),
                models_json: String(poolObj.models_json || "[]"),
                block_id: String(poolObj.block_id),
                status: String(poolObj.status || "sold-out"),
                hours_utc: String(poolObj.hours_utc || ""),
                price_month: String(poolObj.price_month || "$0"),
                min_price_day: String(poolObj.min_price_day || "$0"),
                annual_discount: Number(poolObj.annual_discount || 0.15),
                description: String(poolObj.description || ""),
                infra_spec: String(poolObj.infra_spec || ""),
                manual_provisioning: Number(poolObj.manual_provisioning || 0),
                last_changed_at: String(poolObj.last_changed_at || new Date().toISOString()),
                updated_at: String(poolObj.updated_at || new Date().toISOString()),
              });
              loadedPools++;
            } catch {}
          }
        }
      });

      hydrateTx();
      const elapsed = (performance.now() - startTime).toFixed(2);
      console.log(`✅ [TursoSync] Hydrated ${loadedUsers} users, ${loadedSubs} subscriptions, ${loadedPools} pool states from Turso in ${elapsed}ms`);
    } catch (err: any) {
      console.error("❌ [TursoSync] Failed to pull state from Turso:", err?.message || err);
    }
  }

  /**
   * Enqueues a write mutation to be asynchronously pushed to Turso in the background
   */
  public pushMutation(sql: string, args: any[] = []): void {
    if (!this.isEnabled()) return;

    this.pendingMutations.push({ sql, args });

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flush().catch(() => {});
      }, 1500);
    }
  }

  /**
   * Flushes all pending mutations in a single batch to Turso Cloud
   */
  public async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (!this.isEnabled() || this.pendingMutations.length === 0 || this.isFlushing) {
      return;
    }

    this.isFlushing = true;
    const batch = [...this.pendingMutations];
    this.pendingMutations = [];

    try {
      await this.executePipeline(
        batch.map((item) => ({
          type: "execute",
          stmt: {
            sql: item.sql,
            args: item.args,
          },
        }))
      );
    } catch (err: any) {
      console.warn(`⚠️ [TursoSync] Background batch push warning (${batch.length} mutations):`, err?.message || err);
      this.pendingMutations = [...batch, ...this.pendingMutations];
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flush().catch(() => {});
        }, 5000);
      }
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Final flush and cleanup on graceful shutdown
   */
  public async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.isFlushing) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await this.flush().catch(() => {});
  }
}

// Global Singleton Instance
export const tursoCloudSync = new TursoCloudSync(config.TURSO_DATABASE_URL, config.TURSO_AUTH_TOKEN);
