/**
 * src/db/dao/activeDashboards.ts
 * Data Access Object for Persistent Telegram LiveSync Dashboards
 */

import Database from "better-sqlite3";
import { ActiveDashboardRecord, SupportedLanguage } from "../../types/db.js";
import { tursoCloudSync } from "../tursoSync.js";

export class ActiveDashboardDAO {
  private stmtUpsert: Database.Statement;
  private stmtUpdateView: Database.Statement;
  private stmtTouchInteraction: Database.Statement;
  private stmtUpdateEditSuccess: Database.Statement;
  private stmtIncrementError: Database.Statement;
  private stmtDelete: Database.Statement;
  private stmtGetByChatId: Database.Statement;
  private stmtGetHydrationCandidates: Database.Statement;
  private stmtPruneOld: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.stmtUpsert = db.prepare(`
      INSERT INTO active_dashboards (
        chat_id, message_id, user_id, view_type, pool_slug, language,
        last_rendered_text_hash, last_rendered_keyboard_hash,
        last_telegram_edit_at, last_interaction_at, consecutive_errors, updated_at
      ) VALUES (
        @chat_id, @message_id, @user_id, @view_type, @pool_slug, @language,
        @last_rendered_text_hash, @last_rendered_keyboard_hash,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0, CURRENT_TIMESTAMP
      )
      ON CONFLICT(chat_id) DO UPDATE SET
        message_id = excluded.message_id,
        user_id = excluded.user_id,
        view_type = excluded.view_type,
        pool_slug = excluded.pool_slug,
        language = excluded.language,
        last_interaction_at = CURRENT_TIMESTAMP,
        consecutive_errors = 0,
        updated_at = CURRENT_TIMESTAMP
    `);

    this.stmtUpdateView = db.prepare(`
      UPDATE active_dashboards SET
        view_type = @view_type,
        pool_slug = @pool_slug,
        language = @language,
        message_id = CASE WHEN @message_id > 0 THEN @message_id ELSE message_id END,
        last_interaction_at = CURRENT_TIMESTAMP,
        consecutive_errors = 0,
        updated_at = CURRENT_TIMESTAMP
      WHERE chat_id = @chat_id
    `);

    this.stmtTouchInteraction = db.prepare(`
      UPDATE active_dashboards SET
        last_interaction_at = CURRENT_TIMESTAMP,
        consecutive_errors = 0,
        updated_at = CURRENT_TIMESTAMP
      WHERE chat_id = ?
    `);

    this.stmtUpdateEditSuccess = db.prepare(`
      UPDATE active_dashboards SET
        last_rendered_text_hash = @last_rendered_text_hash,
        last_telegram_edit_at = CURRENT_TIMESTAMP,
        consecutive_errors = 0,
        updated_at = CURRENT_TIMESTAMP
      WHERE chat_id = @chat_id
    `);

    this.stmtIncrementError = db.prepare(`
      UPDATE active_dashboards SET
        consecutive_errors = consecutive_errors + 1,
        updated_at = CURRENT_TIMESTAMP
      WHERE chat_id = ?
    `);

    this.stmtDelete = db.prepare(`
      DELETE FROM active_dashboards WHERE chat_id = ?
    `);

    this.stmtGetByChatId = db.prepare(`
      SELECT * FROM active_dashboards WHERE chat_id = ?
    `);

    // Hydrate sessions active within the Telegram 48-hour edit window
    this.stmtGetHydrationCandidates = db.prepare(`
      SELECT * FROM active_dashboards
      WHERE last_interaction_at >= datetime('now', '-48 hours')
        AND consecutive_errors < 3
    `);

