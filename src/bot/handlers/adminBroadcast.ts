/**
 * src/bot/handlers/adminBroadcast.ts
 * Multi-Language Admin Broadcast Controller & Interactive FSM
 */

import { InlineKeyboard } from "grammy";
import { BotContext, BroadcastSessionState } from "../../types/context.js";
import { UserDAO } from "../../db/dao/users.js";
import { NotificationDispatcher } from "../notifier/dispatcher.js";
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
  const activeProfiles = index.getActiveProfiles(session.filter || "active_only");

  const countUk = activeProfiles.filter((p) => p.language === "uk").length;
  const countEn = activeProfiles.filter((p) => p.language === "en").length;
  const countRu = activeProfiles.filter((p) => p.language === "ru").length;
  const totalCount = activeProfiles.length;

  const ukDraft = session.drafts.uk;
  const enDraft = session.drafts.en;
  const ruDraft = session.drafts.ru;

  const ukStatus = ukDraft?.isConfirmed
    ? ctx.t("admin.broadcast.status_ready", { chars: String(ukDraft.rawText.length) })
    : ctx.t("admin.broadcast.status_not_created");
  const enStatus = enDraft?.isConfirmed
    ? ctx.t("admin.broadcast.status_ready", { chars: String(enDraft.rawText.length) })
    : ctx.t("admin.broadcast.status_not_created");
  const ruStatus = ruDraft?.isConfirmed
    ? ctx.t("admin.broadcast.status_ready", { chars: String(ruDraft.rawText.length) })
    : ctx.t("admin.broadcast.status_not_created");

  const confirmedCount = [ukDraft, enDraft, ruDraft].filter((d) => d?.isConfirmed).length;
  const filterName =
    session.filter === "donors_only"
      ? ctx.t("admin.broadcast.filter_donors")
      : ctx.t("admin.broadcast.filter_active");

  const pctUk = totalCount > 0 ? Math.round((countUk / totalCount) * 100) : 0;
  const pctEn = totalCount > 0 ? Math.round((countEn / totalCount) * 100) : 0;
  const pctRu = totalCount > 0 ? Math.round((countRu / totalCount) * 100) : 0;

  const header =
    `${icon("notify_bell_on")} <b>${ctx.t("admin.broadcast.hub_title")}</b>\n\n` +
    `${ctx.t("admin.broadcast.hub_desc")}\n\n` +
    `${ctx.t("admin.broadcast.target_audience", { filter: filterName })}\n` +
    `${ctx.t("admin.broadcast.users_count_uk", { count: String(countUk), pct: String(pctUk) })}\n` +
    `${ctx.t("admin.broadcast.users_count_en", { count: String(countEn), pct: String(pctEn) })}\n` +
    `${ctx.t("admin.broadcast.users_count_ru", { count: String(countRu), pct: String(pctRu) })}\n` +
    `${ctx.t("admin.broadcast.users_total", { total: String(totalCount) })}\n\n` +
    `${ctx.t("admin.broadcast.drafts_status_header")}\n` +
    `${ctx.t("admin.broadcast.draft_status_uk", { status: ukStatus })}\n` +
    `${ctx.t("admin.broadcast.draft_status_en", { status: enStatus })}\n` +
    `${ctx.t("admin.broadcast.draft_status_ru", { status: ruStatus })}\n\n` +
    `${ctx.t("admin.broadcast.select_lang_prompt")}`;

  const ukBtnStatus = ukDraft?.isConfirmed
    ? ctx.t("admin.broadcast.btn_draft_ready")
    : ctx.t("admin.broadcast.btn_draft_none");
  const enBtnStatus = enDraft?.isConfirmed
    ? ctx.t("admin.broadcast.btn_draft_ready")
    : ctx.t("admin.broadcast.btn_draft_none");
  const ruBtnStatus = ruDraft?.isConfirmed
    ? ctx.t("admin.broadcast.btn_draft_ready")
    : ctx.t("admin.broadcast.btn_draft_none");

  const soundBtnLabel = session.sendSilent
    ? ctx.t("admin.broadcast.btn_sound_muted")
    : ctx.t("admin.broadcast.btn_sound_enabled");

  const keyboard = new InlineKeyboard()
    .text(`🇺🇦 UK: ${ukBtnStatus}`, "admin_bc_edit:uk")
    .row()
    .text(`🇬🇧 EN: ${enBtnStatus}`, "admin_bc_edit:en")
    .row()
    .text(`🇷🇺 RU: ${ruBtnStatus}`, "admin_bc_edit:ru")
    .row()
    .text(soundBtnLabel, "admin_bc_toggle_silent");

  if (confirmedCount === 3 || (confirmedCount > 0 && (ukDraft?.isConfirmed || enDraft?.isConfirmed))) {
    keyboard.row().text(
      ctx.t("admin.broadcast.btn_launch_ready", { count: String(confirmedCount) }),
      "admin_bc_preflight"
    );
  } else {
    keyboard.row().text(
      ctx.t("admin.broadcast.btn_launch_incomplete", { count: String(confirmedCount) }),
      "admin_bc_staging_noop"
    );
  }

  if (confirmedCount > 0) {
    keyboard.row().text(ctx.t("admin.broadcast.btn_clear_drafts"), "admin_bc_clear");
  }

  keyboard.row().text(ctx.t("admin.broadcast.btn_back_admin"), "admin_refresh");

  return { text: header, keyboard };
}

