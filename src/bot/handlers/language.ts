import { BotContext } from "../../types/context.js";

export function createLanguageHandler(languageMenu: any) {
  return async (ctx: BotContext) => {
    await ctx.reply(ctx.t("onboarding.welcome_title"), {
      reply_markup: languageMenu,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  };
}
