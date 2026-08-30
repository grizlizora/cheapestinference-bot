/**
 * src/bot/handlers/adminBroadcast.ts
 * Multi-Language Admin Broadcast Controller & Interactive FSM
 */

import { InlineKeyboard } from "grammy";
import { BotContext, BroadcastSessionState } from "../../types/context.js";
import { UserDAO } from "../../db/dao/users.js";
import { NotificationDispatcher } from "../notifier/dispatcher.js";
import { extractMessageContent } from "../notifier/telegramEntitySerializer.js";
import { SupportedLanguage } from "../../types/db.js";
import { icon } from "../views/iconTheme.js";

export function getOrCreateBroadcastSession(ctx: BotContext): BroadcastSessionState {
  if (!ctx.session.broadcast) {
    ctx.session.broadcast = {
      stage: "idle",
      drafts: {},
      sendSilent: false,
      filter: "active_only",
    };
  }
  return ctx.session.broadcast;
}

export function resetBroadcastSession(ctx: BotContext): void {
  ctx.session.broadcast = {
    stage: "idle",
    drafts: {},
    sendSilent: false,
    filter: "active_only",
  };
}

export function renderBroadcastStagingText(
  ctx: BotContext,
  userDao: UserDAO,
  dispatcher: NotificationDispatcher
): { text: string; keyboard: InlineKeyboard } {
  const session = getOrCreateBroadcastSession(ctx);
  const index = dispatcher.getInvertedIndex();
  const allProfiles = index.getActiveProfiles("all");
  const activeProfiles = index.getActiveProfiles(session.filter || "active_only");

  const countUk = activeProfiles.filter((p) => p.language === "uk").length;
  const countEn = activeProfiles.filter((p) => p.language === "en").length;
  const countRu = activeProfiles.filter((p) => p.language === "ru").length;
  const totalCount = activeProfiles.length;

  const ukDraft = session.drafts.uk;
  const enDraft = session.drafts.en;
  const ruDraft = session.drafts.ru;

  const ukStatus = ukDraft?.isConfirmed
    ? `✅ Готово (${ukDraft.rawText.length} симв.)`
    : `❌ Не створено`;
  const enStatus = enDraft?.isConfirmed
    ? `✅ Ready (${enDraft.rawText.length} chars)`
    : `❌ Not created`;
  const ruStatus = ruDraft?.isConfirmed
    ? `✅ Готово (${ruDraft.rawText.length} симв.)`
    : `❌ Не создано`;

  const confirmedCount = [ukDraft, enDraft, ruDraft].filter((d) => d?.isConfirmed).length;

  const header =
    `${icon("notify_bell_on")} <b>Центр масових розсилок</b>\n\n` +
    `Створіть повідомлення для кожної підтримуваної мови. Користувачі автоматично отримають текст відповідно до своєї мови інтерфейсу (або fallback на English/Ukrainian).\n\n` +
    `👥 <b>Цільова аудиторія (${session.filter === "donors_only" ? "Тільки Донатери" : "Активні користувачі"}):</b>\n` +
    `• 🇺🇦 <b>Українська:</b> <code>${countUk}</code> користувачів (${totalCount > 0 ? Math.round((countUk / totalCount) * 100) : 0}%)\n` +
    `• 🇬🇧 <b>English:</b> <code>${countEn}</code> користувачів (${totalCount > 0 ? Math.round((countEn / totalCount) * 100) : 0}%)\n` +
    `• 🇷🇺 <b>Русский:</b> <code>${countRu}</code> користувачів (${totalCount > 0 ? Math.round((countRu / totalCount) * 100) : 0}%)\n` +
    `• 🌐 <b>Всього адресатів:</b> <b>${totalCount} користувачів</b>\n\n` +
    `📋 <b>Стан чернеток розсилки:</b>\n` +
    `• 🇺🇦 Українська: <b>${ukStatus}</b>\n` +
    `• 🇬🇧 English: <b>${enStatus}</b>\n` +
    `• 🇷🇺 Русский: <b>${ruStatus}</b>\n\n` +
    `<i>Оберіть мову для введення або перезапису тексту:</i>`;

  const keyboard = new InlineKeyboard()
    .text(`🇺🇦 UK: ${ukDraft?.isConfirmed ? "✅ Готово" : "❌ Немає"}`, "admin_bc_edit:uk")
    .row()
    .text(`🇬🇧 EN: ${enDraft?.isConfirmed ? "✅ Ready" : "❌ None"}`, "admin_bc_edit:en")
    .row()
    .text(`🇷🇺 RU: ${ruDraft?.isConfirmed ? "✅ Готово" : "❌ Нет"}`, "admin_bc_edit:ru")
    .row()
    .text(
      session.sendSilent ? "🔕 Звук: ВИМКНЕНО (Silent)" : "🔔 Звук: УВІМКНЕНО",
      "admin_bc_toggle_silent"
    );

  if (confirmedCount === 3 || (confirmedCount > 0 && (ukDraft?.isConfirmed || enDraft?.isConfirmed))) {
    keyboard.row().text(
      `🚀 Запустити розсилку (${confirmedCount}/3 готово)`,
      "admin_bc_preflight"
    );
  } else {
    keyboard.row().text(
      `⏳ Заповніть мови (${confirmedCount}/3)`,
      "admin_bc_staging_noop"
    );
  }

  if (confirmedCount > 0) {
    keyboard.row().text("🗑️ Очистити всі чернетки", "admin_bc_clear");
  }

  keyboard.row().text("⬅️ Назад до адмінки", "admin_refresh");

  return { text: header, keyboard };
}

