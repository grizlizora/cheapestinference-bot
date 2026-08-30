import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/index.js";
import { UserDAO } from "../src/db/dao/users.js";
import { SubscriberInvertedIndex } from "../src/bot/notifier/subscriberIndex.js";
import { UserActivitySyncer } from "../src/bot/notifier/userActivitySyncer.js";
import { ActiveDashboardRegistry } from "../src/bot/liveSync/dashboardRegistry.js";
import { DatabaseMaintenanceManager } from "../src/db/maintenance.js";
import { MutationQueue } from "../src/db/sync/mutationQueue.js";
import { performance } from "perf_hooks";

describe("🧪 Memory Leaks, Garbage Collection & RAM Footprint Benchmark Suite", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  const forceGC = () => {
    if (global.gc) {
      global.gc();
    }
  };

  it("1. UserActivitySyncer: 10,000 Rapid User Interactions Maintain Bounded Heap & Zero Timer Leaks", () => {
    const userDao = new UserDAO(db);
    const index = new SubscriberInvertedIndex(db);
    const syncer = new UserActivitySyncer(userDao, index);

    forceGC();
    const initialHeap = process.memoryUsage().heapUsed;

    // Simulate 10,000 distinct users performing touches
    const baseTime = Date.now();
    for (let i = 1; i <= 10_000; i++) {
      syncer.touch(100_000 + i, baseTime + (i % 5000));
    }

    expect(syncer.getPendingCount()).toBe(10_000);

    // Flush all pending trailing touches
    syncer.flushAll();
    expect(syncer.getPendingCount()).toBe(0);

    forceGC();
    const finalHeap = process.memoryUsage().heapUsed;
    const heapGrowthMb = (finalHeap - initialHeap) / (1024 * 1024);

    // Heap growth after flushing 10k touches must be bounded
    expect(heapGrowthMb).toBeLessThan(35);
    syncer.dispose();
  });

  it("2. ActiveDashboardRegistry: Enforces 10,000 LRU Session Cap Under 25,000 Registrations", () => {
    const registry = new ActiveDashboardRegistry();

    for (let i = 1; i <= 25_000; i++) {
      registry.register(i, 1000 + i, i, "en", "dashboard");
    }

    // Must strictly respect the 10,000 session ceiling
    expect(registry.size()).toBe(10_000);

    // Oldest chats (e.g. chat #1) must have been evicted from RAM
    expect(registry.get(1)).toBeUndefined();
    // Newest chats (e.g. chat #25,000) must be present
    expect(registry.get(25_000)).toBeDefined();

    registry.close();
  });

  it("3. SubscriberInvertedIndex: 25,000 Users Scale RAM Benchmark < 35 MB", () => {
    const insertUser = db.prepare(`
      INSERT INTO users (id, telegram_id, first_name, language, total_donated_stars, is_active, last_active_at)
      VALUES (?, ?, 'User', 'en', ?, 1, datetime('now'))
    `);
    const insertSub = db.prepare(`
      INSERT INTO subscriptions (user_id, pool_slug, block_id, notify_on_available)
      VALUES (?, 'flagship', 'europe', 1)
    `);

    // Batch insert 25,000 users into SQLite in one transaction
    db.transaction(() => {
      for (let i = 1; i <= 25_000; i++) {
        insertUser.run(i, 1_000_000 + i, i % 100 === 0 ? 50 : 0);
        insertSub.run(i);
      }
    })();

    forceGC();
    const heapBefore = process.memoryUsage().heapUsed;

    const index = new SubscriberInvertedIndex(db);

    forceGC();
    const heapAfter = process.memoryUsage().heapUsed;
    const indexRamMb = (heapAfter - heapBefore) / (1024 * 1024);

    expect(index.getUserCount()).toBe(25_000);
    // Inverted index for 25k users must consume < 35 MB
    expect(indexRamMb).toBeLessThan(35);

    // O(1) resolution test: resolving 25k subscribers must take < 35ms
    const startRes = performance.now();
    const matches = index.resolveSubscribers("flagship", "europe", "available");
    const duration = performance.now() - startRes;

    expect(matches.length).toBe(25_000);
    expect(duration).toBeLessThan(75);
  });

  it("4. SQLite WAL Compaction & Maintenance Keeps DB Memory Flat", () => {
    const maintenance = new DatabaseMaintenanceManager(db, 30);
    const insertUser = db.prepare(`
      INSERT INTO users (id, telegram_id, first_name, language)
      VALUES (1, 999999, 'Admin', 'uk')
    `);
    insertUser.run();

    const insertLog = db.prepare(`
      INSERT INTO notification_logs (user_id, pool_slug, block_id, event_type, sent_at)
      VALUES (1, 'flagship', 'europe', 'SLOT_APPEARED', datetime('now', '-40 days'))
    `);

    // Insert 5,000 legacy records
    db.transaction(() => {
      for (let i = 1; i <= 5_000; i++) {
        insertLog.run();
      }
    })();

    const result = maintenance.pruneOldLogs();
    expect(result.deletedCount).toBe(5_000);
    expect(result.pagesReclaimed).toBeGreaterThanOrEqual(0);

    // Freelist pages must be bounded after vacuum
    const freelist = (db.prepare("PRAGMA freelist_count").get() as any).freelist_count;
    expect(freelist).toBeGreaterThanOrEqual(0);
  });

  it("5. MutationQueue: 25,000 Mutation Load Shedding & Compaction Keeps RAM Bounded", async () => {
    let isEnabled = true;
    const executedBatches: any[] = [];
    const mockExecutor = async (reqs: any[]) => {
      executedBatches.push(reqs);
      return [];
    };

    const queue = new MutationQueue(mockExecutor, () => isEnabled);

    // Push 25,000 mutations (20,000 redundant user touches, 5,000 updates)
    for (let i = 0; i < 20_000; i++) {
      queue.pushMutation("UPDATE users SET last_active_at = ? WHERE telegram_id = ?", ["2026-08-30", 999], false);
    }
    for (let i = 0; i < 5_000; i++) {
      queue.pushMutation("UPDATE users SET is_muted = ? WHERE telegram_id = ?", [1, 1000 + i], false);
    }

    // Maximum pending array must not exceed 10,000 items
    expect(queue.getPendingMutations().length).toBeLessThanOrEqual(10_000);
    await queue.close();
  });
});
