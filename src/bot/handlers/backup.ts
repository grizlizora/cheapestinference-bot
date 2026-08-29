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
import { escapeHtml, stripLeadingEmoji } from "../../i18n/index.js";
import { icon } from "../views/iconTheme.js";

async function computeFileSha256(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  await pipeline(stream, hash);
  return hash.digest("hex");
}

function escapeCsv(field: any): string {
  if (field === null || field === undefined) return '""';
  const str = String(field);
  return `"${str.replace(/"/g, '""')}"`;
}

/**
 * 1. Generates and sends an Excel-compatible UTF-8 BOM CSV export of all users and their granular subscriptions
 */
export function createUsersExportHandler(
  db: Database.Database,
  userDao: UserDAO,
  subDao: SubscriptionDAO
) {
  return async (ctx: BotContext) => {
    if (!ctx.from) return;

    if (!isUserAdmin(ctx.from.id, userDao, ctx.from.username)) {
      await ctx.reply(
        ctx.t("admin.unauthorized", { telegram_id: String(ctx.from.id) }),
        { parse_mode: "HTML" }
      );
      return;
    }

    const progressText = `${icon("nav_clock")} ${stripLeadingEmoji(ctx.t("admin.export_users_in_progress"))}`;
    const statusMsg = await ctx.reply(progressText, {
      parse_mode: "HTML",
    });

    try {
      const usersStmt = db.prepare(`SELECT * FROM users ORDER BY id ASC`);
      const allUsers = usersStmt.all() as any[];

      const subsStmt = db.prepare(`SELECT * FROM subscriptions ORDER BY user_id ASC, pool_slug ASC, block_id ASC`);
      const allSubs = subsStmt.all() as any[];

      const userSubsMap = new Map<number, any[]>();
      for (const s of allSubs) {
        if (!userSubsMap.has(s.user_id)) {
          userSubsMap.set(s.user_id, []);
        }
        userSubsMap.get(s.user_id)!.push(s);
      }

      const headers = [
        "User ID",
        "Telegram ID",
        "Username",
        "First Name",
        "Language",
        "Sound Muted",
        "Is Active",
        "Is Admin",
        "Global Filters (Avail/Sold/Models/Prices)",
        "Subscribed Tariffs & Regional Blocks",
        "Registered At (UTC)",
        "Last Active At (UTC)",
      ];

      const csvRows: string[] = [];
      // UTF-8 BOM (\uFEFF) ensures Excel automatically opens Ukrainian/Russian Cyrillic characters in clean columns
      csvRows.push("\uFEFF" + headers.map(escapeCsv).join(","));

      for (const u of allUsers) {
        const subs = userSubsMap.get(u.id) || [];
        const subsFormatted = subs.length > 0
          ? subs.map((s) => `${s.pool_slug.toUpperCase()}:${s.block_id}`).join("; ")
          : "None";

        const filtersFormatted = `Avail: ${u.notify_available_global ? "YES" : "NO"} | Sold: ${u.notify_sold_out_global ? "YES" : "NO"} | Models: ${u.notify_models_global ? "YES" : "NO"} | Prices: ${u.notify_prices_global ? "YES" : "NO"}`;

        const row = [
          u.id,
          u.telegram_id,
          u.username ? `@${u.username}` : "N/A",
          u.first_name || "",
          u.language || "en",
          u.is_muted ? "MUTED" : "UNMUTED",
          u.is_active ? "ACTIVE" : "BLOCKED",
          u.is_admin ? "ADMIN" : "USER",
          filtersFormatted,
          subsFormatted,
          u.created_at || "N/A",
          u.last_active_at || "N/A",
        ];
        csvRows.push(row.map(escapeCsv).join(","));
      }

      const csvBuffer = Buffer.from(csvRows.join("\r\n"), "utf8");
      const timestamp = new Date().toISOString().slice(0, 10);
      const filename = `users_cheapestinference_${timestamp}.csv`;

      const stats = userDao.getUserStats();
      const activeSubsCount = subDao.getTotalActiveSubscriptions();

      const lang = ctx.lang || "en";
      const title = lang === "uk"
        ? `${icon("nav_admin")} <b>CheapestInference — Звіт користувачів (Excel/CSV)</b>`
        : lang === "ru"
        ? `${icon("nav_admin")} <b>CheapestInference — Отчёт пользователей (Excel/CSV)</b>`
        : `${icon("nav_admin")} <b>CheapestInference — Users Report (Excel/CSV)</b>`;

      const dateLabel = lang === "uk" ? "Дата вивантаження:" : lang === "ru" ? "Дата выгрузки:" : "Export Date:";
      const totalUsersLabel = lang === "uk" ? "Всього користувачів:" : lang === "ru" ? "Всего пользователей:" : "Total Users:";
      const activeLabel = lang === "uk" ? "Активні" : lang === "ru" ? "Активные" : "Active";
      const blockedLabel = lang === "uk" ? "Заблокували" : lang === "ru" ? "Заблокировали" : "Blocked";
      const rulesLabel = lang === "uk" ? "Всього правил підписок:" : lang === "ru" ? "Всего правил подписок:" : "Total Subscriptions:";
      const formatLabel = lang === "uk" ? "Формат:" : lang === "ru" ? "Формат:" : "Format:";
      const tipText = lang === "uk"
        ? "\n💡 <i>Файл можна відкрити в Microsoft Excel, Google Таблицях або Apple Numbers.</i>"
        : lang === "ru"
        ? "\n💡 <i>Файл можно открыть в Microsoft Excel, Google Таблицах или Apple Numbers.</i>"
        : "\n💡 <i>File can be opened in Microsoft Excel, Google Sheets, or Apple Numbers.</i>";

      const caption = [
        title,
        "",
        `${icon("nav_clock")} <b>${dateLabel}</b> <code>${new Date().toISOString()}</code>`,
        `<tg-emoji emoji-id="5372926953978341366">👥</tg-emoji> <b>${totalUsersLabel}</b> <code>${stats.total}</code> (${activeLabel}: ${stats.active}, ${blockedLabel}: ${stats.blocked})`,
        `${icon("notify_bell_on")} <b>${rulesLabel}</b> <code>${activeSubsCount}</code>`,
        `${icon("nav_chart")} <b>${formatLabel}</b> <code>CSV UTF-8 (Excel-Ready)</code>`,
        tipText,
      ].join("\n");

      await ctx.replyWithDocument(new InputFile(csvBuffer, filename), {
        caption,
        parse_mode: "HTML",
      });

      if (ctx.chat) {
        await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      }
    } catch (err: any) {
      console.error("❌ [Users Export Error]:", err);
      await ctx.reply(`❌ <b>Export failed:</b> <code>${escapeHtml(err.message)}</code>`, {
        parse_mode: "HTML",
      });
    }
  };
}