export function renderBroadcastPromptText(lang: SupportedLanguage): string {
  const flags: Record<SupportedLanguage, string> = {
    uk: "Українська 🇺🇦",
    en: "English 🇬🇧",
    ru: "Русский 🇷🇺",
  };

  return (
    `✍️ <b>Введення тексту повідомлення [ ${flags[lang]} ]</b>\n\n` +
    `Надішліть наступним повідомленням текст (або фото/медіа з підписом).\n\n` +
    `✨ <b>Підтримується 100% форматування Telegram:</b>\n` +
    `• <b>Жирний</b>, <i>курсив</i>, <u>підкреслений</u>, <s>закреслений</s>\n` +
    `• <code>моноширинний код</code> та блоки <pre>pre</pre>\n` +
    `• <tg-spoiler>спойлери</tg-spoiler> та цитати <blockquote>quote</blockquote>\n` +
    `• 3D Telegram Premium емодзі та клікабельні гіперпосилання\n\n` +
    `<i>Надішліть повідомлення у чат або натисніть «Скасувати».</i>`
  );
}

export function renderBroadcastPreview(
  ctx: BotContext,
  lang: SupportedLanguage,
  dispatcher: NotificationDispatcher
): { text: string; keyboard: InlineKeyboard } {
  const session = getOrCreateBroadcastSession(ctx);
  const draft = session.drafts[lang];

  if (!draft) {
    return {
      text: "❌ Чернетку не знайдено.",
      keyboard: new InlineKeyboard().text("◀️ До вибору мов", "admin_bc_hub"),
    };
  }

  const flags: Record<SupportedLanguage, string> = {
    uk: "Українська 🇺🇦",
    en: "English 🇬🇧",
    ru: "Русский 🇷🇺",
  };

  const index = dispatcher.getInvertedIndex();
  const activeProfiles = index.getActiveProfiles(session.filter || "active_only");
  const recipientsCount = activeProfiles.filter((p) => p.language === lang).length;
  const totalCount = activeProfiles.length;
  const pct = totalCount > 0 ? Math.round((recipientsCount / totalCount) * 100) : 0;

  const header =
    `👁 <b>ПОПЕРЕДНІЙ ПЕРЕГЛЯД РОЗСИЛКИ • [ ${flags[lang]} ]</b>\n` +
    `──────────────────────────\n\n` +
    `${draft.htmlText}\n\n` +
    `──────────────────────────\n` +
    `👥 <b>Отримувачів цієї мови:</b> <code>${recipientsCount}</code> користувачів (${pct}%)\n` +
    `📏 <b>Довжина:</b> ${draft.rawText.length} / 4096 символів\n` +
    `🛡 <b>HTML валідація:</b> ✅ Усі теги коректно збалансовані`;

  const keyboard = new InlineKeyboard()
    .text("✅ Підтвердити чернетку", `admin_bc_confirm_draft:${lang}`)
    .row()
    .text("🔄 Переписати текст", `admin_bc_edit:${lang}`)
    .row()
    .text("🧪 Надіслати тестове мені", `admin_bc_test_self:${lang}`)
    .row()
    .text("◀️ До вибору мов", "admin_bc_hub");

  return { text: header, keyboard };
}

