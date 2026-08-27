import { BotContext } from "../../types/context.js";
import { UserDAO } from "../../db/dao/users.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { renderDashboardText } from "../menus/mainDashboard.js";
import { renderPoolDetailText } from "../menus/poolDetail.js";
import { renderSubscriptionsText } from "../menus/subscriptions.js";

import { LiveDashboardManager } from "../liveSync/liveDashboardManager.js";
import { ScraperOrchestrator } from "../../engine/scraperOrchestrator.js";

export function createStartHandler(
  userDao: UserDAO,
  poolStateDao: PoolStateDAO,
  languageMenu: any,
  mainDashboardMenu: any,
  historyDao?: SlotHistoryDAO,
  subDao?: SubscriptionDAO,
  subscriptionsMenu?: any,
  poolDetailMenu?: any,
  scraper?: ScraperOrchestrator,
  liveDashboardManager?: LiveDashboardManager
) {
  return async (ctx: BotContext) => {
    if (!ctx.from || !ctx.chat) return;

    const match = (ctx as any).match;
    if (ctx.isNewUser) {
      if (match && typeof match === "string") {
        (ctx.session as any).pendingDeepLink = match;
      }
      await ctx.reply(ctx.t("onboarding.welcome_title"), {
        reply_markup: languageMenu,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      return;
    }
    if (match && typeof match === "string") {
      if (match.startsWith("pool_") && poolDetailMenu) {
        const slug = match.replace("pool_", "");
        ctx.session.tempPoolSlug = slug;
        const msg = await ctx.reply(renderPoolDetailText(ctx, poolStateDao, historyDao, scraper), {
          reply_markup: poolDetailMenu,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        liveDashboardManager?.getRegistry().register(ctx.chat.id, msg.message_id, ctx.user.id, ctx.lang, "pool_detail", slug);
        return;
      }
      if ((match === "alerts" || match === "subscriptions") && subDao && subscriptionsMenu) {
        const msg = await ctx.reply(renderSubscriptionsText(ctx, subDao), {
          reply_markup: subscriptionsMenu,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        liveDashboardManager?.getRegistry().register(ctx.chat.id, msg.message_id, ctx.user.id, ctx.lang, "subscriptions");
        return;
      }
    }

    const msg = await ctx.reply(renderDashboardText(ctx, poolStateDao, historyDao, scraper), {
      reply_markup: mainDashboardMenu,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    liveDashboardManager?.getRegistry().register(ctx.chat.id, msg.message_id, ctx.user.id, ctx.lang, "dashboard");
  };
}
