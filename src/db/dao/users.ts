import Database from "better-sqlite3";
import { UserRecord, SupportedLanguage } from "../../types/db.js";

export class UserDAO {
  private stmtGetByTgId: Database.Statement;
  private stmtGetById: Database.Statement;
  private stmtUpsert: Database.Statement;
  private stmtUpdateLang: Database.Statement;
  private stmtToggleMute: Database.Statement;
  private stmtToggleAvail: Database.Statement;
  private stmtToggleSoldOut: Database.Statement;
  private stmtToggleModels: Database.Statement;
  private stmtTogglePrices: Database.Statement;
  private stmtToggleAdminNewUsers: Database.Statement;
  private stmtDeactivate: Database.Statement;
  private stmtReactivate: Database.Statement;
  private stmtGetStats: Database.Statement;

  constructor(public readonly db: Database.Database) {
    // Run schema migration for user preference columns
    try {
      db.exec(`
        ALTER TABLE users ADD COLUMN notify_available_global INTEGER NOT NULL DEFAULT 1;
      `);
    } catch {}
    try {
      db.exec(`
        ALTER TABLE users ADD COLUMN notify_sold_out_global INTEGER NOT NULL DEFAULT 0;
      `);
    } catch {}
    try {
      db.exec(`
        ALTER TABLE users ADD COLUMN notify_models_global INTEGER NOT NULL DEFAULT 1;
      `);
    } catch {}
    try {
      db.exec(`
        ALTER TABLE users ADD COLUMN notify_prices_global INTEGER NOT NULL DEFAULT 1;
      `);
    } catch {}
    try {
      db.exec(`
        ALTER TABLE users ADD COLUMN notify_admin_new_users INTEGER NOT NULL DEFAULT 1;
      `);
    } catch {}

    this.stmtGetByTgId = db.prepare("SELECT * FROM users WHERE telegram_id = ?");
    this.stmtGetById = db.prepare("SELECT * FROM users WHERE id = ?");
    this.stmtUpsert = db.prepare(`
      INSERT INTO users (telegram_id, username, first_name, language)
      VALUES (@telegram_id, @username, @first_name, @language)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        is_active = 1,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `);
    this.stmtUpdateLang = db.prepare(`
      UPDATE users SET language = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?
    `);
    this.stmtToggleMute = db.prepare(`
      UPDATE users SET is_muted = CASE WHEN is_muted = 1 THEN 0 ELSE 1 END, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?
    `);
    this.stmtToggleAvail = db.prepare(`
      UPDATE users SET notify_available_global = CASE WHEN notify_available_global = 1 THEN 0 ELSE 1 END, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?
    `);
    this.stmtToggleSoldOut = db.prepare(`
      UPDATE users SET notify_sold_out_global = CASE WHEN notify_sold_out_global = 1 THEN 0 ELSE 1 END, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?
    `);
    this.stmtToggleModels = db.prepare(`
      UPDATE users SET notify_models_global = CASE WHEN notify_models_global = 1 THEN 0 ELSE 1 END, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?
    `);
    this.stmtTogglePrices = db.prepare(`
      UPDATE users SET notify_prices_global = CASE WHEN notify_prices_global = 1 THEN 0 ELSE 1 END, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?
    `);
    this.stmtToggleAdminNewUsers = db.prepare(`
      UPDATE users SET notify_admin_new_users = CASE WHEN notify_admin_new_users = 1 THEN 0 ELSE 1 END, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?
    `);
    this.stmtDeactivate = db.prepare(`
      UPDATE users SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?
    `);
    this.stmtReactivate = db.prepare(`
      UPDATE users SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?
    `);
    this.stmtGetStats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) as blocked
      FROM users
    `);
  }

  getByTelegramId(tgId: number): UserRecord | undefined {
    return this.stmtGetByTgId.get(tgId) as UserRecord | undefined;
  }

  getById(id: number): UserRecord | undefined {
    return this.stmtGetById.get(id) as UserRecord | undefined;
  }

  upsertUser(params: {
    telegram_id: number;
    username: string | null;
    first_name: string;
    language?: SupportedLanguage;
  }): UserRecord {
    return this.stmtUpsert.get({
      telegram_id: params.telegram_id,
      username: params.username,
      first_name: params.first_name,
      language: params.language || "en",
    }) as UserRecord;
  }

  setLanguage(tgId: number, lang: SupportedLanguage): void {
    this.stmtUpdateLang.run(lang, tgId);
  }

  toggleMute(tgId: number): number {
    this.stmtToggleMute.run(tgId);
    const user = this.getByTelegramId(tgId);
    return user ? user.is_muted : 0;
  }

  toggleAvailable(tgId: number): number {
    this.stmtToggleAvail.run(tgId);
    const user = this.getByTelegramId(tgId);
    return user ? user.notify_available_global : 1;
  }

  toggleSoldOut(tgId: number): number {
    this.stmtToggleSoldOut.run(tgId);
    const user = this.getByTelegramId(tgId);
    return user ? user.notify_sold_out_global : 0;
  }

  toggleModels(tgId: number): number {
    this.stmtToggleModels.run(tgId);
    const user = this.getByTelegramId(tgId);
    return user ? user.notify_models_global : 1;
  }

  togglePrices(tgId: number): number {
    this.stmtTogglePrices.run(tgId);
    const user = this.getByTelegramId(tgId);
    return user ? user.notify_prices_global : 1;
  }

  toggleAdminNewUsers(tgId: number): number {
    this.stmtToggleAdminNewUsers.run(tgId);
    const user = this.getByTelegramId(tgId);
    return user ? (user.notify_admin_new_users ?? 1) : 1;
  }

  deactivateUser(tgId: number): void {
    this.stmtDeactivate.run(tgId);
  }

  reactivateUser(tgId: number): void {
    this.stmtReactivate.run(tgId);
  }

  getUserStats(): { total: number; active: number; blocked: number } {
    const row = this.stmtGetStats.get() as any;
    return {
      total: Number(row?.total || 0),
      active: Number(row?.active || 0),
      blocked: Number(row?.blocked || 0),
    };
  }
}