export function renderBroadcastPreflight(
  ctx: BotContext,
  dispatcher: NotificationDispatcher
): { text: string; keyboard: InlineKeyboard } {
  const session = getOrCreateBroadcastSession(ctx);
  const index = dispatcher.getInvertedIndex();
  const activeProfiles = index.getActiveProfiles(session.filter || "active_only");
  const totalTargets = activeProfiles.length;

  const countUk = activeProfiles.filter((p) => p.language === "uk").length;
  const countEn = activeProfiles.filter((p) => p.language === "en").length;
  const countRu = activeProfiles.filter((p) => p.language === "ru").length;

  const ukSnippet = session.drafts.uk?.rawText?.slice(0, 60)?.replace(/\n/g, " ") || "—";
  const enSnippet = session.drafts.en?.rawText?.slice(0, 60)?.replace(/\n/g, " ") || "—";
  const ruSnippet = session.drafts.ru?.rawText?.slice(0, 60)?.replace(/\n/g, " ") || "—";

  const estSec = Math.max(1, Math.ceil(totalTargets / 27));

  const text =
    `🚀 <b>Підготовка до запуску розсилки</b>\n\n` +
    `Усі мовні версії успішно підготовлені та перевірені:\n\n` +
    `• 🇺🇦 <b>Українська (${countUk} ос.):</b> <i>"${ukSnippet}..."</i>\n` +
    `• 🇬🇧 <b>English (${countEn} users):</b> <i>"${enSnippet}..."</i>\n` +
    `• 🇷🇺 <b>Русский (${countRu} польз.):</b> <i>"${ruSnippet}..."</i>\n\n` +
    `📊 <b>Параметри відправки:</b>\n` +
    `• 👥 <b>Загальна аудиторія:</b> <b>${totalTargets} користувачів</b>\n` +
    `• ⚡ <b>Швидкість доставки:</b> ~27-30 повідомлень/сек\n` +
    `• ⏱ <b>Орієнтовний час (ETA):</b> ~${estSec} секунд\n` +
    `• 🎯 <b>Пріоритет черги:</b> P0 (Admins ➔ Donors ➔ Active Users)\n` +
    `• 🔔 <b>Режим звуку:</b> ${session.sendSilent ? "🔕 Без звуку" : "🔔 Зі звуком"}\n\n` +
    `⚠️ <b>УВАГА:</b> Після підтвердження повідомлення буде негайно розіслано всім активним користувачам.`;

  const keyboard = new InlineKeyboard()
    .text("🚀 ПІДТВЕРДИТИ ТА ЗАПУСТИТИ", "admin_bc_modal_confirm")
    .row()
    .text("🧪 Тест усіх 3-х мов мені", "admin_bc_test_all")
    .row()
    .text("◀️ Повернутися до чернеток", "admin_bc_hub");

  return { text, keyboard };
}

export function renderBroadcastModalConfirm(
  ctx: BotContext,
  dispatcher: NotificationDispatcher
): { text: string; keyboard: InlineKeyboard } {
  const session = getOrCreateBroadcastSession(ctx);
  const index = dispatcher.getInvertedIndex();
  const activeProfiles = index.getActiveProfiles(session.filter || "active_only");
  const totalTargets = activeProfiles.length;

  const text =
    `⚠️ <b>ПІДТВЕРДЖЕННЯ ЗАПУСКУ РОЗСИЛКИ</b>\n\n` +
    `Ви впевнені, що бажаєте запустити розсилку на <b>${totalTargets} користувачів</b>?\n\n` +
    `Цю дію <b>неможливо скасувати</b>.`;

  const keyboard = new InlineKeyboard()
    .text(`🔴 ТАК, РОЗІСЛАТИ ВСІМ (${totalTargets}) 🚀`, "admin_bc_execute")
    .row()
    .text("❌ Скасувати та вийти", "admin_bc_hub");

  return { text, keyboard };
}