    // Purge rows older than 48 hours (cannot be edited in Telegram anyway)
    this.stmtPruneOld = db.prepare(`
      DELETE FROM active_dashboards
      WHERE last_interaction_at < datetime('now', '-48 hours')
         OR consecutive_errors >= 3
    `);
  }

  public upsert(record: {
    chat_id: number;
    message_id: number;
    user_id: number;
    view_type: string;
    pool_slug?: string | null;
    language: SupportedLanguage;
    last_rendered_text_hash?: number;
    last_rendered_keyboard_hash?: number;
  }): void {
    this.stmtUpsert.run({
      chat_id: record.chat_id,
      message_id: record.message_id,
      user_id: record.user_id,
      view_type: record.view_type,
      pool_slug: record.pool_slug ?? null,
      language: record.language,
      last_rendered_text_hash: record.last_rendered_text_hash ?? 0,
      last_rendered_keyboard_hash: record.last_rendered_keyboard_hash ?? 0,
    });

    tursoCloudSync.pushMutation(
      `INSERT INTO active_dashboards (
        chat_id, message_id, user_id, view_type, pool_slug, language,
        last_rendered_text_hash, last_rendered_keyboard_hash,
        last_telegram_edit_at, last_interaction_at, consecutive_errors, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0, CURRENT_TIMESTAMP)
      ON CONFLICT(chat_id) DO UPDATE SET
        message_id = excluded.message_id,
        user_id = excluded.user_id,
        view_type = excluded.view_type,
        pool_slug = excluded.pool_slug,
        language = excluded.language,
        last_interaction_at = CURRENT_TIMESTAMP,
        consecutive_errors = 0,
        updated_at = CURRENT_TIMESTAMP`,
      [
        record.chat_id,
        record.message_id,
        record.user_id,
        record.view_type,
        record.pool_slug ?? null,
        record.language,
        record.last_rendered_text_hash ?? 0,
        record.last_rendered_keyboard_hash ?? 0,
      ],
      true
    );
  }

  public updateView(chatId: number, viewType: string, poolSlug?: string, lang?: SupportedLanguage, messageId?: number): void {
    const existing = this.stmtGetByChatId.get(chatId) as ActiveDashboardRecord | undefined;
    if (!existing) return;
    this.stmtUpdateView.run({
      chat_id: chatId,
      view_type: viewType,
      pool_slug: poolSlug !== undefined ? poolSlug : existing.pool_slug,
      language: lang || existing.language,
      message_id: messageId || 0,
    });

    tursoCloudSync.pushMutation(
      `UPDATE active_dashboards SET
        view_type = ?,
        pool_slug = ?,
        language = ?,
        message_id = CASE WHEN ? > 0 THEN ? ELSE message_id END,
        last_interaction_at = CURRENT_TIMESTAMP,
        consecutive_errors = 0,
        updated_at = CURRENT_TIMESTAMP
      WHERE chat_id = ?`,
      [
        viewType,
        poolSlug !== undefined ? poolSlug : existing.pool_slug,
        lang || existing.language,
        messageId || 0,
        messageId || 0,
        chatId,
      ]
    );
  }

  public touchInteraction(chatId: number): void {
    this.stmtTouchInteraction.run(chatId);
    tursoCloudSync.pushMutation(
      `UPDATE active_dashboards SET
        last_interaction_at = CURRENT_TIMESTAMP,
        consecutive_errors = 0,
        updated_at = CURRENT_TIMESTAMP
      WHERE chat_id = ?`,
      [chatId]
    );
  }

  public markEditSuccess(chatId: number, textHash: number): void {
    this.stmtUpdateEditSuccess.run({ chat_id: chatId, last_rendered_text_hash: textHash });
    tursoCloudSync.pushMutation(
      `UPDATE active_dashboards SET
        last_rendered_text_hash = ?,
        last_telegram_edit_at = CURRENT_TIMESTAMP,
        consecutive_errors = 0,
        updated_at = CURRENT_TIMESTAMP
      WHERE chat_id = ?`,
      [textHash, chatId]
    );
  }

  public incrementError(chatId: number): void {
    this.stmtIncrementError.run(chatId);
  }

  public delete(chatId: number): void {
    this.stmtDelete.run(chatId);
    tursoCloudSync.pushMutation(
      `DELETE FROM active_dashboards WHERE chat_id = ?`,
      [chatId],
      true
    );
  }

  public getHydrationCandidates(): ActiveDashboardRecord[] {
    return this.stmtGetHydrationCandidates.all() as ActiveDashboardRecord[];
  }

  public pruneStale(): number {
    const res = this.stmtPruneOld.run();
    tursoCloudSync.pushMutation(
      `DELETE FROM active_dashboards
      WHERE last_interaction_at < datetime('now', '-48 hours')
         OR consecutive_errors >= 3`
    );
    return res.changes;
  }
}
