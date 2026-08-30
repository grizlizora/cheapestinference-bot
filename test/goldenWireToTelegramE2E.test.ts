import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/index.js";
import { UserDAO } from "../src/db/dao/users.js";
import { SubscriptionDAO } from "../src/db/dao/subscriptions.js";
import { PoolStateDAO } from "../src/db/dao/poolState.js";
import { SlotHistoryDAO } from "../src/db/dao/slotHistory.js";
import { CatalogHistoryDAO } from "../src/db/dao/catalogHistory.js";
import { NotificationLogDAO } from "../src/db/dao/notificationLogs.js";
import { NotificationOutboxDAO } from "../src/db/dao/notificationOutbox.js";
import { ActiveDashboardDAO } from "../src/db/dao/activeDashboards.js";
import { SubscriberInvertedIndex } from "../src/bot/notifier/subscriberIndex.js";
import { NotificationDispatcher } from "../src/bot/notifier/dispatcher.js";
import { SlotDiffEngine } from "../src/engine/diffEngine.js";
import { AvailabilityIntelligenceEngine } from "../src/engine/availabilityEngine.js";
import { PredictiveAnalyticsEngine } from "../src/engine/predictiveEngine.js";
import { ActiveDashboardRegistry } from "../src/bot/liveSync/dashboardRegistry.js";
import { LiveDashboardManager } from "../src/bot/liveSync/liveDashboardManager.js";
import { createMainMenuHierarchy } from "../src/bot/menus/mainDashboard.js";
import { HtmlSnapshotEngine } from "../src/scrapers/htmlSnapshotEngine.js";
import { PoolsSnapshot } from "../src/types/domain.js";

