import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { UserDAO } from "../src/db/dao/users.js";
import { PoolStateDAO } from "../src/db/dao/poolState.js";
import { SubscriptionDAO } from "../src/db/dao/subscriptions.js";
import { createStartHandler } from "../src/bot/handlers/start.js";
import { initSchema } from "../src/db/index.js";

import { translate } from "../src/i18n/index.js";

describe("User Language Selection & /start Lifecycle Invariants", () => {
  let db: Database.Database;
  let userDao: UserDAO;
  let poolStateDao: PoolStateDAO;
  let subDao: SubscriptionDAO;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    userDao = new UserDAO(db);
    poolStateDao = new PoolStateDAO(db);
    subDao = new SubscriptionDAO(db);

    poolStateDao.saveSnapshot([
      {
        slug: "flagship",
        modelName: "Flagship Pool",
        models: ["deepseek-v3"],
        blocks: [
          {
            block: "europe",
            status: "available",
            hoursUtc: "08:00 – 16:00 UTC",
            pricePerMonth: "50.00",
          },
        ],
        minPricePerDay: "1.67",
        annualDiscount: 0.15,
        description: "Fast flagship compute",
        infraSpec: "4x H100 SXM5",
        manualProvisioning: false,
      },
    ]);
  });

  it("should show language selection on first /start, then directly open Dashboard on subsequent /start", async () => {
    const tgId = 828157777;
    const username = "grizlizora";

    // 1. Initial State: User does not exist in DB
    expect(userDao.getByTelegramId(tgId)).toBeUndefined();

    // 2. Simulated Middleware for first request
    let user = userDao.getByTelegramId(tgId);
    let isNewUser = false;
    if (!user) {
      user = userDao.upsertUser({
        telegram_id: tgId,
        username,
        first_name: "Роман",
        language: "uk",
      });
      isNewUser = true;
    }

    expect(isNewUser).toBe(true);
    expect(user.language).toBe("uk");

    // 3. User selects language "uk" in the menu
    userDao.setLanguage(tgId, "uk");
    const updatedUser = userDao.getByTelegramId(tgId);
    expect(updatedUser?.language).toBe("uk");

    // 4. Second /start command from the same user (subsequent interaction)
    let secondUser = userDao.getByTelegramId(tgId);
    let isSecondNewUser = false;
    if (!secondUser) {
      secondUser = userDao.upsertUser({
        telegram_id: tgId,
        username,
        first_name: "Роман",
        language: "uk",
      });
      isSecondNewUser = true;
    }

    // Must NOT be treated as a new user!
    expect(isSecondNewUser).toBe(false);
    expect(secondUser?.language).toBe("uk");

    // 5. Verify start handler routes existing user to Dashboard
    let repliedText = "";
    let replyMarkup: any = null;

    const mockCtx: any = {
      from: { id: tgId, username, first_name: "Роман" },
      chat: { id: tgId, type: "private" },
      user: secondUser,
      lang: secondUser?.language || "uk",
      isNewUser: isSecondNewUser,
      session: {},
      t: (key: string, params?: any) => translate(secondUser?.language as any || "uk", key, params),
      reply: async (text: string, opts?: any) => {
        repliedText = text;
        replyMarkup = opts?.reply_markup;
        return { message_id: 1001 };
      },
    };

    const startHandler = createStartHandler(
      userDao,
      poolStateDao,
      { name: "language-menu" },
      { name: "main-dashboard-menu" },
      undefined,
      subDao
    );

    await startHandler(mockCtx);

    // Verified: existing user gets main-dashboard-menu, NOT language-menu
    expect(replyMarkup?.name).toBe("main-dashboard-menu");
    expect(repliedText).toContain("CheapestInference");
  });
});
