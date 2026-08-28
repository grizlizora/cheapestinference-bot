import Database from "better-sqlite3";
import { UserRecord, SupportedLanguage } from "../../types/db.js";
import { tursoCloudSync } from "../tursoSync.js";

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
  private stmtTouchLastActive: Database.Statement;
  private stmtDeactivate: Database.Statement;
  private stmtReactivate: Database.Statement;
  private stmtGetStats: Database.Statement;
  private stmtSetAdmin: Database.Statement;
  private stmtIsAdmin: Database.Statement;
  private stmtGetAllAdmins: Database.Statement;
  private txDeactivateBatch: (ids: number[]) => void;

  constructor(public readonly db: Database.Database) {
    this.stmtGetByTgId = db.prepare("SELECT * FROM users WHERE telegram_id = ?");
    this.stmtGetById = db.prepare("SELECT * FROM users WHERE id = ?");
    this.stmtSetAdmin = db.prepare(`
      UPDATE users SET is_admin = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?
    `);
    this.stmtIsAdmin = db.prepare(`
      SELECT is_admin FROM users WHERE telegram_id = ?
    `);
    this.stmtGetAllAdmins = db.prepare(`
      SELECT telegram_id FROM users WHERE is_admin = 1 AND is_active = 1
    `);
    this.stmtUpsert = db.prepare(`
      INSERT INTO users (telegram_id, username, first_name, language)
      VALUES (@telegram_id, @username, @first_name, @language)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        is_active = 1,
        last_active_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `);
    this.stmtUpdateLang = db.prepare(`
      UPDATE users SET language = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?
    `);
    this.stmtToggleMute = db.prepare(`
      UPDATE users SET is_muted = CASE WHEN is_muted = 1 THEN 0 ELSE 1 END, updated_at = CURRENT_TIMESTAMP
      WHERE telegram_id = ?
      RETURNING is_muted
    `);
    this.stmtToggleAvail = db.prepare(`
      UPDATE users SET notify_available_global = CASE WHEN notify_available_global = 1 THEN 0 ELSE 1 END, updated_at = CURRENT_TIMESTAMP
      WHERE telegram_id = ?
      RETURNING notify_available_global
    `);
    this.stmtToggleSoldOut = db.prepare(`
      UPDATE users SET notify_sold_out_global = CASE WHEN notify_sold_out_global = 1 THEN 0 ELSE 1 END, updated_at = CURRENT_TIMESTAMP
      WHERE telegram_id = ?
      RETURNING notify_sold_out_global
    `);
    this.stmtToggleModels = db.prepare(`
      UPDATE users SET notify_models_global = CASE WHEN notify_models_global = 1 THEN 0 ELSE 1 END, updated_at = CURRENT_TIMESTAMP
      WHERE telegram_id = ?
      RETURNING notify_models_global
    `);
    this.stmtTogglePrices = db.prepare(`
      UPDATE users SET notify_prices_global = CASE WHEN notify_prices_global = 1 THEN 0 ELSE 1 END, updated_at = CURRENT_TIMESTAMP
      WHERE telegram_id = ?
      RETURNING notify_prices_global
    `);
    this.stmtToggleAdminNewUsers = db.prepare(`
      UPDATE users SET notify_admin_new_users = CASE WHEN notify_admin_new_users = 1 THEN 0 ELSE 1 END, updated_at = CURRENT_TIMESTAMP
      WHERE telegram_id = ?
      RETURNING notify_admin_new_users
    `);
    this.stmtTouchLastActive = db.prepare(`
      UPDATE users SET last_active_at = CURRENT_TIMESTAMP WHERE telegram_id = ?
    `);
    this.stmtDeactivate = db.prepare(`
      UPDATE users SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?
    `);
    this.stmtReactivate = db.prepare(`
      UPDATE users SET is_active = 1, last_active_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?
    `);
    this.stmtGetStats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN is_active = 1 THEN 1 END) as active,
        COUNT(CASE WHEN is_active = 0 THEN 1 END) as blocked
      FROM users
    `);

    this.txDeactivateBatch = this.db.transaction((ids: number[]) => {
      for (const id of ids) {
        this.stmtDeactivate.run(id);
      }
    });
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
    const user = this.stmtUpsert.get({
      telegram_id: params.telegram_id,
      username: params.username,
      first_name: params.first_name,
      language: params.language || "en",
    }) as UserRecord;

    tursoCloudSync.pushMutation(
      `INSERT INTO users (id, telegram_id, username, first_name, language) 
       VALUES (?, ?, ?, ?, ?) 
       ON CONFLICT(telegram_id) DO UPDATE SET 
         id=excluded.id, username=excluded.username, first_name=excluded.first_name, updated_at=CURRENT_TIMESTAMP`,
      [user.id, params.telegram_id, params.username, params.first_name, params.language || "en"],
      true
    );

    return user;
  }

  setLanguage(tgId: number, lang: SupportedLanguage): void {
    this.stmtUpdateLang.run(lang, tgId);
    tursoCloudSync.pushMutation(
      `UPDATE users SET language = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?`,
      [lang, tgId],
      true
    );
  }

  touchLastActive(tgId: number): void {
    try {
      this.stmtTouchLastActive.run(tgId);
    } catch {}
  }

  toggleMute(tgId: number): number {
    const row = this.stmtToggleMute.get(tgId) as { is_muted: number } | undefined;
    const res = row ? row.is_muted : 0;
    tursoCloudSync.pushMutation(
      `UPDATE users SET is_muted = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?`,
      [res, tgId],
      true
    );
    return res;
  }

  toggleAvailable(tgId: number): number {
    const row = this.stmtToggleAvail.get(tgId) as { notify_available_global: number } | undefined;
    const res = row ? row.notify_available_global : 1;
    tursoCloudSync.pushMutation(
      `UPDATE users SET notify_available_global = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?`,
      [res, tgId],
      true
    );
    return res;
  }

  toggleSoldOut(tgId: number): number {
    const row = this.stmtToggleSoldOut.get(tgId) as { notify_sold_out_global: number } | undefined;
    const res = row ? row.notify_sold_out_global : 0;
    tursoCloudSync.pushMutation(
      `UPDATE users SET notify_sold_out_global = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?`,
      [res, tgId],
      true
    );
    return res;
  }

  toggleModels(tgId: number): number {
    const row = this.stmtToggleModels.get(tgId) as { notify_models_global: number } | undefined;
    const res = row ? row.notify_models_global : 1;
    tursoCloudSync.pushMutation(
      `UPDATE users SET notify_models_global = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?`,
      [res, tgId],
      true
    );
    return res;
  }

  togglePrices(tgId: number): number {
    const row = this.stmtTogglePrices.get(tgId) as { notify_prices_global: number } | undefined;
    const res = row ? row.notify_prices_global : 1;
    tursoCloudSync.pushMutation(
      `UPDATE users SET notify_prices_global = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?`,
      [res, tgId],
      true
    );
    return res;
  }

  toggleAdminNewUsers(tgId: number): number {
    const row = this.stmtToggleAdminNewUsers.get(tgId) as { notify_admin_new_users: number } | undefined;
    const res = row ? row.notify_admin_new_users : 1;
    tursoCloudSync.pushMutation(
      `UPDATE users SET notify_admin_new_users = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?`,
      [res, tgId],
      true
    );
    return res;
  }

  deactivateUser(tgId: number): void {
    this.stmtDeactivate.run(tgId);
    tursoCloudSync.pushMutation(
      `UPDATE users SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?`,
      [tgId],
      true
    );
  }

  deactivateUsersBatch(tgIds: number[]): void {
    if (tgIds.length === 0) return;
    this.txDeactivateBatch(tgIds);
    for (const tgId of tgIds) {
      tursoCloudSync.pushMutation(
        `UPDATE users SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?`,
        [tgId]
      );
    }
  }

  reactivateUser(tgId: number): void {
    this.stmtReactivate.run(tgId);
    tursoCloudSync.pushMutation(
      `UPDATE users SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?`,
      [tgId]
    );
  }

  getUserStats(): { total: number; active: number; blocked: number } {
    const row = this.stmtGetStats.get() as any;
    return {
      total: Number(row?.total || 0),
      active: Number(row?.active || 0),
      blocked: Number(row?.blocked || 0),
    };
  }

  setAdmin(tgId: number, isAdmin: boolean): void {
    this.stmtSetAdmin.run(isAdmin ? 1 : 0, tgId);
    tursoCloudSync.pushMutation(
      `UPDATE users SET is_admin = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?`,
      [isAdmin ? 1 : 0, tgId]
    );
  }

  isAdmin(tgId: number): boolean {
    const row = this.stmtIsAdmin.get(tgId) as { is_admin: number } | undefined;
    return Boolean(row && row.is_admin === 1);
  }

  getAllAdminTelegramIds(envAdminIds: number[] = []): number[] {
    const dbRows = this.stmtGetAllAdmins.all() as Array<{ telegram_id: number }>;
    const allIds = new Set<number>(envAdminIds);
    for (const r of dbRows) {
      if (r.telegram_id) allIds.add(r.telegram_id);
    }
    return Array.from(allIds);
  }
}
