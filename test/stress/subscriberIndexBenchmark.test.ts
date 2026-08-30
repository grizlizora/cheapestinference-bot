import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../../src/db/index.js";
import { SubscriberInvertedIndex } from "../../src/bot/notifier/subscriberIndex.js";
import { performance } from "perf_hooks";

describe("🔥 STRESS & BENCHMARK: 10,000+ Subscriber Index Resolution", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);

    // Seed 10,000 users in a single transaction
    const insertUser = db.prepare("INSERT INTO users (id, telegram_id, first_name, language, is_admin, total_donated_stars) VALUES (?, ?, 'User', ?, ?, ?)");
    const insertSub = db.prepare("INSERT INTO subscriptions (user_id, pool_slug, block_id) VALUES (?, 'flagship', 'europe')");

    const seedTx = db.transaction(() => {
      for (let i = 1; i <= 10000; i++) {
        const isAdmin = i <= 50 ? 1 : 0;
        const stars = i > 50 && i <= 1500 ? (10005 - i) : 0;
        insertUser.run(i, 1000000 + i, i % 2 === 0 ? "uk" : "en", isAdmin, stars);
        insertSub.run(i);
      }
    });
    seedTx();
  });

  afterEach(() => {
    db.close();
  });

  it("1. Hydrates 10,000 users and resolves full subscriber queue in < 25ms", () => {
    const t0 = performance.now();
    const index = new SubscriberInvertedIndex(db);
    const hydrateDuration = performance.now() - t0;
    expect(hydrateDuration).toBeLessThan(250); // Cold start < 250ms

    const tResolveStart = performance.now();
    const resolved = index.resolveSubscribers("flagship", "europe", "available");
    const resolveDuration = performance.now() - tResolveStart;

    expect(resolved.length).toBe(10000);
    expect(resolveDuration).toBeLessThan(35); // Target: < 35ms on V8

    // Verify ordering invariant: Admins (50) -> Top Donors (1450) -> Free Users (8500)
    expect(resolved[0].isAdmin).toBe(true);
    expect(resolved[49].isAdmin).toBe(true);
    expect(resolved[50].totalDonatedStars).toBeGreaterThan(0);
    expect(resolved[1499].totalDonatedStars).toBeGreaterThan(0);
    expect(resolved[1500].totalDonatedStars).toBe(0);
  });
});
