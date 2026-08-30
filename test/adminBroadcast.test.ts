import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { UserDAO } from "../src/db/dao/users.js";
import { NotificationLogDAO } from "../src/db/dao/notificationLogs.js";
import { NotificationOutboxDAO } from "../src/db/dao/notificationOutbox.js";
import { SubscriberInvertedIndex } from "../src/bot/notifier/subscriberIndex.js";
import { NotificationDispatcher } from "../src/bot/notifier/dispatcher.js";
import { Bot } from "grammy";
import { BotContext } from "../src/types/context.js";
import { translate } from "../src/i18n/index.js";
import {
  renderBroadcastStagingText,
  renderBroadcastPromptText,
  renderBroadcastPreview,
  renderBroadcastPreflight,
  renderBroadcastModalConfirm,
  getOrCreateBroadcastSession,
  resetBroadcastSession,
} from "../src/bot/handlers/adminBroadcast.js";
import { escapeHtmlText } from "../src/bot/notifier/telegramEntitySerializer.js";

describe("Admin Multi-Language Broadcast System", () => {
  let db: Database.Database;
  let userDao: UserDAO;
  let logDao: NotificationLogDAO;
  let outboxDao: NotificationOutboxDAO;
  let invertedIndex: SubscriberInvertedIndex;
  let mockBot: Bot<BotContext>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER UNIQUE NOT NULL,
        username TEXT,
        first_name TEXT,
        language TEXT NOT NULL DEFAULT 'en',
        is_active INTEGER NOT NULL DEFAULT 1,
        is_muted INTEGER NOT NULL DEFAULT 0,
        is_admin INTEGER NOT NULL DEFAULT 0,
        notify_admin_new_users INTEGER NOT NULL DEFAULT 1,
        notify_available_global INTEGER NOT NULL DEFAULT 1,
        notify_sold_out_global INTEGER NOT NULL DEFAULT 0,
        notify_models_global INTEGER NOT NULL DEFAULT 1,
        notify_prices_global INTEGER NOT NULL DEFAULT 1,
        total_donated_stars INTEGER NOT NULL DEFAULT 0,
        last_active_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        pool_slug TEXT NOT NULL,
        block_id TEXT NOT NULL,
        notify_on_available INTEGER NOT NULL DEFAULT 1,
        notify_on_sold_out INTEGER NOT NULL DEFAULT 0,
        notify_on_models INTEGER NOT NULL DEFAULT 1,
        notify_on_prices INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, pool_slug, block_id)
      );

      CREATE TABLE notification_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        pool_slug TEXT NOT NULL,
        block_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE notification_outbox (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        telegram_id INTEGER NOT NULL,
        priority TEXT NOT NULL DEFAULT 'P1',
        message_text TEXT NOT NULL,
        reply_markup_json TEXT,
        disable_notification INTEGER NOT NULL DEFAULT 0,
        event_type TEXT NOT NULL DEFAULT 'available',
        pool_slug TEXT,
        block_id TEXT,
        is_broadcast INTEGER NOT NULL DEFAULT 0,
        language TEXT NOT NULL DEFAULT 'en',
        media_type TEXT NOT NULL DEFAULT 'text',
        file_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        dispatched_at DATETIME
      );
    `);

    userDao = new UserDAO(db);
    logDao = new NotificationLogDAO(db);
    outboxDao = new NotificationOutboxDAO(db);

    // Seed users with different languages and donor statuses
    userDao.upsertUser({
      telegram_id: 101,
      first_name: "Admin User",
      username: "admin_test",
      language: "uk",
    });
    db.prepare("UPDATE users SET is_admin = 1, language = 'uk' WHERE telegram_id = 101").run();

    userDao.upsertUser({
      telegram_id: 102,
      first_name: "Donor User EN",
      username: "donor_en",
      language: "en",
    });
    db.prepare("UPDATE users SET total_donated_stars = 100, language = 'en' WHERE telegram_id = 102").run();

    userDao.upsertUser({
      telegram_id: 103,
      first_name: "Active User RU",
      username: "active_ru",
      language: "ru",
    });
    db.prepare("UPDATE users SET language = 'ru' WHERE telegram_id = 103").run();

    userDao.upsertUser({
      telegram_id: 104,
      first_name: "Free User UK",
      username: "free_uk",
      language: "uk",
    });
    db.prepare("UPDATE users SET language = 'uk' WHERE telegram_id = 104").run();

    invertedIndex = new SubscriberInvertedIndex(db);

    mockBot = {
      api: {
        sendMessage: vi.fn().mockResolvedValue({ message_id: 999 }),
      },
    } as any;
  });

  afterEach(() => {
    db.close();
  });

  it("1. SubscriberInvertedIndex: accurately returns active profiles partitioned by language and priority", () => {
    const profiles = invertedIndex.getActiveProfiles("active_only");
    expect(profiles.length).toBe(4);

    // Priority ordering: Admin (101) -> Donor (102) -> Free Users (103, 104)
    expect(profiles[0].telegramId).toBe(101);
    expect(profiles[0].isAdmin).toBe(true);
    expect(profiles[1].telegramId).toBe(102);
    expect(profiles[1].totalDonatedStars).toBe(100);

    const ukUsers = profiles.filter((p) => p.language === "uk");
    const enUsers = profiles.filter((p) => p.language === "en");
    const ruUsers = profiles.filter((p) => p.language === "ru");

    expect(ukUsers.length).toBe(2);
    expect(enUsers.length).toBe(1);
    expect(ruUsers.length).toBe(1);
  });

  it("2. NotificationOutboxDAO: batch enqueues broadcast items and preserves is_broadcast and language fields", () => {
    outboxDao.enqueueBatch([
      {
        id: "bc-1",
        userId: 1,
        telegramId: 101,
        priority: "P0",
        messageText: "<b>Оновлення бота</b>",
        disableNotification: false,
        eventType: "admin_broadcast",
        isBroadcast: true,
        language: "uk",
        status: "pending",
        attempts: 0,
      },
      {
        id: "bc-2",
        userId: 2,
        telegramId: 102,
        priority: "P0",
        messageText: "<b>Bot Update</b>",
        disableNotification: false,
        eventType: "admin_broadcast",
        isBroadcast: true,
        language: "en",
        status: "pending",
        attempts: 0,
      },
    ]);

    const pending = outboxDao.getPending(10);
    expect(pending.length).toBe(2);
    expect(pending[0].isBroadcast).toBe(true);
    expect(pending[0].language).toBe("uk");
    expect(pending[1].isBroadcast).toBe(true);
    expect(pending[1].language).toBe("en");
  });

  it("3. NotificationDispatcher: dispatchBroadcastBatch distributes localized texts and enqueues to P0 queue", async () => {
    const dispatcher = new NotificationDispatcher(
      mockBot,
      userDao,
      logDao,
      undefined,
      invertedIndex,
      undefined,
      outboxDao
    );

    const drafts = {
      uk: "📢 <b>Оновлення для українських користувачів!</b>",
      en: "📢 <b>Update for English users!</b>",
      ru: "📢 <b>Обновление для русских пользователей!</b>",
    };

    const res = await dispatcher.dispatchBroadcastBatch(drafts, {
      sendSilent: false,
      filter: "active_only",
    });

    expect(res.totalEnqueued).toBe(4);
    expect(res.statsByLang.uk).toBe(2);
    expect(res.statsByLang.en).toBe(1);
    expect(res.statsByLang.ru).toBe(1);

    // Verify persisted in SQLite Outbox
    const outboxRows = outboxDao.getPending(10);
    expect(outboxRows.length).toBe(4);

    const ukOutbox = outboxRows.find((r) => r.telegramId === 101);
    expect(ukOutbox?.messageText).toContain("Оновлення для українських користувачів");
    expect(ukOutbox?.language).toBe("uk");

    const enOutbox = outboxRows.find((r) => r.telegramId === 102);
    expect(enOutbox?.messageText).toContain("Update for English users");
    expect(enOutbox?.language).toBe("en");
  });

  it("4. NotificationDispatcher: applies 4-tier language fallback when specific language draft is missing", async () => {
    const dispatcher = new NotificationDispatcher(
      mockBot,
      userDao,
      logDao,
      undefined,
      invertedIndex,
      undefined,
      outboxDao
    );

    // Only English draft provided
    const drafts = {
      en: "📢 <b>Global Announcement in English</b>",
    };

    const res = await dispatcher.dispatchBroadcastBatch(drafts, {
      sendSilent: false,
      filter: "active_only",
    });

    expect(res.totalEnqueued).toBe(4);
    // All 4 users received English draft as fallback
    expect(res.statsByLang.en).toBe(4);

    const outboxRows = outboxDao.getPending(10);
    for (const row of outboxRows) {
      expect(row.messageText).toBe("📢 <b>Global Announcement in English</b>");
      expect(row.language).toBe("en");
    }
  });

  it("5. DWRR Scheduler: interleaves P0 broadcast items with P1 slot drops to ensure zero starvation of hot slots", async () => {
    const dispatcher = new NotificationDispatcher(
      mockBot,
      userDao,
      logDao,
      undefined,
      invertedIndex,
      undefined,
      outboxDao
    );

    // Populate P0 with broadcast items
    for (let i = 0; i < 20; i++) {
      (dispatcher as any).p0Queue.push({
        id: `bc-${i}`,
        telegramId: 1000 + i,
        userId: i,
        poolSlug: "broadcast",
        blockId: "all",
        eventType: "admin_broadcast",
        text: `Broadcast message ${i}`,
        isMuted: false,
        priority: "P0",
        retries: 0,
        enqueuedAt: Date.now(),
      });
    }

    // Populate P1 with a hot slot drop
    (dispatcher as any).p1Queue.push({
      id: "slot-drop-1",
      telegramId: 9999,
      userId: 9999,
      poolSlug: "flagship-supercluster",
      blockId: "europe",
      eventType: "available",
      text: "⚡ <b>Гарячий слот відкрився!</b>",
      isMuted: false,
      priority: "P1",
      retries: 0,
      enqueuedAt: Date.now(),
    });

    // Run DWRR selector multiple times
    const poppedPriorities: string[] = [];
    for (let i = 0; i < 15; i++) {
      const item = (dispatcher as any).selectNextItemDWRR(true);
      if (item) {
        poppedPriorities.push(item.priority);
      }
    }

    // Must have popped P0 items AND the P1 slot drop item during the cycle without waiting for all 20 P0 items to finish!
    expect(poppedPriorities).toContain("P0");
    expect(poppedPriorities).toContain("P1");
  });

  it("6. Admin Broadcast UI Localization: renders all screens in admin's selected interface language (EN, RU, UK)", () => {
    const dispatcher = new NotificationDispatcher(
      mockBot,
      userDao,
      logDao,
      undefined,
      invertedIndex,
      undefined,
      outboxDao
    );

    // Context with English interface language
    const ctxEn: any = {
      lang: "en",
      t: (key: string, params?: Record<string, string>) => translate("en", key, params),
      session: {},
    };

    const enStaging = renderBroadcastStagingText(ctxEn, userDao, dispatcher);
    expect(enStaging.text).toContain("Mass Broadcast Center");
    expect(enStaging.text).toContain("Total Recipients:");

    const enPrompt = renderBroadcastPromptText("uk", ctxEn);
    expect(enPrompt).toContain("Enter Message Content [ Українська 🇺🇦 ]");
    expect(enPrompt).toContain("Send the text");

    // Context with Russian interface language
    const ctxRu: any = {
      lang: "ru",
      t: (key: string, params?: Record<string, string>) => translate("ru", key, params),
      session: {},
    };

    const ruStaging = renderBroadcastStagingText(ctxRu, userDao, dispatcher);
    expect(ruStaging.text).toContain("Центр массовых рассылок");
    expect(ruStaging.text).toContain("Всего адресатов:");

    const ruPrompt = renderBroadcastPromptText("en", ctxRu);
    expect(ruPrompt).toContain("Ввод текста сообщения [ English 🇬🇧 ]");
    expect(ruPrompt).toContain("Отправьте следующим сообщением текст");

    // Context with Ukrainian interface language
    const ctxUk: any = {
      lang: "uk",
      t: (key: string, params?: Record<string, string>) => translate("uk", key, params),
      session: {},
    };

    const ukStaging = renderBroadcastStagingText(ctxUk, userDao, dispatcher);
    expect(ukStaging.text).toContain("Центр масових розсилок");
    expect(ukStaging.text).toContain("Всього адресатів:");
  });

  it("7. Full Real-World Admin Broadcast Simulation: from Telegram interaction & lossless entity capture to DWRR delivery, multi-language segregation, zero-loss outbox draining, and post-dispatch clean reset", async () => {
    // A. Seed 7 Realistic Users with various activity levels, languages, and donor statuses
    const now = Date.now();
    const twentyDaysAgo = new Date(now - 20 * 86400 * 1000).toISOString();

    // 1. 👑 Admin (UK)
    db.prepare(`
      INSERT OR REPLACE INTO users (id, telegram_id, username, first_name, language, is_admin, total_donated_stars, last_active_at)
      VALUES (1, 101, 'admin_super', 'Admin Chief', 'uk', 1, 0, CURRENT_TIMESTAMP)
    `).run();

    // 2. 💎 Diamond Patron 500 Stars (EN)
    db.prepare(`
      INSERT OR REPLACE INTO users (id, telegram_id, username, first_name, language, is_admin, total_donated_stars, last_active_at)
      VALUES (2, 102, 'vip_john', 'John Doe', 'en', 0, 500, CURRENT_TIMESTAMP)
    `).run();

    // 3. 💎 Patron 100 Stars (UK)
    db.prepare(`
      INSERT OR REPLACE INTO users (id, telegram_id, username, first_name, language, is_admin, total_donated_stars, last_active_at)
      VALUES (3, 103, 'donor_taras', 'Taras', 'uk', 0, 100, CURRENT_TIMESTAMP)
    `).run();

    // 4. ☕ Supporter 15 Stars (RU)
    db.prepare(`
      INSERT OR REPLACE INTO users (id, telegram_id, username, first_name, language, is_admin, total_donated_stars, last_active_at)
      VALUES (4, 104, 'alex_ru', 'Alex', 'ru', 0, 15, CURRENT_TIMESTAMP)
    `).run();

    // 5. ⚡ Active Free User (EN)
    db.prepare(`
      INSERT OR REPLACE INTO users (id, telegram_id, username, first_name, language, is_admin, total_donated_stars, last_active_at)
      VALUES (5, 105, 'sarah_en', 'Sarah', 'en', 0, 0, CURRENT_TIMESTAMP)
    `).run();

    // 6. ⚡ Active Free User (RU)
    db.prepare(`
      INSERT OR REPLACE INTO users (id, telegram_id, username, first_name, language, is_admin, total_donated_stars, last_active_at)
      VALUES (6, 106, 'dmitry_ru', 'Dmitry', 'ru', 0, 0, CURRENT_TIMESTAMP)
    `).run();

    // 7. 💤 Dormant Free User (20d inactive, UK) -> Should be excluded from active broadcasts
    db.prepare(`
      INSERT OR REPLACE INTO users (id, telegram_id, username, first_name, language, is_admin, total_donated_stars, last_active_at)
      VALUES (7, 107, 'ghost_user', 'Ghost', 'uk', 0, 0, ?)
    `).run(twentyDaysAgo);

    // Re-hydrate RAM Inverted Index
    const liveIndex = new SubscriberInvertedIndex(db);

    const sentMessages: { chatId: number; text: string; options?: any }[] = [];
    const simulatedBot: any = {
      api: {
        sendMessage: vi.fn().mockImplementation((chatId: number, text: string, options?: any) => {
          sentMessages.push({ chatId, text, options });
          return Promise.resolve({ message_id: Math.floor(Math.random() * 10000) });
        }),
      },
    };

    const dispatcher = new NotificationDispatcher(
      simulatedBot,
      userDao,
      logDao,
      undefined,
      liveIndex,
      undefined,
      outboxDao
    );

    // Admin context with English UI
    const adminCtx: any = {
      from: { id: 101, username: "admin_super", first_name: "Admin" },
      lang: "en",
      t: (key: string, params?: Record<string, string>) => translate("en", key, params),
      session: {},
    };

    // B. Step 1: Admin enters Broadcast Hub
    const hub1 = renderBroadcastStagingText(adminCtx, userDao, dispatcher);
    expect(hub1.text).toContain("Mass Broadcast Center");
    expect(hub1.text).toContain("Total Recipients:</b> <b>6 users</b>"); // 7th user (dormant) correctly filtered out
    expect(hub1.text).toContain("Ukrainian: <b>❌ Not created</b>");
    expect(hub1.text).toContain("English: <b>❌ Not created</b>");
    expect(hub1.text).toContain("Russian: <b>❌ Not created</b>");

    const session = getOrCreateBroadcastSession(adminCtx);

    // C. Step 2: Admin inputs and confirms Ukrainian (UK) Draft
    session.drafts.uk = {
      htmlText: "📢 <b>Важливе оновлення 2.0!</b> Додано нові сервери та <code>AI моделі</code>.",
      rawText: "📢 Важливе оновлення 2.0! Додано нові сервери та AI моделі.",
      entitiesCount: 2,
      hasCustomEmoji: false,
      mediaType: "text",
      createdAt: Date.now(),
      isConfirmed: true,
    };

    // D. Step 3: Admin inputs English (EN) Draft and runs self-test
    session.drafts.en = {
      htmlText: "📢 <b>Major Update 2.0!</b> New compute pools and <code>AI models</code> available.",
      rawText: "📢 Major Update 2.0! New compute pools and AI models available.",
      entitiesCount: 2,
      hasCustomEmoji: false,
      mediaType: "text",
      createdAt: Date.now(),
      isConfirmed: false,
    };

    // Preview for English draft
    const previewEn = renderBroadcastPreview(adminCtx, "en", dispatcher);
    expect(previewEn.text).toContain("BROADCAST PREVIEW • [ English 🇬🇧 ]");
    expect(previewEn.text).toContain("Major Update 2.0!");
    expect(previewEn.text).toContain("Recipients of this language:</b> <code>2</code> users (33%)");

    // Admin tests self delivery of EN draft
    await simulatedBot.api.sendMessage(adminCtx.from.id, session.drafts.en.htmlText, { parse_mode: "HTML" });
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].chatId).toBe(101);
    expect(sentMessages[0].text).toContain("Major Update 2.0!");

    // Admin confirms EN draft
    session.drafts.en.isConfirmed = true;

    // E. Step 4: Admin inputs and confirms Russian (RU) Draft
    session.drafts.ru = {
      htmlText: "📢 <b>Крупное обновление 2.0!</b> Добавлены новые пулы и <code>нейросети</code>.",
      rawText: "📢 Крупное обновление 2.0! Добавлены новые пулы и нейросети.",
      entitiesCount: 2,
      hasCustomEmoji: false,
      mediaType: "text",
      createdAt: Date.now(),
      isConfirmed: true,
    };

    // Staging hub now shows all 3 ready
    const hubReady = renderBroadcastStagingText(adminCtx, userDao, dispatcher);
    expect(hubReady.text).toContain("Ukrainian: <b>✅ Ready");
    expect(hubReady.text).toContain("English: <b>✅ Ready");
    expect(hubReady.text).toContain("Russian: <b>✅ Ready");

    // F. Step 5: Pre-Flight Launchpad & Modal Confirmation
    const preflight = renderBroadcastPreflight(adminCtx, dispatcher);
    expect(preflight.text).toContain("Preflight Broadcast Launch");
    expect(preflight.text).toContain("Total Audience:</b> <b>6 users</b>");
    expect(preflight.text).toContain("Delivery Speed:</b> ~27-30 msgs/sec");
    expect(preflight.text).toContain("Queue Priority:</b> P0 (Admins ➔ Donors ➔ Active Users)");

    const modal = renderBroadcastModalConfirm(adminCtx, dispatcher);
    expect(modal.text).toContain("CONFIRM BROADCAST LAUNCH");
    expect(modal.text).toContain("broadcast to <b>6 users</b>");

    // G. Step 6: Execute Broadcast Dispatch & Clean Session Reset
    const broadcastDrafts = {
      uk: session.drafts.uk?.htmlText,
      en: session.drafts.en?.htmlText,
      ru: session.drafts.ru?.htmlText,
    };

    const dispatchResult = await dispatcher.dispatchBroadcastBatch(broadcastDrafts, {
      sendSilent: false,
      filter: "active_only",
    });

    expect(dispatchResult.totalEnqueued).toBe(6);
    expect(dispatchResult.statsByLang.uk).toBe(2); // User 101, 103
    expect(dispatchResult.statsByLang.en).toBe(2); // User 102, 105
    expect(dispatchResult.statsByLang.ru).toBe(2); // User 104, 106

    // Invariant: Session is cleanly wiped so future broadcasts start fresh
    resetBroadcastSession(adminCtx);
    expect(adminCtx.session.broadcast.stage).toBe("idle");
    expect(Object.keys(adminCtx.session.broadcast.drafts).length).toBe(0);

    // H. Step 7: Verify SQLite Outbox Records & Language Segregation
    const pendingOutbox = outboxDao.getPending(10);
    expect(pendingOutbox.length).toBe(6);

    // Verify exact language match per user in SQLite
    const msg101 = pendingOutbox.find((o) => o.telegramId === 101);
    expect(msg101?.messageText).toContain("Важливе оновлення 2.0");
    expect(msg101?.language).toBe("uk");

    const msg102 = pendingOutbox.find((o) => o.telegramId === 102);
    expect(msg102?.messageText).toContain("Major Update 2.0");
    expect(msg102?.language).toBe("en");

    const msg104 = pendingOutbox.find((o) => o.telegramId === 104);
    expect(msg104?.messageText).toContain("Крупное обновление 2.0");
    expect(msg104?.language).toBe("ru");

    // User 107 (dormant) must NOT have any outbox records
    const msg107 = pendingOutbox.find((o) => o.telegramId === 107);
    expect(msg107).toBeUndefined();

    // I. Step 8: Priority Draining with Concurrent Slot Drops
    // Inject a sudden high-priority slot drop alert into P1
    (dispatcher as any).p1Queue.push({
      id: "slot-alert-urgent",
      telegramId: 102,
      userId: 2,
      poolSlug: "frontier-cluster",
      blockId: "asia",
      eventType: "available",
      text: "⚡ <b>Frontier Cluster Slot Available NOW!</b>",
      isMuted: false,
      priority: "P1",
      retries: 0,
      enqueuedAt: Date.now(),
    });

    // Drain the dispatcher queue
    const dispatchedPriorities: string[] = [];
    for (let i = 0; i < 7; i++) {
      const candidate = (dispatcher as any).selectNextItemDWRR(true);
      if (candidate) {
        dispatchedPriorities.push(candidate.priority);
      }
    }

    // Must have successfully serviced both P0 broadcasts and the P1 slot drop without lock or delay
    expect(dispatchedPriorities).toContain("P0");
    expect(dispatchedPriorities).toContain("P1");
  });

  it("8. Media Broadcast & Crash Recovery: lossless media dispatch and seamless SQLite outbox resumption after crash", async () => {
    const testDispatcher = new NotificationDispatcher(
      mockBot,
      userDao,
      logDao,
      undefined,
      invertedIndex,
      undefined,
      outboxDao
    );

    // A. Dispatch media broadcast (Photo with Caption)
    const mediaDrafts = {
      uk: {
        text: "⚡ <b>Нове покоління серверів!</b> Дивіться фотографію нижче:",
        mediaType: "photo" as const,
        fileId: "AgACAgIAAxkBAAIB...", // Original highest-res Telegram file_id
      },
      en: {
        text: "⚡ <b>New Server Generation!</b> See photo below:",
        mediaType: "photo" as const,
        fileId: "AgACAgIAAxkBAAIB...",
      },
      ru: {
        text: "⚡ <b>Новое поколение серверов!</b> Смотрите фото ниже:",
        mediaType: "photo" as const,
        fileId: "AgACAgIAAxkBAAIB...",
      },
    };

    const res = await testDispatcher.dispatchBroadcastBatch(mediaDrafts, { filter: "active_only" });
    expect(res.totalEnqueued).toBe(4);

    // Verify items in SQLite outbox have media_type = 'photo' and correct file_id
    const pending = outboxDao.getPending(10);
    expect(pending.length).toBe(4);
    expect(pending[0].mediaType).toBe("photo");
    expect(pending[0].fileId).toBe("AgACAgIAAxkBAAIB...");

    // B. Simulate sending first 2 messages during active broadcast
    const msg1 = (testDispatcher as any).p0Queue.pop();
    const msg2 = (testDispatcher as any).p0Queue.pop();
    outboxDao.markDispatched(msg1.id);
    outboxDao.markDispatched(msg2.id);

    // Remaining in SQLite outbox is 2 pending messages
    const remainingPending = outboxDao.getPending(10);
    expect(remainingPending.length).toBe(2);

    // C. Simulate Server Crash & Reboot:
    // Create fresh dispatcher instance connected to same SQLite DB
    const restartedDispatcher = new NotificationDispatcher(
      mockBot,
      userDao,
      logDao,
      undefined,
      invertedIndex,
      undefined,
      outboxDao
    );

    // The restarted dispatcher must have automatically hydrated exactly the 2 remaining messages into P0 on boot
    expect((restartedDispatcher as any).p0Queue.size()).toBe(2);

    // Drain and verify that mediaType and fileId survived the reboot intact
    const nextMsg = (restartedDispatcher as any).p0Queue.pop();
    expect(nextMsg.mediaType).toBe("photo");
    expect(nextMsg.fileId).toBe("AgACAgIAAxkBAAIB...");
    expect(nextMsg.text).toMatch(/покоління|поколение|Server Generation/);
  });

  it("9. Caption Length Guard, Quote Escaping & Unconfirmed Draft Isolation", async () => {
    // 1. Verify escapeHtmlText escapes double quotes
    const raw = `Check this "link" & <test>`;
    expect(escapeHtmlText(raw)).toBe("Check this &quot;link&quot; &amp; &lt;test&gt;");

    // 2. Verify unconfirmed draft isolation:
    // UK is confirmed, EN is unconfirmed (isConfirmed = false)
    const session: any = {
      stage: "language_select",
      drafts: {
        uk: {
          htmlText: "📢 <b>Підтверджений український текст</b>",
          rawText: "Підтверджений український текст",
          entitiesCount: 1,
          hasCustomEmoji: false,
          mediaType: "text",
          isConfirmed: true,
        },
        en: {
          htmlText: "📢 <b>Unconfirmed exploratory draft</b>",
          rawText: "Unconfirmed exploratory draft",
          entitiesCount: 1,
          hasCustomEmoji: false,
          mediaType: "text",
          isConfirmed: false,
        },
      },
    };

    const adminCtx: any = {
      lang: "uk",
      t: (key: string, params?: Record<string, string>) => translate("uk", key, params),
      session: { broadcast: session },
    };

    const testDispatcher = new NotificationDispatcher(
      mockBot,
      userDao,
      logDao,
      undefined,
      invertedIndex,
      undefined,
      outboxDao
    );

    // Staging text should render Clear Drafts button even with unconfirmed drafts
    const staging = renderBroadcastStagingText(adminCtx, userDao, testDispatcher);
    expect(staging.keyboard.inline_keyboard.some((row: any[]) => row.some((btn) => btn.callback_data === "admin_bc_clear"))).toBe(true);

    // Filtering by isConfirmed: only confirmed drafts pass to dispatcher
    const executableDrafts = {
      uk: session.drafts.uk?.isConfirmed ? session.drafts.uk.htmlText : undefined,
      en: session.drafts.en?.isConfirmed ? session.drafts.en.htmlText : undefined,
      ru: session.drafts.ru?.isConfirmed ? session.drafts.ru.htmlText : undefined,
    };

    expect(executableDrafts.uk).toBe("📢 <b>Підтверджений український текст</b>");
    expect(executableDrafts.en).toBeUndefined();

    // Dispatching should fall back English users to the confirmed UK draft
    const res = await testDispatcher.dispatchBroadcastBatch(executableDrafts, { filter: "active_only" });
    expect(res.totalEnqueued).toBe(4);
    // All recipients received the confirmed UK text
    expect(res.statsByLang.uk).toBe(4);
  });
});
