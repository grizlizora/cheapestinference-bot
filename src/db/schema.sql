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
  total_donated_stars INTEGER NOT NULL DEFAULT 0,
  last_active_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);
CREATE INDEX IF NOT EXISTS idx_users_admins ON users(telegram_id) WHERE is_admin = 1 AND is_active = 1;
CREATE INDEX IF NOT EXISTS idx_users_donors ON users(total_donated_stars DESC) WHERE total_donated_stars > 0;
CREATE INDEX IF NOT EXISTS idx_users_lower_username ON users(LOWER(username)) WHERE username IS NOT NULL;

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

-- Microscopic partial index for active slots
CREATE INDEX IF NOT EXISTS idx_slot_history_open ON slot_lifecycle_history(pool_slug, block_id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_slot_history_closed_at ON slot_lifecycle_history(closed_at) WHERE closed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_slot_history_last_closed ON slot_lifecycle_history(pool_slug, block_id, closed_at DESC) WHERE closed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_slot_history_analytics_covering ON slot_lifecycle_history(pool_slug, block_id, duration_seconds, opened_at) WHERE duration_seconds IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_slot_history_downtime_perf ON slot_lifecycle_history(pool_slug, block_id, opened_at ASC);

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

-- 6. Slot Price Changes History
CREATE TABLE IF NOT EXISTS slot_price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_slug TEXT NOT NULL,
  block_id TEXT NOT NULL,
  old_price TEXT NOT NULL,
  new_price TEXT NOT NULL,
  new_price_num REAL NOT NULL DEFAULT 0.0,
  price_delta REAL NOT NULL,
  percent_delta REAL NOT NULL,
  changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_slot_price_hist_retention ON slot_price_history(changed_at);
CREATE INDEX IF NOT EXISTS idx_slot_price_hist_lookup ON slot_price_history(pool_slug, block_id);
CREATE INDEX IF NOT EXISTS idx_slot_price_hist_analytics_covering ON slot_price_history(pool_slug, block_id, new_price_num);

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
CREATE INDEX IF NOT EXISTS idx_notif_logs_user_fk ON notification_logs(user_id);

-- 8. System Metadata Table (for accurate scrape heartbeat & ETag tracking)
CREATE TABLE IF NOT EXISTS system_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 9. Active Dashboards Table (Container Reboot & LiveSync Persistence)
CREATE TABLE IF NOT EXISTS active_dashboards (
  chat_id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  view_type TEXT NOT NULL DEFAULT 'dashboard',
  pool_slug TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  last_rendered_text_hash INTEGER NOT NULL DEFAULT 0,
  last_rendered_keyboard_hash INTEGER NOT NULL DEFAULT 0,
  last_telegram_edit_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_interaction_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_active_dashboards_user ON active_dashboards(user_id);
CREATE INDEX IF NOT EXISTS idx_active_dashboards_interaction ON active_dashboards(last_interaction_at);
CREATE INDEX IF NOT EXISTS idx_active_dashboards_errors ON active_dashboards(consecutive_errors) WHERE consecutive_errors >= 3;

-- 10. Donations Table (Telegram Stars XTR)
CREATE TABLE IF NOT EXISTS donations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  telegram_id INTEGER NOT NULL,
  amount_stars INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'XTR',
  telegram_payment_charge_id TEXT NOT NULL UNIQUE,
  provider_payment_charge_id TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_donations_user ON donations(user_id);
CREATE INDEX IF NOT EXISTS idx_donations_amount ON donations(amount_stars DESC);
CREATE INDEX IF NOT EXISTS idx_donations_created_at ON donations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_donations_user_created ON donations(user_id, created_at DESC);

-- 11. Notification Outbox (Zero-Loss Queue across Container Reboots)
CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  telegram_id INTEGER NOT NULL,
  priority TEXT NOT NULL DEFAULT 'P1',
  message_text TEXT NOT NULL,
  reply_markup_json TEXT,
  disable_notification INTEGER NOT NULL DEFAULT 0,
  event_type TEXT NOT NULL DEFAULT 'available',
  pool_slug TEXT,
  block_id TEXT,
  is_broadcast INTEGER NOT NULL DEFAULT 0,
  language TEXT NOT NULL DEFAULT 'en',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dispatched_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON notification_outbox(status, priority, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outbox_user ON notification_outbox(user_id);
CREATE INDEX IF NOT EXISTS idx_outbox_broadcast ON notification_outbox(is_broadcast, language, status);

