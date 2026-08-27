import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";
import { InputFile } from "grammy";
import { BotContext } from "../../types/context.js";
import { config, isUserAdmin } from "../../config/env.js";
import { UserDAO } from "../../db/dao/users.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { escapeHtml } from "../../i18n/index.js";

async function computeFileSha256(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  await pipeline(stream, hash);
  return hash.digest("hex");
}

export function createBackupHandler(
  db: Database.Database,
  userDao: UserDAO,
  subDao: SubscriptionDAO
) {
  return async (ctx: BotContext) => {
    if (!ctx.from) return;

    if (!isUserAdmin(ctx.from.id, userDao)) {
      await ctx.reply(
        ctx.t("admin.unauthorized", { telegram_id: String(ctx.from.id) }),
        { parse_mode: "HTML" }
      );
      return;
    }

    const statusMsg = await ctx.reply(
      ctx.t("admin.backup_in_progress"),
      { parse_mode: "HTML" }
    );

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const randomSuffix = crypto.randomBytes(3).toString("hex");
    const tmpBackupPath = path.join(
      os.tmpdir(),
      `backup_cheapestinference_${timestamp}_${randomSuffix}.db`
    );

    try {
      if (fs.existsSync(tmpBackupPath)) {
        try {
          fs.rmSync(tmpBackupPath, { force: true });
        } catch {}
      }

      // Pre-flight database integrity verification before taking snapshot
      const integrityCheck = db.pragma("quick_check", { simple: true });
      if (integrityCheck !== "ok") {
        throw new Error(`Database integrity check failed: ${integrityCheck}`);
      }

      const startTime = Date.now();

      // Zero-lock live snapshot (holds SQLITE_READLOCK, active writes append to WAL uninterrupted)
      db.prepare("VACUUM INTO ?").run(tmpBackupPath);

      const durationMs = Date.now() - startTime;
      const fileStats = fs.statSync(tmpBackupPath);
      const sizeMb = (fileStats.size / (1024 * 1024)).toFixed(2);

      // Compute SHA-256 via streaming (O(1) memory < 64KB)
      const sha256Hash = await computeFileSha256(tmpBackupPath);

      const userStats = userDao.getUserStats();
      const subStats = subDao.getSubscriptionStats();

      const caption = [
        `💾 <b>CheapestInference SQLite Database Snapshot</b>`,
        `━━━━━━━━━━━━━━━━━━━━━━━━`,
        `📅 <b>Date:</b> <code>${new Date().toISOString()}</code>`,
        `📦 <b>File Size:</b> <code>${sizeMb} MB</code> (${fileStats.size.toLocaleString()} bytes)`,
        `⚡ <b>Snapshot Time:</b> <code>${durationMs}ms</code>`,
        `👥 <b>Total Users:</b> <code>${userStats.total}</code> (Active: ${userStats.active})`,
        `🔔 <b>Subscribed Users:</b> <code>${subStats.subscribedUsers}</code> (${subStats.totalRules} rule matrix rows)`,
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
      await ctx.reply(`❌ <b>Backup failed:</b> <code>${escapeHtml(err.message)}</code>`, {
        parse_mode: "HTML",
      });
    } finally {
      if (fs.existsSync(tmpBackupPath)) {
        try {
          fs.rmSync(tmpBackupPath, { force: true });
        } catch {}
      }
    }
  };
}
