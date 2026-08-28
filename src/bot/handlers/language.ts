import { BotContext } from "../../types/context.js";
import { renderChangeLanguageText } from "../views/dashboardView.js";

export function createLanguageHandler(languageMenu: any) {
  return async (ctx: BotContext) => {
    await ctx.reply(renderChangeLanguageText(ctx), {
      reply_markup: languageMenu,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  };
}
