import { BotContext } from "../../types/context.js";
import { UserDAO } from "../../db/dao/users.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { renderDashboardText } from "../menus/mainDashboard.js";
import { renderPoolDetailText } from "../menus/poolDetail.js";
import { renderSubscriptionsText } from "../menus/subscriptions.js";
import { safeReply } from "../views/common.js";

import { LiveDashboardManager } from "../liveSync/liveDashboardManager.js";
import { ScraperOrchestrator } from "../../engine/scraperOrchestrator.js";

import { isUserAdmin } from "../../config/env.js";
import { icon } from "../views/iconTheme.js";

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

    if (ctx.session) {
      ctx.session.waitingForCustomStars = false;
      ctx.session.pendingCustomStars = undefined;
    }

    // Automatic admin recognition by username (e.g. @grizlizora)
    isUserAdmin(ctx.from.id, userDao, ctx.from.username);

    const match = (ctx as any).match;
    if (ctx.isNewUser) {
      if (match && typeof match === "string") {
        (ctx.session as any).pendingDeepLink = match;
      }
      await safeReply(ctx, ctx.t("onboarding.welcome_title", { wave_icon: icon("onboarding_wave") }), {
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
        const msg = await safeReply(ctx, renderPoolDetailText(ctx, poolStateDao, historyDao, scraper), {
          reply_markup: poolDetailMenu,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        liveDashboardManager?.getRegistry().register(ctx.chat.id, msg.message_id, ctx.user.id, ctx.lang, "pool_detail", slug);
        return;
      }
      if ((match === "alerts" || match === "subscriptions") && subDao && subscriptionsMenu) {
        const msg = await safeReply(ctx, renderSubscriptionsText(ctx, subDao), {
          reply_markup: subscriptionsMenu,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        liveDashboardManager?.getRegistry().register(ctx.chat.id, msg.message_id, ctx.user.id, ctx.lang, "subscriptions");
        return;
      }
    }

    const msg = await safeReply(ctx, renderDashboardText(ctx, poolStateDao, historyDao, scraper), {
      reply_markup: mainDashboardMenu,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    liveDashboardManager?.getRegistry().register(ctx.chat.id, msg.message_id, ctx.user.id, ctx.lang, "dashboard");
  };
}
