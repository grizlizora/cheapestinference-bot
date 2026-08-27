import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { UserDAO } from "../src/db/dao/users.js";
import { SubscriptionDAO } from "../src/db/dao/subscriptions.js";
import { SubscriberInvertedIndex } from "../src/bot/notifier/subscriberIndex.js";
import fs from "node:fs";

describe("Parent-Child Pool Subscription Synchronization & Persistence Invariants", () => {
  let db: any;
  let userDao: UserDAO;
  let subDao: SubscriptionDAO;
  let invertedIndex: SubscriberInvertedIndex;
  const testDbPath = ":memory:";

  beforeEach(() => {
    db = new Database(testDbPath);
    const schema = fs.readFileSync("src/db/schema.sql", "utf8");
    db.exec(schema);

    userDao = new UserDAO(db);
    subDao = new SubscriptionDAO(db);
  });

  it("1. should report all regional blocks as active when user subscribes to the whole pool (ALL)", () => {
    const user = userDao.upsertUser({ telegram_id: 111222, first_name: "User1", language: "uk" });
    const blockIds = ["asia", "europe", "americas"];

    // User clicks subscribe to CORE pool
    const active = subDao.togglePoolWithBlocks(user.id, "core", blockIds);
    expect(active).toBe(true);

    // All regional blocks must evaluate to true
    expect(subDao.isBlockSubscribed(user.id, "core", "asia")).toBe(true);
    expect(subDao.isBlockSubscribed(user.id, "core", "europe")).toBe(true);
    expect(subDao.isBlockSubscribed(user.id, "core", "americas")).toBe(true);
    expect(subDao.isPoolSubscribed(user.id, "core", blockIds)).toBe(true);
  });

  it("2. should decompose ALL into individual blocks when user turns off one regional block", () => {
    const user = userDao.upsertUser({ telegram_id: 111222, first_name: "User1", language: "uk" });
    const blockIds = ["asia", "europe", "americas"];

    // Subscribe to whole pool first
    subDao.togglePoolWithBlocks(user.id, "core", blockIds);
    expect(subDao.hasSubscription(user.id, "core", "ALL")).toBe(true);

    // User clicks Asia to turn it off
    const result = subDao.toggleBlockAndUpdatePool(user.id, "core", "asia", blockIds);
    expect(result.isBlockSubscribed).toBe(false);
    expect(result.isPoolSubscribed).toBe(false);

    // In SQLite: ALL is deleted, europe and americas exist, asia does not exist
    expect(subDao.hasSubscription(user.id, "core", "ALL")).toBe(false);
    expect(subDao.isBlockSubscribed(user.id, "core", "asia")).toBe(false);
    expect(subDao.isBlockSubscribed(user.id, "core", "europe")).toBe(true);
    expect(subDao.isBlockSubscribed(user.id, "core", "americas")).toBe(true);
    expect(subDao.isPoolSubscribed(user.id, "core", blockIds)).toBe(false);
  });

  it("3. should auto-promote to ALL when user re-enables all regional blocks individually", () => {
    const user = userDao.upsertUser({ telegram_id: 111222, first_name: "User1", language: "uk" });
    const blockIds = ["asia", "europe", "americas"];

    // User subscribes only to europe and americas
    subDao.toggleBlockAndUpdatePool(user.id, "core", "europe", blockIds);
    subDao.toggleBlockAndUpdatePool(user.id, "core", "americas", blockIds);
    expect(subDao.isPoolSubscribed(user.id, "core", blockIds)).toBe(false);

    // Now user enables asia
    const result = subDao.toggleBlockAndUpdatePool(user.id, "core", "asia", blockIds);
    expect(result.isBlockSubscribed).toBe(true);
    expect(result.isPoolSubscribed).toBe(true);

    // In SQLite: auto-promoted to ALL, individual blocks cleaned up
    expect(subDao.hasSubscription(user.id, "core", "ALL")).toBe(true);
    expect(subDao.hasSubscription(user.id, "core", "asia")).toBe(false);
    expect(subDao.isBlockSubscribed(user.id, "core", "asia")).toBe(true);
    expect(subDao.isBlockSubscribed(user.id, "core", "europe")).toBe(true);
    expect(subDao.isBlockSubscribed(user.id, "core", "americas")).toBe(true);
  });

  it("4. should deliver granular sold_out alert even when notify_sold_out_global is false", () => {
    const user = userDao.upsertUser({
      telegram_id: 999888,
      first_name: "User2",
      language: "uk",
      notify_sold_out_global: 0, // Global is false
    });
    const blockIds = ["asia", "europe", "americas"];

    // User subscribes to Core Pool with sold_out enabled
    subDao.togglePoolWithBlocks(user.id, "core", blockIds);
    subDao.togglePoolEventCategory(user.id, "core", "sold_out"); // Enable sold_out for core pool
    const flags = subDao.getPoolFlags(user.id, "core");
    expect(flags.soldOut).toBe(true);

    // Hydrate InvertedIndex from DB
    invertedIndex = new SubscriberInvertedIndex(db);

    // Resolve subscribers for sold_out on core:asia
    const subscribers = invertedIndex.resolveSubscribers("core", "asia", "sold_out");
    expect(subscribers.length).toBe(1);
    expect(subscribers[0].telegramId).toBe(999888);
    expect(subscribers[0].language).toBe("uk");
  });

  it("5. should persist language choice in SQLite and hydrate accurately into RAM", () => {
    const user = userDao.upsertUser({ telegram_id: 777666, first_name: "User3", language: "en" });
    expect(user.language).toBe("en");

    // User switches language to uk
    userDao.setLanguage(777666, "uk");
    const updated = userDao.getByTelegramId(777666);
    expect(updated?.language).toBe("uk");

    // Hydrate InvertedIndex from DB
    invertedIndex = new SubscriberInvertedIndex(db);
    const profile = invertedIndex.getProfileByTgId(777666);
    expect(profile?.language).toBe("uk");
  });
});
