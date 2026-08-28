import Database from "better-sqlite3";
import { DonationRecord } from "../../types/db.js";
import { tursoCloudSync } from "../tursoSync.js";

export class DonationDAO {
  private stmtInsert: Database.Statement;
  private stmtGetByChargeId: Database.Statement;
  private stmtGetUserTotal: Database.Statement;
  private stmtGetGlobalTotal: Database.Statement;
  private stmtGetTopDonators: Database.Statement;
  private stmtGetRecent: Database.Statement;
  private txRecordDonation: (
    userId: number,
    telegramId: number,
    amountStars: number,
    chargeId: string,
    providerChargeId?: string
  ) => DonationRecord;

  constructor(public readonly db: Database.Database) {
    this.stmtInsert = db.prepare(`
      INSERT INTO donations (user_id, telegram_id, amount_stars, currency, telegram_payment_charge_id, provider_payment_charge_id)
      VALUES (?, ?, ?, 'XTR', ?, ?)
      RETURNING *
    `);

    this.stmtGetByChargeId = db.prepare(`
      SELECT * FROM donations WHERE telegram_payment_charge_id = ?
    `);

    this.stmtGetUserTotal = db.prepare(`
      SELECT COALESCE(SUM(amount_stars), 0) as total FROM donations WHERE user_id = ?
    `);

    this.stmtGetGlobalTotal = db.prepare(`
      SELECT COALESCE(SUM(amount_stars), 0) as total FROM donations
    `);

    this.stmtGetTopDonators = db.prepare(`
      SELECT 
        u.id as user_id,
        u.telegram_id,
        u.username,
        u.first_name,
        u.total_donated_stars as total_stars
      FROM users u
      WHERE u.total_donated_stars > 0
      ORDER BY u.total_donated_stars DESC
      LIMIT ?
    `);

    this.stmtGetRecent = db.prepare(`
      SELECT * FROM donations ORDER BY created_at DESC LIMIT ?
    `);

    // Atomic transaction: Insert donation record AND increment user total_donated_stars
    const updateStarsStmt = db.prepare(`
      UPDATE users 
      SET total_donated_stars = COALESCE(total_donated_stars, 0) + ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    this.txRecordDonation = db.transaction(
      (
        userId: number,
        telegramId: number,
        amountStars: number,
        chargeId: string,
        providerChargeId?: string
      ): DonationRecord => {
        // Prevent duplicate charge processing (idempotence)
        const existing = this.stmtGetByChargeId.get(chargeId) as DonationRecord | undefined;
        if (existing) {
          return existing;
        }

        const inserted = this.stmtInsert.get(
          userId,
          telegramId,
          amountStars,
          chargeId,
          providerChargeId || null
        ) as DonationRecord;

        updateStarsStmt.run(amountStars, userId);

        tursoCloudSync.pushMutation(
          `INSERT OR IGNORE INTO donations (id, user_id, telegram_id, amount_stars, currency, telegram_payment_charge_id, provider_payment_charge_id, created_at)
           VALUES (?, ?, ?, ?, 'XTR', ?, ?, CURRENT_TIMESTAMP)`,
          [inserted.id, userId, telegramId, amountStars, chargeId, providerChargeId || null]
        );

        tursoCloudSync.pushMutation(
          `UPDATE users SET total_donated_stars = COALESCE(total_donated_stars, 0) + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [amountStars, userId]
        );

        return inserted;
      }
    );
  }

  public recordDonation(
    userId: number,
    telegramId: number,
    amountStars: number,
    chargeId: string,
    providerChargeId?: string
  ): DonationRecord {
    return this.txRecordDonation(userId, telegramId, amountStars, chargeId, providerChargeId);
  }

  public getByChargeId(chargeId: string): DonationRecord | undefined {
    return this.stmtGetByChargeId.get(chargeId) as DonationRecord | undefined;
  }

  public getUserTotalDonated(userId: number): number {
    const row = this.stmtGetUserTotal.get(userId) as { total: number } | undefined;
    return row?.total || 0;
  }

  public getGlobalTotalDonated(): number {
    const row = this.stmtGetGlobalTotal.get() as { total: number } | undefined;
    return row?.total || 0;
  }

  public getTopDonators(limit = 10): Array<{
    user_id: number;
    telegram_id: number;
    username: string | null;
    first_name: string;
    total_stars: number;
  }> {
    return this.stmtGetTopDonators.all(limit) as any[];
  }

  public getRecentDonations(limit = 20): DonationRecord[] {
    return this.stmtGetRecent.all(limit) as DonationRecord[];
  }
}
