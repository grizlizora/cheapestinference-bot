-- Users table: stores user identity, language preference, and notification settings
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

-- Subscriptions table: granular alert matrix
-- Levels:
-- 1. Global: pool_slug = 'ALL', block_id = 'ALL'
-- 2. Pool-level: pool_slug = 'flagship', block_id = 'ALL'
-- 3. Block-level: pool_slug = 'flagship', block_id = 'europe'
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

-- Pool state cache table: maintains current dynamic snapshot of all pools & blocks
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

-- Notification logs: for deduplication and telemetry
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