describe("🌟 GOLDEN WIRE-TO-TELEGRAM E2E CONTRACT TEST SUITE", () => {
  let db: Database.Database;
  let userDao: UserDAO;
  let subDao: SubscriptionDAO;
  let poolStateDao: PoolStateDAO;
  let slotHistoryDao: SlotHistoryDAO;
  let catalogHistoryDao: CatalogHistoryDAO;
  let notificationLogDao: NotificationLogDAO;
  let outboxDao: NotificationOutboxDAO;
  let activeDashboardDao: ActiveDashboardDAO;
  let invertedIndex: SubscriberInvertedIndex;
  let predictiveEngine: PredictiveAnalyticsEngine;
  let diffEngine: SlotDiffEngine;
  let dashboardRegistry: ActiveDashboardRegistry;
  let liveDashboardManager: LiveDashboardManager;
  let dispatcher: NotificationDispatcher;

  let deliveredMessages: Array<{ chatId: number; text: string; options?: any }>;
  let editedMessages: Array<{ chatId: number; messageId: number; text: string; options?: any }>;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);

    userDao = new UserDAO(db);
    subDao = new SubscriptionDAO(db);
    poolStateDao = new PoolStateDAO(db);
    slotHistoryDao = new SlotHistoryDAO(db);
    catalogHistoryDao = new CatalogHistoryDAO(db);
    notificationLogDao = new NotificationLogDAO(db);
    outboxDao = new NotificationOutboxDAO(db);
    activeDashboardDao = new ActiveDashboardDAO(db);

    invertedIndex = new SubscriberInvertedIndex(db);
    predictiveEngine = new PredictiveAnalyticsEngine(slotHistoryDao);
    diffEngine = new SlotDiffEngine(slotHistoryDao, catalogHistoryDao, predictiveEngine);

    dashboardRegistry = new ActiveDashboardRegistry(activeDashboardDao);

    deliveredMessages = [];
    editedMessages = [];

    const fakeBot = {
      api: {
        sendMessage: vi.fn(async (chatId: number, text: string, options?: any) => {
          deliveredMessages.push({ chatId, text, options });
          return { message_id: Math.floor(Math.random() * 100000) };
        }),
        editMessageText: vi.fn(async (chatId: number, messageId: number, text: string, options?: any) => {
          editedMessages.push({ chatId, messageId, text, options });
          return true;
        }),
      },
    } as any;

    const fakeScraper: any = {
      on: vi.fn(),
      getTelemetry: vi.fn(() => ({ lastScrapeTimestamp: Date.now() })),
    };

    const { mainDashboardMenu, poolDetailMenu } = createMainMenuHierarchy(
      poolStateDao,
      userDao,
      subDao,
      invertedIndex,
      slotHistoryDao,
      fakeScraper,
      dashboardRegistry
    );

    liveDashboardManager = new LiveDashboardManager(
      fakeBot,
      poolStateDao,
      subDao,
      fakeScraper,
      mainDashboardMenu,
      poolDetailMenu,
      slotHistoryDao,
      { registry: dashboardRegistry }
    );

    dispatcher = new NotificationDispatcher(
      fakeBot,
      userDao,
      notificationLogDao,
      slotHistoryDao,
      invertedIndex,
      undefined,
      outboxDao
    );
  });

  afterEach(() => {
    dashboardRegistry.close();
    db.close();
  });

  it("Executes 100% Real-World Wire Pipeline: Raw RSC HTML -> Parser -> Diff -> Sub Matching -> DWRR Dispatch -> LiveSync In-Place Edit", async () => {
    // 1. Setup real users with distinct languages and priorities
    // User 1: Admin (UK)
    userDao.upsertUser({ telegram_id: 1001, username: "AdminUK", first_name: "Admin", language: "uk" });
    userDao.setAdmin(1001, true);
    subDao.setSubscription(1, "flagship", "europe", true);
    invertedIndex.upsertUserProfile({
      userId: 1,
      telegramId: 1001,
      language: "uk",
      isAdmin: true,
      isMuted: false,
      isActive: true,
      totalDonatedStars: 0,
      lastActiveAt: Date.now(),
      notifyAvailableGlobal: true,
      notifySoldOutGlobal: true,
      notifyModelsGlobal: true,
      notifyPricesGlobal: true,
    });
    invertedIndex.updateSubscription(1, "flagship", "europe", { available: true, soldOut: false, models: true, prices: true });

    // User 2: Diamond Donor (EN, 300 Stars)
    userDao.upsertUser({ telegram_id: 1002, username: "DonorEN", first_name: "Donor", language: "en" });
    userDao.addDonatedStars(2, 300);
    subDao.setSubscription(2, "flagship", "europe", true);
    invertedIndex.upsertUserProfile({
      userId: 2,
      telegramId: 1002,
      language: "en",
      isAdmin: false,
      isMuted: false,
      isActive: true,
      totalDonatedStars: 300,
      lastActiveAt: Date.now(),
      notifyAvailableGlobal: true,
      notifySoldOutGlobal: true,
      notifyModelsGlobal: true,
      notifyPricesGlobal: true,
    });
    invertedIndex.updateSubscription(2, "flagship", "europe", { available: true, soldOut: false, models: true, prices: true });

    // User 3: Active Dashboard User (RU)
    userDao.upsertUser({ telegram_id: 1003, username: "UserRU", first_name: "User", language: "ru" });
    dashboardRegistry.register(1003, 5555, 3, "ru", "dashboard");

    // 2. Feed Raw Baseline Next.js 14 RSC Flight Stream Chunk Stream
    const rscHtmlBaseline = `
      <!DOCTYPE html>
      <html><body>
      <script>(self.__next_f=self.__next_f||[]).push([1, "1:{\\"slug\\":\\"flagship\\",\\"modelName\\":\\"Flagship Supercluster\\",\\"status\\":\\"sold-out\\",\\"minPricePerDay\\":349,\\"models\\":[\\"kimi-k3\\",\\"qwen3.8-max\\"],\\"blocks\\":[{\\"block\\":\\"europe\\",\\"status\\":\\"sold-out\\",\\"pricePerMonth\\":\\"$349\\"},{\\"block\\":\\"asia\\",\\"status\\":\\"sold-out\\",\\"pricePerMonth\\":\\"$349\\"}]}"])</script>
      </body></html>
    `;

    const htmlEngine = new HtmlSnapshotEngine({} as any);
    const baselinePools = htmlEngine.extractRscPayload(rscHtmlBaseline);
    expect(baselinePools).not.toBeNull();
    const baselineSnapshot: PoolsSnapshot = { success: true, data: baselinePools! };

    // Cold boot diff engine
    const bootstrapEvents = diffEngine.processSnapshot(baselineSnapshot);
    expect(bootstrapEvents).toHaveLength(0); // Invariant: 0 false alerts on boot

    // 3. Provider Drops a Slot at 08:00 UTC (Next.js Dynamic Flight Stream update)
    const rscHtmlDrop = `
      <!DOCTYPE html>
      <html><body>
      <script>(self.__next_f=self.__next_f||[]).push([1, "1:{\\"slug\\":\\"flagship\\",\\"modelName\\":\\"Flagship Supercluster\\",\\"status\\":\\"available\\",\\"minPricePerDay\\":349,\\"models\\":[\\"kimi-k3\\",\\"qwen3.8-max\\"],\\"blocks\\":[{\\"block\\":\\"europe\\",\\"status\\":\\"available\\",\\"pricePerMonth\\":\\"$349\\"},{\\"block\\":\\"asia\\",\\"status\\":\\"sold-out\\",\\"pricePerMonth\\":\\"$349\\"}]}"])</script>
      </body></html>
    `;

    const dropPools = htmlEngine.extractRscPayload(rscHtmlDrop);
    expect(dropPools).not.toBeNull();
    const dropSnapshot: PoolsSnapshot = { success: true, data: dropPools! };

    const diffEvents = diffEngine.processSnapshot(dropSnapshot!);
    expect(diffEvents).toHaveLength(1);
    expect(diffEvents[0].type).toBe("SLOT_APPEARED");
    expect(diffEvents[0].poolSlug).toBe("flagship");
    expect(diffEvents[0].block).toBe("europe");

    // 4. Dispatch Alert through NotificationDispatcher Pipeline
    dispatcher.handleDiffEvents(diffEvents);
    await dispatcher.flushPending();

    // 5. Assert Telegram Notification Delivery Invariants
    expect(deliveredMessages.length).toBeGreaterThanOrEqual(2);

    // Verify Admin UK localized alert
    const adminMsg = deliveredMessages.find((m) => m.chatId === 1001);
    expect(adminMsg).toBeDefined();
    expect(adminMsg?.text).toContain("ВІЛЬНИЙ СЛОТ");
    expect(adminMsg?.text).toContain("Flagship");
    expect(adminMsg?.options.parse_mode).toBe("HTML");

    // Verify Donor EN localized alert
    const donorMsg = deliveredMessages.find((m) => m.chatId === 1002);
    expect(donorMsg).toBeDefined();
    expect(donorMsg?.text).toContain("SLOT DROP");
    expect(donorMsg?.options.parse_mode).toBe("HTML");

    // 6. Assert LiveDashboard In-Place Real-Time Update
    poolStateDao.saveSnapshot(dropSnapshot!.data);
    const session = dashboardRegistry.get(1003);
    expect(session).toBeDefined();
    await liveDashboardManager.updateView(session!);
    expect(editedMessages.length).toBeGreaterThanOrEqual(1);

    const editedDashboard = editedMessages.find((m) => m.chatId === 1003);
    expect(editedDashboard).toBeDefined();
    expect(editedDashboard?.text).toContain("Flagship Supercluster");
    expect(editedDashboard?.text).toContain("1/2"); // 1 of 2 blocks now available
  });
});
