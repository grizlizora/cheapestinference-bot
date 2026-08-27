import { Menu } from "@grammyjs/menu";
import { BotContext } from "../../types/context.js";
import { UserDAO } from "../../db/dao/users.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { ScraperOrchestrator } from "../../engine/scraperOrchestrator.js";
import { ActiveDashboardRegistry } from "../liveSync/dashboardRegistry.js";
import { CodeIntegrityEngine, VerificationReport } from "../../engine/codeIntegrityEngine.js";
import { NodeActivationEngine } from "../../engine/nodeActivationEngine.js";
import { getLanguageFlag, escapeHtml } from "../../i18n/index.js";
import { safeEditMessageText, renderDashboardText } from "./mainDashboard.js";

export function createSettingsMenu(
  userDao: UserDAO,
  subDao: SubscriptionDAO,
  poolStateDao: PoolStateDAO,
  historyDao?: SlotHistoryDAO,
  scraper?: ScraperOrchestrator,
  dashboardRegistry?: ActiveDashboardRegistry,
  integrityEngine?: CodeIntegrityEngine,
  nodeActivationEngine?: NodeActivationEngine
) {
  const engine = integrityEngine || new CodeIntegrityEngine();
  const nodeEngine = nodeActivationEngine || new NodeActivationEngine();

  // 1. Help & Author Contact Submenu
  const helpMenu = new Menu<BotContext>("help-menu")
    .url(
      (ctx) => ctx.t("common.btn_contact_author"),
      "https://t.me/grizlizora"
    )
    .row()
    .text(
      (ctx) => ctx.t("common.back_to_settings"),
      async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        if (ctx.chat) {
          dashboardRegistry?.updateView(ctx.chat.id, "other");
        }
        await safeEditMessageText(ctx, renderSettingsText(ctx));
        return ctx.menu.nav("settings-menu");
      }
    );

  // 2. Cryptographic Code Integrity Submenu
  const integrityMenu = new Menu<BotContext>("integrity-menu")
    .dynamic(async (ctx, range) => {
      range
        .url(
          (c) => c.t("integrity.btn_open_verifier"),
          `https://grizlizora.github.io/cheapestinference-bot/`
        )
        .row()
        .url(
          (c) => c.t("integrity.btn_open_github"),
          "https://github.com/grizlizora/cheapestinference-bot"
        )
        .row()
        .text(
          (c) => c.t("integrity.btn_reverify"),
          async (c) => {
            await c.answerCallbackQuery({
              text: c.t("integrity.toast_scanning"),
              show_alert: false,
            }).catch(() => {});

            const report = await engine.verifyIntegrity(c.from?.id);
            await safeEditMessageText(c, renderIntegrityText(c, report, nodeEngine));
            try {
              c.menu.update();
            } catch {}
          }
        )
        .row()
        .text(
          (c) => c.t("common.back_to_settings"),
          async (c) => {
            await c.answerCallbackQuery().catch(() => {});
            if (c.chat) {
              dashboardRegistry?.updateView(c.chat.id, "other");
            }
            await safeEditMessageText(c, renderSettingsText(c));
            return c.menu.nav("settings-menu");
          }
        );
    });

  // 3. Settings Main Menu Hub
  const settingsMenu = new Menu<BotContext>("settings-menu")
    .text(
      (ctx) => ctx.t("settings.btn_language"),
      async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        if (ctx.chat) {
          dashboardRegistry?.updateView(ctx.chat.id, "other");
        }
        await safeEditMessageText(ctx, ctx.t("onboarding.change_language_prompt"));
        return ctx.menu.nav("language-menu");
      }
    )
    .row()
    .text(
      (ctx) => ctx.t("settings.btn_help"),
      async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        if (ctx.chat) {
          dashboardRegistry?.updateView(ctx.chat.id, "other");
        }
        await safeEditMessageText(ctx, ctx.t("help_text", { telegram_id: String(ctx.from?.id || "N/A") }));
        return ctx.menu.nav("help-menu");
      }
    )
    .row()
    .text(
      (ctx) => ctx.t("settings.btn_integrity"),
      async (ctx) => {
        await ctx.answerCallbackQuery({
          text: ctx.t("integrity.toast_running_audit"),
          show_alert: false,
        }).catch(() => {});
        if (ctx.chat) {
          dashboardRegistry?.updateView(ctx.chat.id, "other");
        }
        const report = await engine.verifyIntegrity(ctx.from?.id);
        await safeEditMessageText(ctx, renderIntegrityText(ctx, report, nodeEngine));
        return ctx.menu.nav("integrity-menu");
      }
    )
    .row()
    .text(
      (ctx) => ctx.t("common.back_to_dashboard"),
      async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        if (ctx.chat) {
          dashboardRegistry?.updateView(ctx.chat.id, "dashboard");
        }
        await safeEditMessageText(ctx, renderDashboardText(ctx, poolStateDao, historyDao, scraper));
        return ctx.menu.nav("main-dashboard-menu");
      }
    );

  return { settingsMenu, helpMenu, integrityMenu };
}

export function renderSettingsText(ctx: BotContext): string {
  const usernameStr = ctx.from?.username ? `@${escapeHtml(ctx.from.username)}` : "—";

  return ctx.t("settings.title", {
    telegram_id: String(ctx.from?.id || "N/A"),
    username: usernameStr,
    language: getLanguageFlag(ctx.lang),
  });
}

export function renderIntegrityText(
  ctx: BotContext,
  report: VerificationReport,
  nodeEngine: NodeActivationEngine
): string {
  const attestation = nodeEngine.getAttestation();

  if (report.isAuthentic) {
    return ctx.t("integrity.success_text", {
      commit_sha: report.commitShortSha,
      commit_author: escapeHtml(report.commitAuthor),
      commit_msg: escapeHtml(report.commitMessage),
      total_files: String(report.totalMonitoredFiles),
      challenge_code: report.challengeCode,
      proof_hash: report.proofHash,
      node_id: attestation.nodeId,
      time_ms: String(report.executionTimeMs),
      verifier_url: report.githubPagesVerifierUrl,
    });
  } else {
    let diffsSummary = "";
    const modified = report.diffs.filter((d) => d.status === "modified");
    const added = report.diffs.filter((d) => d.status === "added");
    const deleted = report.diffs.filter((d) => d.status === "deleted");

    if (modified.length > 0) {
      diffsSummary += `${ctx.t("integrity.diff_modified", { count: modified.length })}\n` +
        modified.slice(0, 5).map((m) => `• <code>${escapeHtml(m.path)}</code>`).join("\n");
    }
    if (added.length > 0) {
      diffsSummary += `${ctx.t("integrity.diff_added", { count: added.length })}\n` +
        added.slice(0, 5).map((a) => `• <code>${escapeHtml(a.path)}</code>`).join("\n");
    }
    if (deleted.length > 0) {
      diffsSummary += `${ctx.t("integrity.diff_deleted", { count: deleted.length })}\n` +
        deleted.slice(0, 5).map((d) => `• <code>${escapeHtml(d.path)}</code>`).join("\n");
    }

    return ctx.t("integrity.mismatch_text", {
      commit_sha: report.commitShortSha,
      identical_count: String(report.identicalCount),
      total_files: String(report.totalMonitoredFiles),
      diffs_summary: diffsSummary,
      challenge_code: report.challengeCode,
      proof_hash: report.proofHash,
      node_id: attestation.nodeId,
    });
  }
}
