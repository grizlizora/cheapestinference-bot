import { Menu } from "@grammyjs/menu";
import { BotContext } from "../../types/context.js";
import { UserDAO } from "../../db/dao/users.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { SupportedLanguage } from "../../types/db.js";
import { renderDashboardText, safeEditMessageText } from "./mainDashboard.js";

export function createLanguageMenu(userDao: UserDAO, poolStateDao: PoolStateDAO) {
  const switchLanguage = async (ctx: BotContext, lang: SupportedLanguage, toast: string) => {
    userDao.setLanguage(ctx.from!.id, lang);
    ctx.user.language = lang;
    ctx.lang = lang;
    await ctx.answerCallbackQuery(toast);
    await safeEditMessageText(ctx, renderDashboardText(ctx, poolStateDao));
    return ctx.menu.nav("main-dashboard");
  };

  return new Menu<BotContext>("language-menu")
    .text("🇺🇦 Українська", async (ctx) => {
      return switchLanguage(ctx, "uk", "Мову змінено на Українську 🇺🇦");
    })
    .text("🇬🇧 English", async (ctx) => {
      return switchLanguage(ctx, "en", "Language changed to English 🇬🇧");
    })
    .text("🇷🇺 Русский", async (ctx) => {
      return switchLanguage(ctx, "ru", "Язык изменен на Русский 🇷🇺");
    })
    .row()
    .back(
      (ctx) => ctx.t("common.back"),
      async (ctx) => {
        await safeEditMessageText(ctx, renderDashboardText(ctx, poolStateDao));
      }
    );
}
