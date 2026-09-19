import { Menu } from "@grammyjs/menu";
import { BotContext } from "../../types/context.js";
import { UserDAO } from "../../db/dao/users.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { SupportedLanguage } from "../../types/db.js";
import { SubscriberInvertedIndex } from "../notifier/subscriberIndex.js";
import { renderDashboardText, renderSettingsText, safeEditMessageText, safeNavigateAndEdit } from "./mainDashboard.js";
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

    ctx.answerCallbackQuery(toast).catch(() => {});

    const msgId = ctx.callbackQuery?.message?.message_id;
    const pendingDeepLink = ctx.session?.pendingDeepLink;
    if (pendingDeepLink && typeof pendingDeepLink === "string") {
      delete ctx.session.pendingDeepLink;
      if (pendingDeepLink.startsWith("pool_")) {
        const slug = pendingDeepLink.replace("pool_", "");
        const knownPools = poolStateDao.getPoolSummaries();
        const poolExists = knownPools.some((p) => p.slug === slug);
        if (poolExists) {
          ctx.session.tempPoolSlug = slug;
          if (ctx.chat && msgId && dashboardRegistry) {
            dashboardRegistry.register(ctx.chat.id, msgId, ctx.user.id, lang, "pool_detail", slug);
          }
          await safeNavigateAndEdit(ctx, "pool-detail-menu", renderPoolDetailText(ctx, poolStateDao, historyDao, scraper));
          return;
        }
      }
      if ((pendingDeepLink === "alerts" || pendingDeepLink === "subscriptions") && subDao) {
        if (ctx.chat && msgId && dashboardRegistry) {
          dashboardRegistry.register(ctx.chat.id, msgId, ctx.user.id, lang, "subscriptions");
        }
        await safeNavigateAndEdit(ctx, "subscriptions-menu", renderSubscriptionsText(ctx, subDao));
        return;
      }
    }

    const fromSettings = ctx.session?.fromSettings;
    if (fromSettings) {
      delete ctx.session.fromSettings;
      if (ctx.chat && msgId && dashboardRegistry) {
        dashboardRegistry.register(ctx.chat.id, msgId, ctx.user.id, lang, "settings");
      }
      await safeNavigateAndEdit(ctx, "settings-menu", renderSettingsText(ctx));
      return;
    }

    if (ctx.chat && msgId && dashboardRegistry) {
      dashboardRegistry.register(ctx.chat.id, msgId, ctx.user.id, lang, "dashboard");
    }

    await safeNavigateAndEdit(ctx, "main-dashboard-menu", renderDashboardText(ctx, poolStateDao, historyDao, scraper));
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
        ctx.answerCallbackQuery().catch(() => {});
        const fromSettings = (ctx.session as any)?.fromSettings;
        if (fromSettings) {
          delete (ctx.session as any).fromSettings;
          if (ctx.chat) {
            dashboardRegistry?.updateView(ctx.chat.id, "settings");
          }
          await safeNavigateAndEdit(ctx, "settings-menu", renderSettingsText(ctx));
          return;
        }

        if (ctx.chat) {
          dashboardRegistry?.updateView(ctx.chat.id, "dashboard");
        }
        await safeNavigateAndEdit(ctx, "main-dashboard-menu", renderDashboardText(ctx, poolStateDao, historyDao, scraper));
      }
    );
}
