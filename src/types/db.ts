export type SupportedLanguage = "uk" | "en" | "ru";

export interface UserRecord {
  id: number;
  telegram_id: number;
  username: string | null;
  first_name: string;
  language: SupportedLanguage;
  is_muted: number; // 0 = Sound ON, 1 = Muted
  is_active: number; // 1 = Active, 0 = Blocked bot
  notify_available_global: number; // 1 = Enabled, 0 = Disabled
  notify_sold_out_global: number; // 1 = Enabled, 0 = Disabled
  notify_models_global: number; // 1 = Enabled, 0 = Disabled
  notify_prices_global: number; // 1 = Enabled, 0 = Disabled
  notify_admin_new_users: number; // 1 = Admin wants new user alerts, 0 = Disabled
  last_active_at: string;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionRecord {
  id: number;
  user_id: number;
  pool_slug: string; // 'ALL' | 'flagship' | 'frontier' | 'core'
  block_id: string;  // 'ALL' | 'asia' | 'europe' | 'americas'
  notify_on_available: number;
  notify_on_sold_out: number;
  notify_on_models: number;
  notify_on_prices: number;
  created_at: string;
}

export interface SubscriberMatch {
  telegram_id: number;
  language: SupportedLanguage;
  is_muted: number;
}

export interface PoolStateRecord {
  id: number;
  pool_slug: string;
  pool_name: string;
  models_json: string;
  block_id: string;
  status: string;
  hours_utc: string;
  price_month: string;
  min_price_day: string;
  annual_discount: number;
  description: string;
  last_changed_at: string;
  updated_at: string;
}

export interface NotificationLogRecord {
  id: number;
  user_id: number;
  pool_slug: string;
  block_id: string;
  event_type: string;
  sent_at: string;
}
