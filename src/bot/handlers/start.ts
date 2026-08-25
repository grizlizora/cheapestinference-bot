import { BotContext } from "../../types/context.js";
import { UserDAO } from "../../db/dao/users.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { renderDashboardText } from "../menus/mainDashboard.js";
import { renderPoolDetailText } from "../menus/poolDetail.js";
import { renderSubscriptionsText } from "../menus/subscriptions.js";

export function createStartHandler(
  userDao: UserDAO,
  poolStateDao: PoolStateDAO,
  languageMenu: any,
  mainDashboardMenu: any,
  historyDao?: SlotHistoryDAO,
  subDao?: SubscriptionDAO,
  subscriptionsMenu?: any,
  poolDetailMenu?: any
) {
  return async (ctx: BotContext) => {
    if (!ctx.from) return;

    if (ctx.isNewUser) {
      await ctx.reply(ctx.t("onboarding.welcome_title"), {
        reply_markup: languageMenu,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      return;
    }

    const match = (ctx as any).match;
    if (match && typeof match === "string") {
      if (match.startsWith("pool_") && poolDetailMenu) {
        const slug = match.replace("pool_", "");
        ctx.session.tempPoolSlug = slug;
        await ctx.reply(renderPoolDetailText(ctx, poolStateDao, historyDao), {
          reply_markup: poolDetailMenu,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        return;
      }
      if ((match === "alerts" || match === "subscriptions") && subDao && subscriptionsMenu) {
        await ctx.reply(renderSubscriptionsText(ctx, subDao), {
          reply_markup: subscriptionsMenu,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        return;
      }
    }

    await ctx.reply(renderDashboardText(ctx, poolStateDao, historyDao), {
      reply_markup: mainDashboardMenu,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  };
}