export function renderBroadcastPromptText(targetLang: SupportedLanguage, ctx: BotContext): string {
  const flags: Record<SupportedLanguage, string> = {
    uk: "Українська 🇺🇦",
    en: "English 🇬🇧",
    ru: "Русский 🇷🇺",
  };

  return (
    `${ctx.t("admin.broadcast.prompt_title", { target_flag: flags[targetLang] })}\n\n` +
    `${ctx.t("admin.broadcast.prompt_desc")}`
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
      text: ctx.t("admin.broadcast.preview_not_found"),
      keyboard: new InlineKeyboard().text(ctx.t("admin.broadcast.btn_back_languages"), "admin_bc_hub"),
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
    `${ctx.t("admin.broadcast.preview_header", { target_flag: flags[lang] })}\n` +
    `──────────────────────────\n\n` +
    `${draft.htmlText}\n\n` +
    `──────────────────────────\n` +
    `${ctx.t("admin.broadcast.preview_recipients", { count: String(recipientsCount), pct: String(pct) })}\n` +
    `${ctx.t("admin.broadcast.preview_length", { len: String(draft.rawText.length) })}\n` +
    `${ctx.t("admin.broadcast.preview_html_valid")}`;

  const keyboard = new InlineKeyboard()
    .text(ctx.t("admin.broadcast.btn_confirm_draft"), `admin_bc_confirm_draft:${lang}`)
    .row()
    .text(ctx.t("admin.broadcast.btn_rewrite_text"), `admin_bc_edit:${lang}`)
    .row()
    .text(ctx.t("admin.broadcast.btn_test_self"), `admin_bc_test_self:${lang}`)
    .row()
    .text(ctx.t("admin.broadcast.btn_back_languages"), "admin_bc_hub");

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
  const soundModeStr = session.sendSilent
    ? ctx.t("admin.broadcast.sound_silent")
    : ctx.t("admin.broadcast.sound_with_sound");

  const text =
    `${ctx.t("admin.broadcast.preflight_title")}\n\n` +
    `${ctx.t("admin.broadcast.preflight_subtitle")}\n\n` +
    `${ctx.t("admin.broadcast.preflight_item_uk", { count: String(countUk), snippet: ukSnippet })}\n` +
    `${ctx.t("admin.broadcast.preflight_item_en", { count: String(countEn), snippet: enSnippet })}\n` +
    `${ctx.t("admin.broadcast.preflight_item_ru", { count: String(countRu), snippet: ruSnippet })}\n\n` +
    `${ctx.t("admin.broadcast.preflight_params_header")}\n` +
    `${ctx.t("admin.broadcast.preflight_total_audience", { total: String(totalTargets) })}\n` +
    `${ctx.t("admin.broadcast.preflight_speed")}\n` +
    `${ctx.t("admin.broadcast.preflight_eta", { sec: String(estSec) })}\n` +
    `${ctx.t("admin.broadcast.preflight_priority")}\n` +
    `${ctx.t("admin.broadcast.preflight_sound", { sound_mode: soundModeStr })}\n\n` +
    `${ctx.t("admin.broadcast.preflight_warning")}`;

  const keyboard = new InlineKeyboard()
    .text(ctx.t("admin.broadcast.btn_preflight_confirm"), "admin_bc_modal_confirm")
    .row()
    .text(ctx.t("admin.broadcast.btn_preflight_test_all"), "admin_bc_test_all")
    .row()
    .text(ctx.t("admin.broadcast.btn_preflight_back"), "admin_bc_hub");

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
    `${ctx.t("admin.broadcast.modal_title")}\n\n` +
    `${ctx.t("admin.broadcast.modal_body", { total: String(totalTargets) })}`;

  const keyboard = new InlineKeyboard()
    .text(ctx.t("admin.broadcast.btn_modal_confirm", { total: String(totalTargets) }), "admin_bc_execute")
    .row()
    .text(ctx.t("admin.broadcast.btn_modal_cancel"), "admin_bc_hub");

  return { text, keyboard };
}
