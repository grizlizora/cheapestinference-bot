import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config/env.js";

let dbInstance: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (dbInstance) return dbInstance;

  const dbDir = path.dirname(config.DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  dbInstance = new Database(config.DB_PATH);

  // Performance and integrity pragmas
  dbInstance.pragma("journal_mode = WAL");
  dbInstance.pragma("synchronous = NORMAL");
  dbInstance.pragma("foreign_keys = ON");
  dbInstance.pragma("cache_size = -2000"); // 2MB memory cache

  // Run schema initialization
  initSchema(dbInstance);

  return dbInstance;
}

function initSchema(db: Database.Database): void {
  // Embedded schema definitions
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL UNIQUE,
      username TEXT,
      first_name TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'uk',
      is_muted INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_users_tgid ON users(telegram_id);
    CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      pool_slug TEXT NOT NULL,
      block_id TEXT NOT NULL,
      notify_on_available INTEGER NOT NULL DEFAULT 1,
      notify_on_sold_out INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, pool_slug, block_id)
    );

    CREATE INDEX IF NOT EXISTS idx_subs_lookup ON subscriptions(pool_slug, block_id, notify_on_available);
    CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id);

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
      last_changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pool_slug, block_id)
    );

    CREATE INDEX IF NOT EXISTS idx_pool_state_slug ON pool_state(pool_slug);

    CREATE TABLE IF NOT EXISTS notification_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      pool_slug TEXT NOT NULL,
      block_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_notif_logs_sent ON notification_logs(sent_at);
  `);
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
