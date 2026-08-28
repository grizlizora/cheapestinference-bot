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
        ? `\n\n${diamondIcon} <b>Ваш статус:</b> ⭐️ <b>${userTotalStars} Stars задоначено</b> (Пріоритетна доставка сповіщень увімкнена!)`
        : ctx.lang === "ru"
        ? `\n\n${diamondIcon} <b>Ваш статус:</b> ⭐️ <b>${userTotalStars} Stars задоначено</b> (Приоритетная доставка уведомлений включена!)`
        : `\n\n${diamondIcon} <b>Your Status:</b> ⭐️ <b>${userTotalStars} Stars donated</b> (Priority alert delivery active!)`;
  }

  if (ctx.lang === "uk") {
    return clampMessageText(
      `${coffeeIcon} <b>Подяка автору • Підтримка проекту</b> ${starIcon}\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Цей бот створено з відкритим кодом як зручний і швидкий інструмент для моніторингу найдешевших AI-слотів 24/7.\n\n` +
      `Якщо бот допомагає вам вчасно зловити потрібний слот або ви просто хочете висловити подяку автору за розробку — ви можете надіслати символічний донат у <b>Telegram Stars (⭐)</b> чи пригостити кавою! ☕\n\n` +
      `⭐️ <b>Пріоритет у сповіщеннях:</b>\n` +
      `Користувачі, які підтримали проект, отримують сповіщення про вихід рідкісних слотів <b>найпершими</b> (сортування від найбільшого донату)!${statusBadge}\n\n` +
      `Оберіть суму подяки в <b>Telegram Stars (⭐)</b>:`
    );
  } else if (ctx.lang === "ru") {
    return clampMessageText(
      `${coffeeIcon} <b>Благодарность автору • Поддержка проекта</b> ${starIcon}\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Этот бот создан с открытым исходным кодом как удобный и быстрый инструмент для мониторинга самых дешевых AI-слотов 24/7.\n\n` +
      `Если бот помогает вам вовремя поймать нужный слот или вы просто хотите сказать спасибо автору за разработку — вы можете отправить символический донат в <b>Telegram Stars (⭐)</b> или угостить кофе! ☕\n\n` +
      `⭐️ <b>Приоритет в уведомлениях:</b>\n` +
      `Пользователи, поддержавшие проект, получают уведомления о свободных слотах <b>первыми</b> (сортировка от наибольшего доната)!${statusBadge}\n\n` +
      `Выберите сумму благодарности в <b>Telegram Stars (⭐)</b>:`
    );
  } else {
    return clampMessageText(
      `${coffeeIcon} <b>Support the Author • Project Gratitude</b> ${starIcon}\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `This bot is open-source, crafted to provide effortless 24/7 real-time monitoring of AI compute slots.\n\n` +
      `If this bot has helped you claim rare slots or you'd like to show appreciation to the developer, you can leave a friendly tip via <b>Telegram Stars (⭐)</b> or buy a coffee! ☕\n\n` +
      `⭐️ <b>Priority Notification Queue:</b>\n` +
      `Project supporters receive slot availability drop alerts <b>first</b> (ordered by total Stars donated)!${statusBadge}\n\n` +
      `Select your tip in <b>Telegram Stars (⭐)</b>:`
    );
  }
}
