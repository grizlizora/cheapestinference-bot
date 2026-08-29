import { BotContext } from "../../types/context.js";
import { icon } from "./iconTheme.js";
import { clampMessageText } from "./common.js";
import { getUserRankMeta } from "./userRankHelper.js";

export function renderDonateText(ctx: BotContext, userTotalStars = 0): string {
  const coffeeIcon = icon("coffee");
  const starIcon = icon("star");
  const rocketIcon = icon("rocket");
  const shieldIcon = icon("rank_shield");

  const meta = getUserRankMeta(
    {
      isAdmin: ctx.user?.is_admin === 1,
      totalDonatedStars: userTotalStars,
      lastActiveAt: ctx.user ? Date.parse(ctx.user.last_active_at) || Date.now() : Date.now(),
    },
    ctx.lang
  );

  let statusCard = "";
  if (meta.isAdmin) {
    statusCard =
      ctx.lang === "uk"
        ? `\n\n${meta.iconHtml} <b>Ваш статус:</b> ${meta.rankTitle}\n• <b>Пріоритет:</b> ${meta.priorityTitle}\n• <b>Утримання:</b> ${meta.retentionText}`
        : ctx.lang === "ru"
        ? `\n\n${meta.iconHtml} <b>Ваш статус:</b> ${meta.rankTitle}\n• <b>Приоритет:</b> ${meta.priorityTitle}\n• <b>Удержание:</b> ${meta.retentionText}`
        : `\n\n${meta.iconHtml} <b>Your Status:</b> ${meta.rankTitle}\n• <b>Priority:</b> ${meta.priorityTitle}\n• <b>Retention:</b> ${meta.retentionText}`;
  } else if (userTotalStars > 0) {
    statusCard =
      ctx.lang === "uk"
        ? `\n\n${meta.iconHtml} <b>Ваш статус:</b> ${meta.rankTitle} (<b>${userTotalStars} ${starIcon}</b>)\n• <b>Пріоритет:</b> ${meta.priorityTitle}\n• <b>Утримання:</b> ${meta.retentionText}`
        : ctx.lang === "ru"
        ? `\n\n${meta.iconHtml} <b>Ваш статус:</b> ${meta.rankTitle} (<b>${userTotalStars} ${starIcon}</b>)\n• <b>Приоритет:</b> ${meta.priorityTitle}\n• <b>Удержание:</b> ${meta.retentionText}`
        : `\n\n${meta.iconHtml} <b>Your Status:</b> ${meta.rankTitle} (<b>${userTotalStars} ${starIcon}</b>)\n• <b>Priority:</b> ${meta.priorityTitle}\n• <b>Retention:</b> ${meta.retentionText}`;
  }

  if (ctx.lang === "uk") {
    return clampMessageText(
      `${coffeeIcon} <b>Підтримка проекту • Telegram Stars</b> ${starIcon}\n\n` +
      `${starIcon} <b>Переваги підтримки:</b>\n` +
      `• ${rocketIcon} <b>Пріоритетна черга (P1):</b> Сповіщення про гарячі слоти надсилаються вам у першій хвилі.\n` +
      `• ${shieldIcon} <b>Розширене утримання:</b> Кожна зірка додає дні активного моніторингу без необхідності щотижневих заходів у бот.${statusCard}\n\n` +
      `Оберіть суму підтримки:`
    );
  } else if (ctx.lang === "ru") {
    return clampMessageText(
      `${coffeeIcon} <b>Поддержка проекта • Telegram Stars</b> ${starIcon}\n\n` +
      `${starIcon} <b>Преимущества поддержки:</b>\n` +
      `• ${rocketIcon} <b>Приоритетная очередь (P1):</b> Уведомления о слотах отправляются вам в первой волне.\n` +
      `• ${shieldIcon} <b>Расширенное удержание:</b> Каждая звезда продлевает активный мониторинг без обязательных визитов.${statusCard}\n\n` +
      `Выберите сумму поддержки:`
    );
  } else {
    return clampMessageText(
      `${coffeeIcon} <b>Project Gratitude • Telegram Stars</b> ${starIcon}\n\n` +
      `${starIcon} <b>Supporter Perks:</b>\n` +
      `• ${rocketIcon} <b>Priority Queue (P1):</b> Drop alerts delivered to you in the very first dispatch wave.\n` +
      `• ${shieldIcon} <b>Extended Retention:</b> Every Star adds active monitoring days without 14-day inactivity limits.${statusCard}\n\n` +
      `Select your support amount:`
    );
  }
}
