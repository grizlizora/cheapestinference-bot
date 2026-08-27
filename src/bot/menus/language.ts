import { Menu } from "@grammyjs/menu";
import { BotContext } from "../../types/context.js";
import { UserDAO } from "../../db/dao/users.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { SupportedLanguage } from "../../types/db.js";
import { SubscriberInvertedIndex } from "../notifier/subscriberIndex.js";
import { renderDashboardText, safeEditMessageText } from "./mainDashboard.js";
import { renderPoolDetailText } from "./poolDetail.js";
import { renderSubscriptionsText } from "./subscriptions.js";
import { ScraperOrchestrator } from "../../engine/scraperOrchestrator.js";
import { ActiveDashboardRegistry } from "../liveSync/dashboardRegistry.js";

export function createLanguageMenu(
  userDao: UserDAO,
  poolStateDao: PoolStateDAO,
  invertedIndex: SubscriberInvertedIndex,
  historyDao?: SlotHistoryDAO,
  scraper?: ScraperOrchestrator,
  subDao?: SubscriptionDAO,
  dashboardRegistry?: ActiveDashboardRegistry
) {
  const switchLanguage = async (ctx: BotContext, lang: SupportedLanguage, toast: string) => {
    userDao.setLanguage(ctx.from!.id, lang);
    ctx.user.language = lang;
    ctx.lang = lang;
    invertedIndex.updateUserPreferences(ctx.from!.id, { language: lang });

    await ctx.answerCallbackQuery(toast).catch(() => {});

    const msgId = ctx.callbackQuery?.message?.message_id;
    const pendingDeepLink = (ctx.session as any)?.pendingDeepLink;
    if (pendingDeepLink && typeof pendingDeepLink === "string") {
      delete (ctx.session as any).pendingDeepLink;
      if (pendingDeepLink.startsWith("pool_")) {
        const slug = pendingDeepLink.replace("pool_", "");
        ctx.session.tempPoolSlug = slug;
        if (ctx.chat && msgId && dashboardRegistry) {
          dashboardRegistry.register(ctx.chat.id, msgId, ctx.user.id, lang, "pool_detail", slug);
        }
        await safeEditMessageText(ctx, renderPoolDetailText(ctx, poolStateDao, historyDao, scraper));
        return ctx.menu.nav("pool-detail-menu");
      }
      if ((pendingDeepLink === "alerts" || pendingDeepLink === "subscriptions") && subDao) {
        if (ctx.chat && msgId && dashboardRegistry) {
          dashboardRegistry.register(ctx.chat.id, msgId, ctx.user.id, lang, "subscriptions");
        }
        await safeEditMessageText(ctx, renderSubscriptionsText(ctx, subDao));
        return ctx.menu.nav("subscriptions-menu");
      }
    }

    const fromOnboarding = (ctx.session as any)?.fromOnboarding;
    if (fromOnboarding) {
      delete (ctx.session as any).fromOnboarding;
      if (ctx.chat && msgId && dashboardRegistry) {
        dashboardRegistry.register(ctx.chat.id, msgId, ctx.user.id, lang, "dashboard");
      }
      await safeEditMessageText(ctx, renderDashboardText(ctx, poolStateDao, historyDao, scraper));
      return ctx.menu.nav("main-dashboard-menu");
    }

    if (ctx.chat && msgId && dashboardRegistry) {
      dashboardRegistry.register(ctx.chat.id, msgId, ctx.user.id, lang, "other");
    }

    const { renderSettingsText } = await import("./settings.js");
    await safeEditMessageText(ctx, renderSettingsText(ctx));
    return ctx.menu.nav("settings-menu");
  };

  return new Menu<BotContext>("language-menu")
    .text("🇺🇦 Українська", async (ctx) => {
      return switchLanguage(ctx, "uk", "Мову змінено на Українську 🇺🇦");
    })
    .row()
    .text("🇬🇧 English", async (ctx) => {
      return switchLanguage(ctx, "en", "Language changed to English 🇬🇧");
    })
    .row()
    .text("🇷🇺 Русский", async (ctx) => {
      return switchLanguage(ctx, "ru", "Язык изменен на Русский 🇷🇺");
    })
    .row()
    .text(
      (ctx) => ctx.t("common.back"),
      async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        const fromOnboarding = (ctx.session as any)?.fromOnboarding;
        if (fromOnboarding) {
          delete (ctx.session as any).fromOnboarding;
          const msgId = ctx.callbackQuery?.message?.message_id;
          if (ctx.chat && msgId && dashboardRegistry) {
            dashboardRegistry.register(ctx.chat.id, msgId, ctx.user.id, ctx.lang, "dashboard");
          }
          await safeEditMessageText(ctx, renderDashboardText(ctx, poolStateDao, historyDao, scraper));
          return ctx.menu.nav("main-dashboard-menu");
        }

        const { renderSettingsText } = await import("./settings.js");
        await safeEditMessageText(ctx, renderSettingsText(ctx));
        return ctx.menu.nav("settings-menu");
      }
    );
}
