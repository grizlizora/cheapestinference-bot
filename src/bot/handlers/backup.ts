import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { InputFile } from "grammy";
import { BotContext } from "../../types/context.js";
import { config } from "../../config/env.js";
import { UserDAO } from "../../db/dao/users.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";

export function createBackupHandler(
  db: Database.Database,
  userDao: UserDAO,
  subDao: SubscriptionDAO
) {
  return async (ctx: BotContext) => {
    if (!ctx.from) return;

    const isAdmin =
      config.ADMIN_USER_IDS.length === 0 ||
      config.ADMIN_USER_IDS.includes(ctx.from.id);

    if (!isAdmin) {
      await ctx.reply(ctx.t("admin.unauthorized"));
      return;
    }

    const statusMsg = await ctx.reply(
      "⏳ <i>Generating hot online database snapshot (`VACUUM INTO`)...</i>",
      { parse_mode: "HTML" }
    );

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const tmpBackupPath = path.resolve(`/tmp/backup_cheapestinference_${timestamp}.db`);

    try {
      const startTime = Date.now();

      // Zero-lock live snapshot
      db.prepare("VACUUM INTO ?").run(tmpBackupPath);

      const durationMs = Date.now() - startTime;
      const fileStats = fs.statSync(tmpBackupPath);
      const sizeMb = (fileStats.size / (1024 * 1024)).toFixed(2);

      // Compute SHA-256 checksum
      const fileBuffer = fs.readFileSync(tmpBackupPath);
      const sha256Hash = crypto.createHash("sha256").update(fileBuffer).digest("hex");

      const userStats = userDao.getUserStats();
      const activeSubs = subDao.getTotalActiveSubscriptions();

      const caption = [
        `💾 <b>CheapestInference SQLite Database Snapshot</b>`,
        `━━━━━━━━━━━━━━━━━━━━━━━━`,
        `📅 <b>Date:</b> <code>${new Date().toISOString()}</code>`,
        `📦 <b>File Size:</b> <code>${sizeMb} MB</code> (${fileStats.size.toLocaleString()} bytes)`,
        `⚡ <b>Snapshot Time:</b> <code>${durationMs}ms</code>`,
        `👥 <b>Total Users:</b> <code>${userStats.total}</code> (Active: ${userStats.active})`,
        `🔔 <b>Active Subscriptions:</b> <code>${activeSubs}</code>`,
        `🔒 <b>SHA-256:</b> <code>${sha256Hash.substring(0, 16)}...${sha256Hash.substring(48)}</code>`,
      ].join("\n");

      // Send document to admin chat
      await ctx.replyWithDocument(
        new InputFile(tmpBackupPath, `cheapestinference_${timestamp}.db`),
        {
          caption,
          parse_mode: "HTML",
        }
      );

      if (ctx.chat) {
        await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      }
    } catch (err: any) {
      console.error("❌ [Backup Error] Failed to generate/send SQLite snapshot:", err);
      await ctx.reply(`❌ <b>Backup failed:</b> <code>${err.message}</code>`, {
        parse_mode: "HTML",
      });
    } finally {
      if (fs.existsSync(tmpBackupPath)) {
        try {
          fs.unlinkSync(tmpBackupPath);
        } catch {}
      }
    }
  };
}
