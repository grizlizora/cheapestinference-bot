/**
 * test/realWorldLiveDashboardLifecycle.test.ts
 * 100% Realistic End-to-End Simulation: LiveDashboard, Cold-Boot Hydration,
 * Multi-Tier Heartbeat, and In-Place Telegram Message Editing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { Bot } from "grammy";
import { BotContext } from "../src/types/context.js";
import { UserDAO } from "../src/db/dao/users.js";
import { SubscriptionDAO } from "../src/db/dao/subscriptions.js";
import { PoolStateDAO } from "../src/db/dao/poolState.js";
import { SlotHistoryDAO } from "../src/db/dao/slotHistory.js";
import { ActiveDashboardDAO } from "../src/db/dao/activeDashboards.js";
import { SubscriberInvertedIndex } from "../src/bot/notifier/subscriberIndex.js";
import { ActiveDashboardRegistry, fnv1a32 } from "../src/bot/liveSync/dashboardRegistry.js";
import { LiveDashboardManager } from "../src/bot/liveSync/liveDashboardManager.js";
import { ScraperOrchestrator } from "../src/engine/scraperOrchestrator.js";
import { SlotDiffEngine } from "../src/engine/diffEngine.js";
import { createMainMenuHierarchy } from "../src/bot/menus/mainDashboard.js";
import { initSchema } from "../src/db/index.js";

describe("🌟 100% Realistic LiveDashboard End-to-End Simulation Suite", () => {
  let db: Database.Database;
  let userDao: UserDAO;
  let subDao: SubscriptionDAO;
  let poolStateDao: PoolStateDAO;
  let historyDao: SlotHistoryDAO;
  let activeDao: ActiveDashboardDAO;
  let invertedIndex: SubscriberInvertedIndex;
  let diffEngine: SlotDiffEngine;
  let scraper: ScraperOrchestrator;
  let fakeBot: Bot<BotContext>;
  let editMessageTextCalls: Array<{ chatId: number; messageId: number; text: string; payload: any }> = [];

  const createTestDb = () => {
    const memoryDb = new Database(":memory:");
    initSchema(memoryDb);
    return memoryDb;
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    db = createTestDb();
    userDao = new UserDAO(db);
    subDao = new SubscriptionDAO(db);
    poolStateDao = new PoolStateDAO(db);
    historyDao = new SlotHistoryDAO(db);
    activeDao = new ActiveDashboardDAO(db);
    invertedIndex = new SubscriberInvertedIndex(db, userDao, subDao);
    diffEngine = new SlotDiffEngine();

    // Populate realistic pool data
    poolStateDao.saveSnapshot([
      {
        slug: "flagship",
        modelName: "Flagship Supercluster",
        models: ["kimi-k3", "qwen3.8-max"],
        blocks: [
          { block: "asia", status: "sold-out", hoursUtc: "00:00 – 08:00 UTC", pricePerMonth: "$149.00" },
          { block: "europe", status: "sold-out", hoursUtc: "08:00 – 16:00 UTC", pricePerMonth: "$149.00" },
          { block: "americas", status: "sold-out", hoursUtc: "16:00 – 24:00 UTC", pricePerMonth: "$149.00" },
        ],
        minPricePerDay: "4.97",
        annualDiscount: 0.15,
        description: "Flagship Ultra Inference",
      },
      {
        slug: "core",
        modelName: "Core Infrastructure",
        models: ["mimo-v2.5", "deepseek-v4-flash"],
        blocks: [
          { block: "asia", status: "available", hoursUtc: "00:00 – 08:00 UTC", pricePerMonth: "$17.99" },
          { block: "europe", status: "available", hoursUtc: "08:00 – 16:00 UTC", pricePerMonth: "$17.99" },
          { block: "americas", status: "available", hoursUtc: "16:00 – 24:00 UTC", pricePerMonth: "$17.99" },
        ],
        minPricePerDay: "0.60",
        annualDiscount: 0.15,
        description: "Core General Inference",
      },
    ]);

    editMessageTextCalls = [];

    // Construct mock Grammy bot
    fakeBot = {
      api: {
        editMessageText: vi.fn(async (chatId: number, messageId: number, text: string, payload: any) => {
          editMessageTextCalls.push({ chatId, messageId, text, payload });
          return { message_id: messageId };
        }),
        sendMessage: vi.fn(async (chatId: number, text: string, payload: any) => {
          return { message_id: 100500, chat: { id: chatId } };
        }),
      },
    } as unknown as Bot<BotContext>;

    // Mock Scraper
    scraper = {
      on: vi.fn(),
      getTelemetry: vi.fn(() => ({
        lastScrapeTimestamp: Date.now(),
        lastScrapeLatencyMs: 120,
        lastSource: "api",
        lastUsedProxy: "Direct",
        consecutiveFailures: 0,
      })),
      forceRefresh: vi.fn(async () => []),
    } as unknown as ScraperOrchestrator;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Full Lifecycle: User /start -> Routine 15s Heartbeat Edits -> Tariff Navigation -> Server Restart Recovery", async () => {
    // 1. Setup Menus & Registry
    const registry = new ActiveDashboardRegistry(activeDao);
    const { mainDashboardMenu, poolDetailMenu } = createMainMenuHierarchy(
      poolStateDao,
      userDao,
      subDao,
      invertedIndex,
      historyDao,
      scraper,
      registry
    );

    const liveManager = new LiveDashboardManager(
      fakeBot,
      poolStateDao,
      subDao,
      scraper,
      mainDashboardMenu,
      poolDetailMenu,
      historyDao,
      { registry, maxEditsPerSecond: 20 }
    );

    // 2. User registers on Telegram (e.g. User Roman with chatId 999111)
    const userChatId = 999111;
    const userMessageId = 4242;
    const user = userDao.upsertUser({
      telegram_id: userChatId,
      first_name: "Roman",
      username: "grizlizora",
      language: "uk",
    });
    registry.register(userChatId, userMessageId, user.id, "uk", "dashboard");

    // Verify session in RAM and in SQLite
    const activeSession = registry.get(userChatId);
    expect(activeSession).toBeDefined();
    expect(activeSession?.chatId).toBe(userChatId);
    expect(activeSession?.messageId).toBe(userMessageId);
    expect(activeSession?.viewType).toBe("dashboard");

    const dbRecord = activeDao.getHydrationCandidates().find((r) => r.chat_id === userChatId);
    expect(dbRecord).toBeDefined();
    expect(dbRecord?.message_id).toBe(userMessageId);

    // 3. First live heartbeat tick (5 seconds later)
    vi.advanceTimersByTime(5000);
    // Simulate scraper heartbeat
    liveManager.handleScraperHeartbeat(false);

    // Drain event loop / promises
    await vi.advanceTimersByTimeAsync(100);

    // Verify in-place Telegram edit was sent
    expect(editMessageTextCalls.length).toBeGreaterThanOrEqual(1);
    const firstEdit = editMessageTextCalls[editMessageTextCalls.length - 1];
    expect(firstEdit.chatId).toBe(userChatId);
    expect(firstEdit.messageId).toBe(userMessageId);
    expect(firstEdit.text).toContain("Live 5s");
    expect(firstEdit.text).toContain("Flagship Supercluster");
    expect(firstEdit.payload.reply_markup).toBeDefined();
    expect(Array.isArray(firstEdit.payload.reply_markup.inline_keyboard)).toBe(true);

    const callCountBeforeNav = editMessageTextCalls.length;

    // 4. User navigates to Pool Detail ("flagship")
    registry.updateView(userChatId, "pool_detail", "flagship", "uk", userMessageId);
    expect(registry.get(userChatId)?.viewType).toBe("pool_detail");
    expect(registry.get(userChatId)?.poolSlug).toBe("flagship");

    // Advance 16 seconds to pass heartbeat throttle
    vi.advanceTimersByTime(16000);
    liveManager.handleScraperHeartbeat(false);
    await vi.advanceTimersByTimeAsync(100);

    // Verify in-place edit updated to pool_detail view
    expect(editMessageTextCalls.length).toBeGreaterThan(callCountBeforeNav);
    const poolEdit = editMessageTextCalls[editMessageTextCalls.length - 1];
    expect(poolEdit.text).toContain("Flagship Supercluster");
    expect(poolEdit.text).toContain("Live 5s");

    // =========================================================================
    // 5. SIMULATE SERVER REBOOT (Container crash, RAM cleared, cold start)
    // =========================================================================
    // ActiveDashboardRegistry auto-hydrates from SQLite upon instantiation
    const newRegistry = new ActiveDashboardRegistry(activeDao);
    expect(newRegistry.size()).toBe(1);

    const restoredSession = newRegistry.get(userChatId);
    expect(restoredSession).toBeDefined();
    expect(restoredSession?.chatId).toBe(userChatId);
    expect(restoredSession?.messageId).toBe(userMessageId);
    expect(restoredSession?.viewType).toBe("pool_detail");
    expect(restoredSession?.poolSlug).toBe("flagship");
    // Invariant: hash & edit timestamp must be 0 to force instant update on first boot scrape
    expect(restoredSession?.lastRenderedTextHash).toBe(0);
    expect(restoredSession?.lastTelegramEditAt).toBe(0);

    // New LiveDashboardManager instance attached to new registry
    const newLiveManager = new LiveDashboardManager(
      fakeBot,
      poolStateDao,
      subDao,
      scraper,
      mainDashboardMenu,
      poolDetailMenu,
      historyDao,
      { registry: newRegistry, maxEditsPerSecond: 20 }
    );

    const callCountBeforeRebootScrape = editMessageTextCalls.length;

    // Scraper performs first startup scrape (isModified = false or true)
    newLiveManager.handleScraperHeartbeat(false);
    await vi.advanceTimersByTimeAsync(100);

    // Invariant: MUST immediately execute in-place edit on user's Telegram message!
    expect(editMessageTextCalls.length).toBeGreaterThan(callCountBeforeRebootScrape);
    const rebootEdit = editMessageTextCalls[editMessageTextCalls.length - 1];
    expect(rebootEdit.chatId).toBe(userChatId);
    expect(rebootEdit.messageId).toBe(userMessageId);
    expect(rebootEdit.text).toContain("Flagship Supercluster");
    expect(rebootEdit.text).toContain("Live 5s");
    expect(rebootEdit.payload.reply_markup.inline_keyboard).toBeDefined();
  });
});
