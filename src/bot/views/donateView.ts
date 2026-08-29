import { BotContext } from "../../types/context.js";
import { icon } from "./iconTheme.js";
import { clampMessageText } from "./common.js";

export function renderDonateText(ctx: BotContext, userTotalStars = 0): string {
  const coffeeIcon = icon("coffee");
  const starIcon = icon("star");
  const diamondIcon = icon("rank_diamond");

  let statusBadge = "";
  if (userTotalStars > 0) {
    statusBadge =
      ctx.lang === "uk"
        ? `\n\n${diamondIcon} <b>Ваш статус:</b> <b>${userTotalStars} Stars задоначено</b> (Пріоритет активовано!)`
        : ctx.lang === "ru"
        ? `\n\n${diamondIcon} <b>Ваш статус:</b> <b>${userTotalStars} Stars пожертвовано</b> (Приоритет включен!)`
        : `\n\n${diamondIcon} <b>Your Status:</b> <b>${userTotalStars} Stars donated</b> (Priority active!)`;
  }

  if (ctx.lang === "uk") {
    return clampMessageText(
      `${coffeeIcon} <b>Підтримка проекту • Telegram Stars</b> ${starIcon}\n\n` +
      `${starIcon} <b>Пріоритет у черзі сповіщень:</b>\n` +
      `Користувачі, які підтримали проект, отримують сповіщення про відкриття рідкісних слотів <b>найпершими</b> (сортування за сумою донату).${statusBadge}\n\n` +
      `Оберіть суму підтримки:`
    );
  } else if (ctx.lang === "ru") {
    return clampMessageText(
      `${coffeeIcon} <b>Поддержка проекта • Telegram Stars</b> ${starIcon}\n\n` +
      `${starIcon} <b>Приоритет в очереди уведомлений:</b>\n` +
      `Пользователи, поддержавшие проект, получают уведомления о свободных слотах <b>первыми</b> (сортировка по сумме доната).${statusBadge}\n\n` +
      `Выберите сумму поддержки:`
    );
  } else {
    return clampMessageText(
      `${coffeeIcon} <b>Project Gratitude • Telegram Stars</b> ${starIcon}\n\n` +
      `${starIcon} <b>Priority Notification Queue:</b>\n` +
      `Supporters receive slot drop alerts <b>first</b> (ordered by total Stars donated).${statusBadge}\n\n` +
      `Select your support amount:`
    );
  }
}
