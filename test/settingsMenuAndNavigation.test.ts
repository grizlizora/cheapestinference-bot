import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initDatabase } from "../src/db/index.js";
import { UserDAO } from "../src/db/dao/users.js";
import { SubscriptionDAO } from "../src/db/dao/subscriptions.js";
import { PoolStateDAO } from "../src/db/dao/poolState.js";
import { renderSettingsText, renderIntegrityText } from "../src/bot/menus/settings.js";
import { CodeIntegrityEngine } from "../src/engine/codeIntegrityEngine.js";
import { NodeActivationEngine } from "../src/engine/nodeActivationEngine.js";
import { BotContext } from "../src/types/context.js";
import { translate } from "../src/i18n/index.js";

describe("Settings Menu & Cryptographic Report Text Rendering", () => {
  let db: Database.Database;
  let userDao: UserDAO;
  let subDao: SubscriptionDAO;
  let poolDao: PoolStateDAO;

  beforeEach(() => {
    db = new Database(":memory:");
    initDatabase(db);
    userDao = new UserDAO(db);
    subDao = new SubscriptionDAO(db);
    poolDao = new PoolStateDAO(db);
  });

  afterEach(() => {
    db.close();
  });

  it("renders Settings text with Telegram ID and language", () => {
    const user = userDao.upsertUser({
      telegram_id: 99887766,
      username: "grizlizora",
      first_name: "Roman",
      language: "uk",
    });

    const mockCtx = {
      user,
      lang: "uk",
      from: { id: 99887766, username: "grizlizora" },
      t: (key: string, params?: any) => translate("uk", key, params),
    } as unknown as BotContext;

    const text = renderSettingsText(mockCtx);
    expect(text).toContain("99887766");
    expect(text).toContain("@grizlizora");
    expect(text).toContain("Українська");
  });

  it("renders authentic and mismatch integrity report text", () => {
    const mockCtx = {
      lang: "uk",
      t: (key: string, params?: any) => translate("uk", key, params),
    } as unknown as BotContext;

    const nodeEngine = new NodeActivationEngine();

    // 1. Authentic Report
    const authenticReport = {
      isAuthentic: true,
      commitSha: "1928226abc1234567890abcdef12345678901234",
      commitShortSha: "1928226",
      commitMessage: "feat: release zero-trust code integrity verifier",
      commitAuthor: "Roman Grizli",
      commitDate: "2026-08-27T18:00:00Z",
      isGpgVerified: true,
      totalMonitoredFiles: 42,
      identicalCount: 42,
      modifiedCount: 0,
      addedCount: 0,
      deletedCount: 0,
      merkleRoot: "8f4a1c9e7b23d04a6e8f12c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
      challengeCode: "CHECK-A7F9",
      proofHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      verifiedAt: Date.now(),
      executionTimeMs: 45,
      diffs: [],
      githubTreeUrl: "https://github.com/grizlizora/cheapestinference-bot/tree/1928226",
      githubPagesVerifierUrl: "https://grizlizora.github.io/cheapestinference-bot/?code=CHECK-A7F9&hash=e3b0c442...&commit=1928226",
    };

    const successText = renderIntegrityText(mockCtx, authenticReport as any, nodeEngine);
    expect(successText).toContain("ПІДТВЕРДЖЕНО ✅");
    expect(successText).toContain("1928226");
    expect(successText).toContain("CHECK-A7F9");
    expect(successText).toContain("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

    // 2. Mismatch Report
    const mismatchReport = {
      isAuthentic: false,
      commitSha: "1928226abc1234567890abcdef12345678901234",
      commitShortSha: "1928226",
      commitMessage: "test",
      commitAuthor: "Roman",
      commitDate: "2026-08-27T18:00:00Z",
      isGpgVerified: false,
      totalMonitoredFiles: 42,
      identicalCount: 40,
      modifiedCount: 1,
      addedCount: 1,
      deletedCount: 0,
      merkleRoot: "000000",
      challengeCode: "CHECK-FAIL",
      proofHash: "111111",
      verifiedAt: Date.now(),
      executionTimeMs: 50,
      diffs: [
        { path: "src/engine/diffEngine.ts", status: "modified" as const },
        { path: "src/backdoor.ts", status: "added" as const },
      ],
      githubTreeUrl: "https://github.com/...",
      githubPagesVerifierUrl: "https://grizlizora.github.io/...",
    };

    const mismatchText = renderIntegrityText(mockCtx, mismatchReport as any, nodeEngine);
    expect(mismatchText).toContain("Виявлено розбіжності");
    expect(mismatchText).toContain("src/engine/diffEngine.ts");
    expect(mismatchText).toContain("src/backdoor.ts");
  });
});
