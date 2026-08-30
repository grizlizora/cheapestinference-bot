import { describe, it, expect, vi } from "vitest";
import { TursoCloudSync } from "../src/db/tursoSync.js";
import Database from "better-sqlite3";
import fs from "node:fs";

describe("TursoCloudSync Universal Cloud Sync Suite", () => {
  it("1. should remain completely disabled and no-op when URL or token is missing", async () => {
    const sync = new TursoCloudSync(undefined, undefined);
    expect(sync.isEnabled()).toBe(false);

    // Calling pull/push/flush should be completely safe and immediate
    const db = new Database(":memory:");
    await sync.pullStateFromTurso(db);
    sync.pushMutation("INSERT INTO users VALUES (1)");
    await sync.flush();
    await sync.close();
  });

  it("2. should correctly normalize libsql:// protocol to https://", () => {
    const sync = new TursoCloudSync("libsql://my-test-db-user.turso.io/", "test-token-123");
    expect(sync.isEnabled()).toBe(true);
    expect((sync as any).url).toBe("https://my-test-db-user.turso.io");
    expect((sync as any).token).toBe("test-token-123");
  });

  it("3. should enqueue mutations and debounce batch flushes", async () => {
    const sync = new TursoCloudSync("https://mock-turso.io", "mock-token");
    expect(sync.isEnabled()).toBe(true);

    const executeSpy = vi.spyOn(sync as any, "executePipeline").mockResolvedValue([]);

    sync.pushMutation("UPDATE users SET language = ?", ["uk"]);
    sync.pushMutation("UPDATE users SET is_muted = 1 WHERE telegram_id = ?", [12345]);

    expect((sync as any).pendingMutations.length).toBe(2);

    await sync.flush();

    expect((sync as any).pendingMutations.length).toBe(0);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith([
      { type: "execute", stmt: { sql: "UPDATE users SET language = ?", args: ["uk"] } },
      { type: "execute", stmt: { sql: "UPDATE users SET is_muted = 1 WHERE telegram_id = ?", args: [12345] } },
    ]);
  });

  it("4. should pull active_dashboards from Turso and hydrate into SQLite", async () => {
    const sync = new TursoCloudSync("https://mock-turso.io", "mock-token");
    const testDb = new Database(":memory:");
    testDb.exec(`
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
        UNIQUE(user_id, pool_slug, block_id)
      );
      CREATE TABLE IF NOT EXISTS donations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        telegram_id INTEGER NOT NULL,
        amount_stars INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'XTR',
        telegram_payment_charge_id TEXT NOT NULL UNIQUE,
        provider_payment_charge_id TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
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
        description TEXT,
        infra_spec TEXT,
        manual_provisioning INTEGER NOT NULL DEFAULT 0,
        last_changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(pool_slug, block_id)
      );
      CREATE TABLE IF NOT EXISTS active_dashboards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL UNIQUE,
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
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
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
    `);

    vi.spyOn(sync as any, "initRemoteSchema").mockResolvedValue(undefined);
    vi.spyOn(sync as any, "executePipeline").mockResolvedValue([
      { response: { result: { cols: [], rows: [] } } }, // users
      { response: { result: { cols: [], rows: [] } } }, // subs
      { response: { result: { cols: [], rows: [] } } }, // donations
      { response: { result: { cols: [], rows: [] } } }, // pool_state
      {
        response: {
          result: {
            cols: [
              { name: "chat_id" },
              { name: "message_id" },
              { name: "user_id" },
              { name: "view_type" },
              { name: "pool_slug" },
              { name: "language" },
              { name: "last_interaction_at" },
            ],
            rows: [
              [
                { value: 77777 },
                { value: 888 },
                { value: 1 },
                { value: "dashboard" },
                { value: null },
                { value: "uk" },
                { value: "2026-08-29 18:00:00" },
              ],
            ],
          },
        },
      },
      { response: { result: { cols: [], rows: [] } } }, // slot_lifecycle_history
      { response: { result: { cols: [], rows: [] } } }, // slot_price_history
      { response: { result: { cols: [], rows: [] } } }, // catalog_history
    ]);

    await sync.pullStateFromTurso(testDb);

    const saved = testDb.prepare("SELECT * FROM active_dashboards WHERE chat_id = 77777").get() as any;
    expect(saved).toBeDefined();
    expect(saved.message_id).toBe(888);
    expect(saved.language).toBe("uk");
    expect(saved.view_type).toBe("dashboard");
  });
});
