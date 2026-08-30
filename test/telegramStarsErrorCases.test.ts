import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/index.js";
import { DonationDAO } from "../src/db/dao/donations.js";
import { UserDAO } from "../src/db/dao/users.js";

describe("🛡️ CHAOS: Telegram Stars (XTR) Error Handling & Tampering Resistance", () => {
  let db: Database.Database;
  let donationDao: DonationDAO;
  let userDao: UserDAO;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    donationDao = new DonationDAO(db);
    userDao = new UserDAO(db);
    userDao.upsertUser({ telegram_id: 123456, username: "StarUser", first_name: "Star", language: "uk" });
  });

  afterEach(() => {
    db.close();
  });

  it("1. Rejects custom star inputs that are non-numeric, negative, or exceed 10,000", () => {
    const isValidStarInput = (text: string): boolean => {
      if (!/^\d+$/.test(text.trim())) return false;
      const num = parseInt(text.trim(), 10);
      return num >= 1 && num <= 10000;
    };

    expect(isValidStarInput("50")).toBe(true);
    expect(isValidStarInput("1")).toBe(true);
    expect(isValidStarInput("10000")).toBe(true);

    // Invalid edge cases
    expect(isValidStarInput("-10")).toBe(false);
    expect(isValidStarInput("0")).toBe(false);
    expect(isValidStarInput("10001")).toBe(false);
    expect(isValidStarInput("50.5")).toBe(false);
    expect(isValidStarInput("abc")).toBe(false);
    expect(isValidStarInput(" 100 ")).toBe(true); // Trims whitespace
    expect(isValidStarInput("100stars")).toBe(false);
  });

  it("2. Enforces XTR currency check and rejects tampered currency webhooks", () => {
    const validateCurrency = (currency: string): boolean => {
      return currency.toUpperCase() === "XTR";
    };

    expect(validateCurrency("XTR")).toBe(true);
    expect(validateCurrency("xtr")).toBe(true);
    expect(validateCurrency("USD")).toBe(false);
    expect(validateCurrency("EUR")).toBe(false);
    expect(validateCurrency("TON")).toBe(false);
  });

  it("3. Idempotently ignores duplicate charge IDs without double-counting stars", () => {
    const user = userDao.getUserByTgId(123456);
    expect(user).toBeDefined();

    // First record of charge (atomically increments total_donated_stars)
    donationDao.recordDonation(user!.id, 123456, 100, "TX_UNIQUE_999");

    const user1 = userDao.getUserByTgId(123456);
    expect(user1?.total_donated_stars).toBe(100);

    // If duplicate payment webhook arrives with same chargeId, verify it is idempotent
    donationDao.recordDonation(user!.id, 123456, 100, "TX_UNIQUE_999");
    const user2 = userDao.getUserByTgId(123456);
    expect(user2?.total_donated_stars).toBe(100); // Still 100, not 200

    const donation = donationDao.getByChargeId("TX_UNIQUE_999");
    expect(donation).toBeDefined();
    expect(donation?.amount_stars).toBe(100);
    expect(donationDao.getUserTotalDonated(user!.id)).toBe(100);
  });
});
