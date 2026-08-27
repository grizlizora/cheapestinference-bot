-- 1. Users Table
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

CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

-- 2. Subscriptions Table
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
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, pool_slug, block_id)
);

-- 3. Pool State Snapshot Cache
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

-- 4. Slot Lifecycle History & Analytics
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

    CREATE INDEX IF NOT EXISTS idx_slot_history_active ON slot_lifecycle_history(pool_slug, block_id, closed_at);
    CREATE INDEX IF NOT EXISTS idx_slot_history_closed_at ON slot_lifecycle_history(closed_at) WHERE closed_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_slot_history_analytics_covering ON slot_lifecycle_history(pool_slug, block_id, duration_seconds, opened_at) WHERE duration_seconds IS NOT NULL;

-- 5. Catalog & Model Upgrade History
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

CREATE INDEX IF NOT EXISTS idx_catalog_hist_retention ON catalog_history(detected_at);
CREATE INDEX IF NOT EXISTS idx_catalog_hist_slug ON catalog_history(pool_slug, detected_at);

-- 6. Slot Price Changes History
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

CREATE INDEX IF NOT EXISTS idx_slot_price_hist_retention ON slot_price_history(changed_at);
CREATE INDEX IF NOT EXISTS idx_slot_price_hist ON slot_price_history(pool_slug, block_id, changed_at);

-- 7. Notification Logs Table
CREATE TABLE IF NOT EXISTS notification_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  pool_slug TEXT NOT NULL,
  block_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notif_logs_retention ON notification_logs(sent_at);
CREATE INDEX IF NOT EXISTS idx_notif_logs_user_history ON notification_logs(user_id, sent_at);

-- 8. System Metadata Table (for accurate scrape heartbeat & ETag tracking)
CREATE TABLE IF NOT EXISTS system_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
