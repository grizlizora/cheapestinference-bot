/**
 * src/db/sync/remoteSchema.ts
 * Remote Schema Initialization & Single-Roundtrip Auto-Migrations
 */

export class RemoteSchemaManager {
  private isInitialized = false;

  constructor(
    private executePipeline: (requests: Array<{ type: string; stmt: { sql: string; args?: any[] } }>) => Promise<any[]>,
    private isEnabled: () => boolean
  ) {}

  public isSchemaInitialized(): boolean {
    return this.isInitialized;
  }

  /**
   * Initializes remote tables in Turso on startup if they do not exist
   */
  public async initRemoteSchema(): Promise<void> {
    if (!this.isEnabled() || this.isInitialized) return;

    try {
      // 1. Ensure core tables exist in single pipeline batch
      await this.executePipeline([
        {
          type: "execute",
          stmt: {
            sql: `
              CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                telegram_id INTEGER NOT NULL UNIQUE,
                username TEXT,
                first_name TEXT,
                language TEXT DEFAULT 'en',
                is_muted INTEGER DEFAULT 0,
                is_active INTEGER DEFAULT 1,
                notify_available_global INTEGER DEFAULT 1,
                notify_sold_out_global INTEGER DEFAULT 0,
                notify_models_global INTEGER DEFAULT 1,
                notify_prices_global INTEGER DEFAULT 1,
                notify_admin_new_users INTEGER DEFAULT 1,
                is_admin INTEGER DEFAULT 0,
                total_donated_stars INTEGER DEFAULT 0,
                last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
              )
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
                notify_on_available INTEGER DEFAULT 1,
                notify_on_sold_out INTEGER DEFAULT 0,
                notify_on_models INTEGER DEFAULT 1,
                notify_on_prices INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, pool_slug, block_id)
              )
            `,
          },
        },
        {
          type: "execute",
          stmt: {
            sql: `
              CREATE TABLE IF NOT EXISTS donations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                telegram_id INTEGER NOT NULL,
                amount_stars INTEGER NOT NULL,
                currency TEXT NOT NULL DEFAULT 'XTR',
                telegram_payment_charge_id TEXT NOT NULL UNIQUE,
                provider_payment_charge_id TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
              )
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
                block_id TEXT NOT NULL,
                status TEXT NOT NULL,
                price_per_month TEXT,
                hours_utc TEXT,
                models_json TEXT,
                infra_spec TEXT,
                manual_provisioning INTEGER DEFAULT 0,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(pool_slug, block_id)
              )
            `,
          },
        },
        {
          type: "execute",
          stmt: {
            sql: `
              CREATE TABLE IF NOT EXISTS active_dashboards (
                chat_id INTEGER PRIMARY KEY,
                message_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                lang TEXT NOT NULL DEFAULT 'en',
                last_rendered_text_hash INTEGER NOT NULL DEFAULT 0,
                active_view TEXT NOT NULL DEFAULT 'dashboard',
                active_pool_slug TEXT,
                last_updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
              )
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
                initial_status TEXT NOT NULL,
                price_month TEXT,
                opened_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                closed_at DATETIME,
                duration_seconds INTEGER
              )
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
                new_price_num REAL NOT NULL DEFAULT 0,
                price_delta REAL NOT NULL,
                percent_delta REAL NOT NULL,
                changed_at DATETIME DEFAULT CURRENT_TIMESTAMP
              )
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
                added_models_json TEXT,
                upgraded_models_json TEXT,
                removed_models_json TEXT,
                all_models_json TEXT,
                previous_min_price TEXT,
                new_min_price TEXT,
                metadata_json TEXT,
                detected_at DATETIME DEFAULT CURRENT_TIMESTAMP
              )
            `,
          },
        },
        {
          type: "execute",
          stmt: {
            sql: `
              CREATE TABLE IF NOT EXISTS notification_outbox (
                id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                telegram_id INTEGER NOT NULL,
                priority TEXT NOT NULL,
                message_text TEXT NOT NULL,
                reply_markup_json TEXT,
                disable_notification INTEGER DEFAULT 0,
                event_type TEXT NOT NULL,
                pool_slug TEXT,
                block_id TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                dispatched_at DATETIME,
                failed_at DATETIME,
                error_message TEXT,
                media_type TEXT,
                file_id TEXT,
                is_broadcast INTEGER DEFAULT 0,
                language TEXT
              )
            `,
          },
        },
      ]);

      // 2. Defensive column migrations (batched)
      const migrations = [
        "ALTER TABLE users ADD COLUMN total_donated_stars INTEGER DEFAULT 0",
        "ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0",
        "ALTER TABLE users ADD COLUMN notify_admin_new_users INTEGER DEFAULT 1",
        "ALTER TABLE pool_state ADD COLUMN infra_spec TEXT",
        "ALTER TABLE pool_state ADD COLUMN manual_provisioning INTEGER DEFAULT 0",
        "ALTER TABLE active_dashboards ADD COLUMN active_view TEXT NOT NULL DEFAULT 'dashboard'",
        "ALTER TABLE active_dashboards ADD COLUMN active_pool_slug TEXT",
        "ALTER TABLE slot_price_history ADD COLUMN new_price_num REAL NOT NULL DEFAULT 0",
        "ALTER TABLE catalog_history ADD COLUMN previous_min_price TEXT",
        "ALTER TABLE catalog_history ADD COLUMN new_min_price TEXT",
        "ALTER TABLE notification_outbox ADD COLUMN media_type TEXT",
        "ALTER TABLE notification_outbox ADD COLUMN file_id TEXT",
        "ALTER TABLE notification_outbox ADD COLUMN is_broadcast INTEGER DEFAULT 0",
        "ALTER TABLE notification_outbox ADD COLUMN language TEXT",
      ];

      for (const sql of migrations) {
        await this.executePipeline([{ type: "execute", stmt: { sql } }]).catch(() => {});
      }

      this.isInitialized = true;
      console.log("☁️ [TursoSync] Remote schema synchronized with Turso Cloud.");
    } catch (err: any) {
      console.warn("⚠️ [TursoSync] Remote schema initialization warning:", err?.message || err);
    }
  }
}