/**
 * 2. Generates and sends an Excel-compatible UTF-8 BOM CSV export of the ENTIRE historical change log
 */
export function createHistoryExportHandler(
  db: Database.Database,
  userDao: UserDAO
) {
  return async (ctx: BotContext) => {
    if (!ctx.from) return;

    if (!isUserAdmin(ctx.from.id, userDao, ctx.from.username)) {
      await ctx.reply(
        ctx.t("admin.unauthorized", { telegram_id: String(ctx.from.id) }),
        { parse_mode: "HTML" }
      );
      return;
    }

    const progressText = `${icon("nav_clock")} ${stripLeadingEmoji(ctx.t("admin.export_history_in_progress"))}`;
    const statusMsg = await ctx.reply(progressText, {
      parse_mode: "HTML",
    });

    try {
      // 1. Fetch Slot Lifecycles
      const slotsStmt = db.prepare(`
        SELECT 
          opened_at as event_time,
          'SLOT_LIFECYCLE' as category,
          initial_status as event_type,
          pool_slug,
          block_id,
          price_month as current_price,
          '' as old_price,
          '' as price_delta,
          '' as percent_delta,
          duration_seconds,
          closed_at,
          'Opened at: ' || opened_at || CASE WHEN closed_at IS NOT NULL THEN ' | Closed at: ' || closed_at ELSE ' (STILL OPEN)' END as details
        FROM slot_lifecycle_history
      `);
      const slotRows = slotsStmt.all() as any[];

      // 2. Fetch Catalog / Model Upgrades / Base Price Updates
      const catalogStmt = db.prepare(`
        SELECT 
          detected_at as event_time,
          'CATALOG_EVENT' as category,
          event_type,
          pool_slug,
          'ALL' as block_id,
          new_min_price as current_price,
          previous_min_price as old_price,
          '' as price_delta,
          '' as percent_delta,
          NULL as duration_seconds,
          NULL as closed_at,
          'Pool: ' || pool_name || ' | Models: ' || all_models_json || CASE WHEN added_models_json != '[]' THEN ' | Added: ' || added_models_json ELSE '' END || CASE WHEN upgraded_models_json != '[]' THEN ' | Upgraded: ' || upgraded_models_json ELSE '' END || CASE WHEN removed_models_json != '[]' THEN ' | Removed: ' || removed_models_json ELSE '' END as details
        FROM catalog_history
      `);
      const catalogRows = catalogStmt.all() as any[];

      // 3. Fetch Slot Price Changes
      const priceStmt = db.prepare(`
        SELECT 
          changed_at as event_time,
          'PRICE_CHANGE' as category,
          'PRICE_DELTA' as event_type,
          pool_slug,
          block_id,
          new_price as current_price,
          old_price,
          price_delta,
          percent_delta,
          NULL as duration_seconds,
          NULL as closed_at,
          'Price shifted from ' || old_price || ' to ' || new_price || ' (Delta: ' || price_delta || '$ / ' || percent_delta || '%)' as details
        FROM slot_price_history
      `);
      const priceRows = priceStmt.all() as any[];

      // Combine and sort chronologically DESC
      const combined = [...slotRows, ...catalogRows, ...priceRows].sort((a, b) => {
        return new Date(b.event_time).getTime() - new Date(a.event_time).getTime();
      });

      const headers = [
        "Date & Time (UTC)",
        "Category",
        "Event Type",
        "Tariff / Pool",
        "Region Block",
        "Current / New Price",
        "Old Price",
        "Price Delta ($)",
        "Percent Delta (%)",
        "Slot Lifespan (Seconds)",
        "Slot Lifespan (Formatted)",
        "Closed At (UTC)",
        "Full Event Details & Models",
      ];

      const csvRows: string[] = [];
      csvRows.push("\uFEFF" + headers.map(escapeCsv).join(","));

      for (const item of combined) {
        let durationFormatted = "";
        if (item.duration_seconds !== null && item.duration_seconds !== undefined) {
          const sec = Number(item.duration_seconds);
          if (sec < 60) durationFormatted = `${sec}s`;
          else if (sec < 3600) durationFormatted = `${Math.round(sec / 60)} min`;
          else durationFormatted = `${(sec / 3600).toFixed(1)} h`;
        }

        const row = [
          item.event_time || "N/A",
          item.category,
          item.event_type,
          String(item.pool_slug || "").toUpperCase(),
          String(item.block_id || "").toUpperCase(),
          item.current_price || "",
          item.old_price || "",
          item.price_delta !== null && item.price_delta !== undefined ? item.price_delta : "",
          item.percent_delta !== null && item.percent_delta !== undefined ? item.percent_delta : "",
          item.duration_seconds !== null && item.duration_seconds !== undefined ? item.duration_seconds : "",
          durationFormatted,
          item.closed_at || (item.category === "SLOT_LIFECYCLE" ? "ACTIVE / OPEN" : ""),
          item.details || "",
        ];
        csvRows.push(row.map(escapeCsv).join(","));
      }

      const csvBuffer = Buffer.from(csvRows.join("\r\n"), "utf8");
      const timestamp = new Date().toISOString().slice(0, 10);
      const filename = `history_cheapestinference_${timestamp}.csv`;

      const lang = ctx.lang || "en";
      const title = lang === "uk"
        ? `${icon("event_tier_update")} <b>CheapestInference — Повна історія всіх змін (Excel/CSV)</b>`
        : lang === "ru"
        ? `${icon("event_tier_update")} <b>CheapestInference — Полная история всех изменений (Excel/CSV)</b>`
        : `${icon("event_tier_update")} <b>CheapestInference — Full Change History (Excel/CSV)</b>`;

      const dateLabel = lang === "uk" ? "Дата вивантаження:" : lang === "ru" ? "Дата выгрузки:" : "Export Date:";
      const totalRecLabel = lang === "uk" ? "Всього історичних записів:" : lang === "ru" ? "Всего исторических записей:" : "Total Historic Records:";
      const includesLabel = lang === "uk" ? "Включає:" : lang === "ru" ? "Включает:" : "Includes:";
      const includesDesc = lang === "uk"
        ? "відкриття/закриття слотів, час життя в наявності, історія змін цін, оновлення моделей ШІ."
        : lang === "ru"
        ? "открытие/закрытие слотов, время жизни в наличии, история изменений цен, обновления моделей ИИ."
        : "slot open/close events, active lifespan, price change history, and AI model upgrades.";
      const formatLabel = lang === "uk" ? "Формат:" : lang === "ru" ? "Формат:" : "Format:";
      const tipText = lang === "uk"
        ? "\n💡 <i>Файл зручно аналізувати та будувати графіки в Excel або Google Таблицях.</i>"
        : lang === "ru"
        ? "\n💡 <i>Файл удобно анализировать и строить графики в Excel или Google Таблицах.</i>"
        : "\n💡 <i>Convenient for analysis and charts in Microsoft Excel or Google Sheets.</i>";

      const caption = [
        title,
        `━━━━━━━━━━━━━━━━━━━━━━━━`,
        `${icon("nav_clock")} <b>${dateLabel}</b> <code>${new Date().toISOString()}</code>`,
        `${icon("nav_chart")} <b>${totalRecLabel}</b> <code>${combined.length}</code>`,
        `${icon("event_slot_drop")} <b>${includesLabel}</b> ${includesDesc}`,
        `${icon("pool_generic")} <b>${formatLabel}</b> <code>CSV UTF-8 (Excel-Ready)</code>`,
        tipText,
      ].join("\n");

      await ctx.replyWithDocument(new InputFile(csvBuffer, filename), {
        caption,
        parse_mode: "HTML",
      });

      if (ctx.chat) {
        await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      }
    } catch (err: any) {
      console.error("❌ [History Export Error]:", err);
      await ctx.reply(`❌ <b>Export failed:</b> <code>${escapeHtml(err.message)}</code>`, {
        parse_mode: "HTML",
      });
    }
  };
}

