/**
 * test/liveSyncHardeningAndSelfHealing.test.ts
 * Comprehensive test suite verifying:
 * 1. LiveDashboardManager Telegram emoji fallback on DOCUMENT_INVALID
 * 2. LiveDashboardManager 400 message is not modified handling
 * 3. ActiveDashboardRegistry self-healing updateView recovery
 * 4. PriceDiffEvaluator single-block pool base price change
 * 5. TursoCloudSync poison-pill mutation discard after 5 retries
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/index.js";
import { UserDAO } from "../src/db/dao/users.js";
import { ActiveDashboardDAO } from "../src/db/dao/activeDashboards.js";
import { PoolStateDAO } from "../src/db/dao/poolState.js";
import { SubscriptionDAO } from "../src/db/dao/subscriptions.js";
import { CatalogHistoryDAO } from "../src/db/dao/catalogHistory.js";
import { ActiveDashboardRegistry } from "../src/bot/liveSync/dashboardRegistry.js";
import { LiveDashboardManager } from "../src/bot/liveSync/liveDashboardManager.js";
import { PriceDiffEvaluator } from "../src/engine/priceDiffEvaluator.js";
import { TursoCloudSync } from "../src/db/tursoSync.js";
import { Menu } from "@grammyjs/menu";
import { BotContext } from "../src/types/context.js";
import { PoolData } from "../src/types/domain.js";

describe("🛡️ LiveSync Hardening, Self-Healing & Engine Resilience Suite", () => {
  let db: Database.Database;
  let userDao: UserDAO;
  let activeDao: ActiveDashboardDAO;
  let poolStateDao: PoolStateDAO;
  let subDao: SubscriptionDAO;
  let catalogHistoryDao: CatalogHistoryDAO;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    userDao = new UserDAO(db);
    activeDao = new ActiveDashboardDAO(db);
    poolStateDao = new PoolStateDAO(db);
    subDao = new SubscriptionDAO(db);
    catalogHistoryDao = new CatalogHistoryDAO(db);
  });

  it("1. Self-Healing updateView: Reconstructs lost/pruned session on user navigation", () => {
    const registry = new ActiveDashboardRegistry(activeDao);
    const chatId = 888123;
    const messageId = 5555;
    const user = userDao.upsertUser({
      telegram_id: chatId,
      first_name: "TestUser",
      language: "uk",
    });

    // Verify session starts empty in RAM
    expect(registry.get(chatId)).toBeUndefined();

    // User clicks a tariff button triggering updateView with messageId
    registry.updateView(chatId, "pool_detail", "flagship", "uk", messageId, user.id);

    // Invariant: Registry must auto-heal and register the session!
    const session = registry.get(chatId);
    expect(session).toBeDefined();
    expect(session?.chatId).toBe(chatId);
    expect(session?.messageId).toBe(messageId);
    expect(session?.viewType).toBe("pool_detail");
    expect(session?.poolSlug).toBe("flagship");
    expect(session?.lastRenderedTextHash).toBe(0); // Invariant: reset hash to force immediate render

    // Invariant: SQLite record must also be persisted!
    const dbRecord = activeDao.getByChatId(chatId);
    expect(dbRecord).toBeDefined();
    expect(dbRecord?.view_type).toBe("pool_detail");
    expect(dbRecord?.pool_slug).toBe("flagship");
  });

  it("2. LiveDashboardManager: Handles DOCUMENT_INVALID by retrying with stripped emojis without error strike", async () => {
    const registry = new ActiveDashboardRegistry(activeDao);
    const chatId = 777222;
    const messageId = 3333;
    const user = userDao.upsertUser({
      telegram_id: chatId,
      first_name: "EmojiUser",
      language: "en",
    });

    registry.register(chatId, messageId, user.id, "en", "dashboard");

    const editCalls: Array<{ text: string }> = [];
    let throwEmojiErrorOnFirstCall = true;

    const fakeBot = {
      api: {
        editMessageText: vi.fn(async (_cId: number, _mId: number, text: string) => {
          if (throwEmojiErrorOnFirstCall) {
            throwEmojiErrorOnFirstCall = false;
            throw { description: "Bad Request: DOCUMENT_INVALID: custom emoji not supported" };
          }
          editCalls.push({ text });
          return { message_id: messageId };
        }),
      },
    } as any;

    const dummyMenu = new Menu<BotContext>("dummy-menu");
    const fakeScraper = { on: vi.fn(), getTelemetry: vi.fn(() => ({ lastScrapeTimestamp: Date.now() })) } as any;

    const manager = new LiveDashboardManager(
      fakeBot,
      poolStateDao,
      subDao,
      fakeScraper,
      dummyMenu,
      dummyMenu,
      undefined,
      { registry, maxEditsPerSecond: 20 }
    );

    // Trigger edit
    manager.handleScraperHeartbeat(true);
    await new Promise((r) => setTimeout(r, 100));

    // Verify fallback call was made and error count is 0
    expect(fakeBot.api.editMessageText).toHaveBeenCalledTimes(2);
    expect(editCalls.length).toBe(1);
    expect(registry.get(chatId)?.consecutiveErrors).toBe(0);
    manager.close();
  });

  it("3. LiveDashboardManager: Handles 400 message is not modified cleanly without accumulating error strikes", async () => {
    const registry = new ActiveDashboardRegistry(activeDao);
    const chatId = 666333;
    const messageId = 2222;
    const user = userDao.upsertUser({
      telegram_id: chatId,
      first_name: "NotModUser",
      language: "en",
    });

    registry.register(chatId, messageId, user.id, "en", "dashboard");

    const fakeBot = {
      api: {
        editMessageText: vi.fn(async () => {
          throw { description: "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message" };
        }),
      },
    } as any;

    const dummyMenu = new Menu<BotContext>("dummy-menu-2");
    const fakeScraper = { on: vi.fn(), getTelemetry: vi.fn(() => ({ lastScrapeTimestamp: Date.now() })) } as any;

    const manager = new LiveDashboardManager(
      fakeBot,
      poolStateDao,
      subDao,
      fakeScraper,
      dummyMenu,
      dummyMenu,
      undefined,
      { registry, maxEditsPerSecond: 20 }
    );

    manager.handleScraperHeartbeat(true);
    await new Promise((r) => setTimeout(r, 100));

    // Invariant: consecutiveErrors must remain 0 and session must NOT be removed!
    expect(registry.get(chatId)).toBeDefined();
    expect(registry.get(chatId)?.consecutiveErrors).toBe(0);
    manager.close();
  });

  it("4. PriceDiffEvaluator: Emits POOL_BASE_PRICE_CHANGED for single-block pool when base tariff changes", () => {
    const prevPool: PoolData = {
      slug: "single_node",
      modelName: "Single Node Cluster",
      minPricePerDay: "$10.00",
      blocks: [
        { block: "primary", status: "available", pricePerMonth: "$10.00", hoursUtc: "00:00-24:00" },
      ],
    };

    const newPool: PoolData = {
      slug: "single_node",
      modelName: "Single Node Cluster",
      minPricePerDay: "$12.50",
      blocks: [
        { block: "primary", status: "available", pricePerMonth: "$12.50", hoursUtc: "00:00-24:00" },
      ],
    };

    const stagedChanges = [
      { blockId: "primary", oldPrice: "$10.00", newPrice: "$12.50", newPriceNum: 12.5 },
    ];

    const result = PriceDiffEvaluator.evaluatePriceDiffs(
      newPool,
      prevPool,
      stagedChanges,
      catalogHistoryDao,
      Date.now()
    );

    // Invariant: Must emit POOL_BASE_PRICE_CHANGED and not isolated regional SLOT_PRICE_CHANGED
    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe("POOL_BASE_PRICE_CHANGED");
    expect(result.events[0].basePrice?.previousMinPrice).toBe("$10.00");
    expect(result.events[0].basePrice?.newMinPrice).toBe("$12.50");
    expect(result.events[0].basePrice?.priceDelta).toBe(2.5);
  });

  it("5. TursoCloudSync: Discards poison-pill mutations after 5 consecutive failed attempts", async () => {
    const sync = new TursoCloudSync("https://mock-db.turso.io", "mock-token");
    
    // Mock failing executePipeline
    (sync as any).executePipeline = vi.fn().mockRejectedValue(new Error("SQL syntax error in poison pill"));

    // Push 1 mutation
    sync.pushMutation("INSERT INTO nonexistent_table VALUES (1)", [], false);

    // Flush 5 times
    for (let i = 0; i < 5; i++) {
      await sync.flush();
    }

    // After 5 failures, mutation is still queued for final 5th attempt
    expect((sync as any).pendingMutations[0]?.retryCount).toBe(5);

    // 6th flush triggers discard
    await sync.flush();
    expect((sync as any).pendingMutations).toHaveLength(0);
    await sync.close();
  });
});
