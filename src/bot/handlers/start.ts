import { BotContext } from "../../types/context.js";
import { UserDAO } from "../../db/dao/users.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { renderDashboardText } from "../menus/mainDashboard.js";

export function createStartHandler(
  userDao: UserDAO,
  poolStateDao: PoolStateDAO,
  languageMenu: any,
  mainDashboardMenu: any,
  historyDao?: SlotHistoryDAO
) {
  return async (ctx: BotContext) => {
    if (!ctx.from) return;

    if (ctx.isNewUser) {
      await ctx.reply(ctx.t("onboarding.welcome_title"), {
        reply_markup: languageMenu,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } else {
      await ctx.reply(renderDashboardText(ctx, poolStateDao, historyDao), {
        reply_markup: mainDashboardMenu,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    }
  };
}