/**
 * 3. Hot online raw SQLite snapshot (.db)
 */
export function createBackupHandler(
  db: Database.Database,
  userDao: UserDAO,
  subDao: SubscriptionDAO
) {
  return async (ctx: BotContext) => {
    if (!ctx.from) return;

    if (!isUserAdmin(ctx.from.id, userDao, ctx.from.username)) {
      await ctx.reply(
        ctx.t("admin.unauthorized", { telegram_id: String(ctx.from.id) }),
        { parse_mode: "HTML" }
      );
      return;
    }

    const progressText = `${icon("nav_clock")} ${stripLeadingEmoji(ctx.t("admin.backup_in_progress"))}`;
    const statusMsg = await ctx.reply(progressText, {
      parse_mode: "HTML",
    });

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
      const activeSubs = subDao.getTotalActiveSubscriptions();

      const lang = ctx.lang || "en";
      const backupTitle = lang === "uk"
        ? `${icon("pool_core")} <b>CheapestInference — Знімок бази даних SQLite (.db)</b>`
        : lang === "ru"
        ? `${icon("pool_core")} <b>CheapestInference — Снимок базы данных SQLite (.db)</b>`
        : `${icon("pool_core")} <b>CheapestInference SQLite Database Snapshot</b>`;

      const dateLabel = lang === "uk" ? "Дата:" : lang === "ru" ? "Дата:" : "Date:";
      const sizeLabel = lang === "uk" ? "Розмір файлу:" : lang === "ru" ? "Размер файла:" : "File Size:";
      const timeLabel = lang === "uk" ? "Час створення:" : lang === "ru" ? "Время создания:" : "Snapshot Time:";
      const usersLabel = lang === "uk" ? "Всього користувачів:" : lang === "ru" ? "Всего пользователей:" : "Total Users:";
      const activeLabel = lang === "uk" ? "Активні" : lang === "ru" ? "Активные" : "Active";
      const subsLabel = lang === "uk" ? "Активні підписки:" : lang === "ru" ? "Активные подписки:" : "Active Subscriptions:";

      const caption = [
        backupTitle,
        `━━━━━━━━━━━━━━━━━━━━━━━━`,
        `${icon("nav_clock")} <b>${dateLabel}</b> <code>${new Date().toISOString()}</code>`,
        `${icon("pool_generic")} <b>${sizeLabel}</b> <code>${sizeMb} MB</code> (${fileStats.size.toLocaleString()} bytes)`,
        `${icon("event_slot_drop")} <b>${timeLabel}</b> <code>${durationMs}ms</code>`,
        `<tg-emoji emoji-id="5372926953978341366">👥</tg-emoji> <b>${usersLabel}</b> <code>${userStats.total}</code> (${activeLabel}: ${userStats.active})`,
        `${icon("notify_bell_on")} <b>${subsLabel}</b> <code>${activeSubs}</code>`,
        `${icon("event_slot_sold")} <b>SHA-256:</b> <code>${sha256Hash.substring(0, 16)}...${sha256Hash.substring(48)}</code>`,
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
