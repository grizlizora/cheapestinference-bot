import { describe, it, expect } from "vitest";
import { translate, SUPPORTED_LANGUAGES, getLanguageFlag } from "../src/i18n/index.js";

describe("i18n subsystem", () => {
  it("should support uk, en, and ru", () => {
    expect(SUPPORTED_LANGUAGES).toEqual(["uk", "en", "ru"]);
  });

  it("should correctly translate common keys in Ukrainian", () => {
    expect(translate("uk", "common.status_available")).toBe("🟢 Доступно");
    expect(translate("uk", "common.status_sold_out")).toContain("Розпродано");
    expect(translate("uk", "subscriptions.toast_global_on")).toBe("🌐 Глобальні сповіщення увімкнено");
    expect(translate("uk", "menu.loading_data")).toContain("Завантаження");
  });

  it("should correctly translate common keys in English", () => {
    expect(translate("en", "common.status_available")).toBe("🟢 Available");
    expect(translate("en", "common.status_sold_out")).toBe("🔴 Sold Out");
    expect(translate("en", "subscriptions.toast_global_on")).toBe("🌐 Global alerts enabled");
    expect(translate("en", "menu.loading_data")).toContain("Loading");
  });

  it("should correctly translate common keys in Russian", () => {
    expect(translate("ru", "common.status_available")).toBe("🟢 Доступно");
    expect(translate("ru", "common.status_sold_out")).toContain("Распродано");
    expect(translate("ru", "subscriptions.toast_global_on")).toBe("🌐 Глобальные уведомления включены");
    expect(translate("ru", "menu.loading_data")).toContain("Загрузка");
  });

  it("should interpolate template variables correctly", () => {
    const textUk = translate("uk", "pool_detail.btn_subscribe_pool", { pool_name: "FLAGSHIP" });
    expect(textUk).toBe("🔔 Підписатися на весь пул FLAGSHIP");

    const batchEn = translate("en", "alerts.batch_title", { count: 3 });
    expect(batchEn).toBe("🚨 <b>CheapestInference Updates (3)</b>");
  });

  it("should return appropriate flag label", () => {
    expect(getLanguageFlag("uk")).toBe("🇺🇦 Українська");
    expect(getLanguageFlag("en")).toBe("🇬🇧 English");
    expect(getLanguageFlag("ru")).toBe("🇷🇺 Русский");
  });
});
