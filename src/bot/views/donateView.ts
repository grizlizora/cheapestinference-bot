import { BotContext } from "../../types/context.js";
import { icon } from "./iconTheme.js";
import { clampMessageText } from "./common.js";

export function renderDonateText(ctx: BotContext, userTotalStars = 0): string {
  const coffeeIcon = icon("coffee");
  const starIcon = icon("star");
  const lightningIcon = icon("event_slot_drop");
  const diamondIcon = icon("rank_diamond");

  let statusBadge = "";
  if (userTotalStars > 0) {
    statusBadge = ctx.lang === "uk"
      ? `\n\n${diamondIcon} <b>Ваш статус:</b> ⭐️ <b>${userTotalStars} Stars задоначено</b> (Пріоритетна доставка сповіщень увімкнена!)`
      : ctx.lang === "ru"
      ? `\n\n${diamondIcon} <b>Ваш статус:</b> ⭐️ <b>${userTotalStars} Stars задоначено</b> (Приоритетная доставка уведомлений включена!)`
      : `\n\n${diamondIcon} <b>Your Status:</b> ⭐️ <b>${userTotalStars} Stars donated</b> (Priority alert delivery active!)`;
  }

  if (ctx.lang === "uk") {
    return clampMessageText(
      `${coffeeIcon} <b>Підтримка проекту CheapestInference</b> ${starIcon}\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Бот працює <b>24/7 безкоштовно</b>, перевіряючи наявність рідкісних обчислювальних слотів кожні 5 секунд через мережу захищених швидкісних проксі та Tor контурів.\n\n` +
      `${lightningIcon} <b>На що йдуть донати:</b>\n` +
      `• Оплата хостингу та високошвидкісних проксі каналів\n` +
      `• Сервери миттєвого скрапінгу з затримкою <150ms\n` +
      `• Розвиток нових функцій та аналітики\n\n` +
      `⭐️ <b>Пріоритет у черзі сповіщень:</b>\n` +
      `Користувачі, які підтримали проект, отримують сповіщення про вихід нових слотів <b>першими</b> (сортування від найбільшого донату)!${statusBadge}\n\n` +
      `Оберіть суму підтримки в <b>Telegram Stars (⭐)</b>:`
    );
  } else if (ctx.lang === "ru") {
    return clampMessageText(
      `${coffeeIcon} <b>Поддержка проекта CheapestInference</b> ${starIcon}\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Бот работает <b>24/7 бесплатно</b>, проверяя наличие редких вычислительных слотов каждые 5 секунд через сеть защищенных скоростных прокси и Tor контуров.\n\n` +
      `${lightningIcon} <b>На что идут донаты:</b>\n` +
      `• Оплата хостинга и высокоскоростных прокси каналов\n` +
      `• Серверы мгновенного скрапинга с задержкой <150ms\n` +
      `• Разработка новых функций и аналитики\n\n` +
      `⭐️ <b>Приоритет в очереди уведомлений:</b>\n` +
      `Пользователи, поддержавшие проект, получают уведомления о свободных слотах <b>первыми</b> (сортировка от наибольшего доната)!${statusBadge}\n\n` +
      `Выберите сумму поддержки в <b>Telegram Stars (⭐)</b>:`
    );
  } else {
    return clampMessageText(
      `${coffeeIcon} <b>Support CheapestInference Project</b> ${starIcon}\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `The bot operates <b>24/7 for free</b>, inspecting rare AI compute slot drops every 5 seconds via high-throughput proxy & Tor pipelines.\n\n` +
      `${lightningIcon} <b>What your donations support:</b>\n` +
      `• High-speed proxy pools & hosting infrastructure\n` +
      `• Sub-150ms micro-latency scrape engines\n` +
      `• Continuous development of analytics & features\n\n` +
      `⭐️ <b>Priority Notification Queue:</b>\n` +
      `Project supporters receive slot availability drop alerts <b>first</b> (ordered by total Stars donated)!${statusBadge}\n\n` +
      `Select your contribution in <b>Telegram Stars (⭐)</b>:`
    );
  }
}
