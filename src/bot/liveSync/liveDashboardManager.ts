/**
 * src/bot/liveSync/liveDashboardManager.ts
 * Real-time In-Place Message LiveSync Manager with Multi-Tier Heartbeat Routing
 */

import { Bot } from "grammy";
import { Menu } from "@grammyjs/menu";
import { BotContext } from "../../types/context.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { ScraperOrchestrator } from "../../engine/scraperOrchestrator.js";
import { ActiveDashboardRegistry, ActiveDashboardEntry, fnv1a32 } from "./dashboardRegistry.js";
import { renderDashboardText } from "../views/dashboardView.js";
import { renderPoolDetailText } from "../views/poolDetailView.js";
import { stripTgEmoji } from "../views/common.js";
import { translate } from "../../i18n/index.js";

export interface LiveDashboardManagerOptions {
  maxEditsPerSecond?: number; // Token bucket dispatch capacity (default 20/s)
  registry?: ActiveDashboardRegistry;
}

export class LiveDashboardManager {
  private registry: ActiveDashboardRegistry;
  private isDispatching = false;
  private isPaused = false;
  private pauseUntil = 0;

  // Rate Limiting Token Bucket
  private readonly targetRatePerSec: number;
  private readonly tokenIntervalMs: number;
  private tokens = 20;
  private readonly maxTokens = 20;
  private lastTokenRefill = performance.now();

  private readonly USER_EDIT_GAP_MS = 1050; // 1.05s per-chat edit rate limit
  private lastChatEditTime = new Map<number, number>();

  // Queue of pending edits
  private updateQueue: ActiveDashboardEntry[] = [];
  private queuedChatIds = new Set<number>();

  constructor(
    private bot: Bot<BotContext>,
    private poolStateDao: PoolStateDAO,
    private subDao: SubscriptionDAO,
    private scraper: ScraperOrchestrator,
    private mainDashboardMenu: Menu<BotContext>,
    private poolDetailMenu: Menu<BotContext>,
    private historyDao?: SlotHistoryDAO,
    options: LiveDashboardManagerOptions = {}
  ) {
    this.registry = options.registry || new ActiveDashboardRegistry();
    this.targetRatePerSec = options.maxEditsPerSecond ?? 20;
    this.tokenIntervalMs = 1000 / this.targetRatePerSec;

    // Attach hooks to ScraperOrchestrator
    this.scraper.on("diff_events", () => this.handleDataChanged());
    this.scraper.on("heartbeat", (hb: any) => this.handleScraperHeartbeat(Boolean(hb?.modified)));

    // Unreferenced watchdog timer to self-heal any dropped event loops
    this.watchdogTimer = setInterval(() => {
      if (this.updateQueue.length > 0 && !this.isDispatching) {
        this.startDispatchWorker();
      }
    }, 5000);
    this.watchdogTimer.unref();
  }

  private watchdogTimer?: NodeJS.Timeout;

  public close(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
    }
  }

  public getRegistry(): ActiveDashboardRegistry {
    return this.registry;
  }

  /**
   * Fast Path: Invoked immediately when DiffEngine detects catalog or slot changes.
   * Updates all active and eco-tier dashboards in real-time (<1s).
   */
  public handleDataChanged(): void {
    const sessions = this.registry.getSessionsForDataChange();
    for (const session of sessions) {
      this.enqueueUpdate(session);
    }
  }

  /**
   * Invoked on routine heartbeat polls and scrape cycles.
   * Heartbeat routing: Tier 1 (Active <30m) every 10s; Tier 2 (Eco 30m-24h) every 60s.
   */
  public handleScraperHeartbeat(isModified: boolean): void {
    if (isModified) {
      this.handleDataChanged();
      return;
    }
    const sessions = this.registry.getSessionsForHeartbeat();
    for (const session of sessions) {
      this.enqueueUpdate(session);
    }
  }

  private enqueueUpdate(session: ActiveDashboardEntry): void {
    if (!this.queuedChatIds.has(session.chatId)) {
      this.queuedChatIds.add(session.chatId);
      this.updateQueue.push(session);
      this.startDispatchWorker();
    }
  }

  private startDispatchWorker(): void {
    if (this.isDispatching) return;
    this.isDispatching = true;

    const processTick = async () => {
      if (!this.isDispatching) return;
      try {
        const now = performance.now();

        // Check HTTP 429 backoff
        if (this.isPaused) {
          if (now < this.pauseUntil) {
            const waitMs = Math.max(10, Math.ceil(this.pauseUntil - now));
            setTimeout(processTick, waitMs);
            return;
          }
          this.isPaused = false;
        }

        // Refill tokens
        const elapsed = now - this.lastTokenRefill;
        if (elapsed >= this.tokenIntervalMs) {
          const newTokens = Math.floor(elapsed / this.tokenIntervalMs);
          this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
          this.lastTokenRefill += newTokens * this.tokenIntervalMs;
        }

        if (this.updateQueue.length === 0) {
          this.isDispatching = false;
          return;
        }

        if (this.tokens >= 1) {
          const session = this.updateQueue.shift();
          if (session) {
            this.queuedChatIds.delete(session.chatId);
            const chatLastSent = this.lastChatEditTime.get(session.chatId) || 0;
            if (Date.now() - chatLastSent < this.USER_EDIT_GAP_MS) {
              // Requeue at tail if chat rate limit hasn't passed
              if (!this.queuedChatIds.has(session.chatId)) {
                this.queuedChatIds.add(session.chatId);
                this.updateQueue.push(session);
              }
            } else {
              this.tokens -= 1;
              await this.executeEdit(session).catch((err) => {
                this.handleEditError(err, session);
              });
            }
          }
        }
      } catch (tickErr: any) {
        console.error("⚠️ [LiveDashboardManager] Unexpected tick error:", tickErr?.message || tickErr);
      } finally {
        if (this.isDispatching && this.updateQueue.length > 0) {
          setTimeout(processTick, Math.max(15, this.tokenIntervalMs));
        } else {
          this.isDispatching = false;
        }
      }
    };

    setImmediate(processTick);
  }

  private async executeEdit(session: ActiveDashboardEntry): Promise<void> {
    try {
      const syntheticCtx = this.createSyntheticContext(session);
      let text = "";
      let targetMenu: Menu<BotContext>;

      if (session.viewType === "dashboard") {
        text = renderDashboardText(syntheticCtx, this.poolStateDao, this.historyDao, this.scraper, session.lastUserInteractionAt);
        targetMenu = this.mainDashboardMenu;
      } else if (session.viewType === "pool_detail") {
        text = renderPoolDetailText(syntheticCtx, this.poolStateDao, this.historyDao, this.scraper, session.lastUserInteractionAt);
        targetMenu = this.poolDetailMenu;
      } else {
        return;
      }

      const textHash = fnv1a32(`${session.viewType}:${session.poolSlug || ""}:${text}`);

      // Skip API call if text and view state are unchanged
      if (textHash === session.lastRenderedTextHash) {
        return;
      }

      this.lastChatEditTime.set(session.chatId, Date.now());
      if (this.lastChatEditTime.size > 5000) {
        const cutoff = Date.now() - 10 * 60 * 1000;
        for (const [cId, t] of this.lastChatEditTime.entries()) {
          if (t < cutoff) this.lastChatEditTime.delete(cId);
        }
      }

      const payload: Record<string, any> = {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      };

      if (typeof (targetMenu as any).render === "function") {
        try {
          const renderedKeyboard = await (targetMenu as any).render(syntheticCtx);
          if (Array.isArray(renderedKeyboard)) {
            payload.reply_markup = { inline_keyboard: renderedKeyboard };
          }
        } catch (e: any) {
          console.warn(`⚠️ [LiveSync] targetMenu.render fallback: ${e.message}`);
        }
      }

      if (!payload.reply_markup && typeof (targetMenu as any).prepare === "function") {
        payload.reply_markup = targetMenu;
        await (targetMenu as any).prepare(payload, syntheticCtx);
      }

      const editStartTime = Date.now();
      try {
        await this.bot.api.editMessageText(session.chatId, session.messageId, text, payload as any);
      } catch (tgErr: any) {
        const desc = tgErr?.description || tgErr?.message || "";
        // 1. Emoji fallback if custom emoji tag was rejected
        if (desc.includes("DOCUMENT_INVALID") || desc.includes("CUSTOM_EMOJI_INVALID")) {
          const stripped = stripTgEmoji(text);
          await this.bot.api.editMessageText(session.chatId, session.messageId, stripped, payload as any);
        } else if (desc.includes("message is not modified")) {
          // 2. Normal response when message is already identical: record success & hash
          this.registry.recordEditSuccess(session.chatId, textHash);
          return;
        } else {
          throw tgErr;
        }
      }

      const tgEditLatency = Date.now() - editStartTime;
      this.registry.recordEditSuccess(session.chatId, textHash);
      console.log(`📡 [LiveSync] In-place updated view '${session.viewType}' for chat ${session.chatId} in ${tgEditLatency}ms (TG API)`);
    } catch (err: any) {
      this.handleEditError(err, session);
    }
  }

  private handleEditError(err: any, session: ActiveDashboardEntry): void {
    const errorCode = err?.error_code || err?.response?.error_code;
    const desc = err?.description || err?.message || "";

    // 1. Message not modified (normal Telegram response when text is identical)
    if (desc.includes("message is not modified")) {
      return;
    }

    console.warn(`⚠️ [LiveDashboard] Edit error for chat ${session.chatId}: ${desc}`);

    // 2. Message deleted or too old (>48h) or not found
    if (
      desc.includes("message to edit not found") ||
      desc.includes("message can't be edited") ||
      desc.includes("chat not found")
    ) {
      this.lastChatEditTime.delete(session.chatId);
      this.registry.remove(session.chatId);
      return;
    }

    // 3. User blocked bot
    if (errorCode === 403 || desc.includes("bot was blocked by the user")) {
      this.lastChatEditTime.delete(session.chatId);
      this.registry.remove(session.chatId);
      return;
    }

    // 4. Rate limit (HTTP 429)
    if (errorCode === 429) {
      const retryAfter = err?.parameters?.retry_after || 5;
      this.isPaused = true;
      this.pauseUntil = performance.now() + (retryAfter + 0.5) * 1000;
      this.updateQueue.unshift(session);
      return;
    }

    // Generic error: record error count
    this.registry.recordEditError(session.chatId);
  }

  private createSyntheticContext(session: ActiveDashboardEntry): BotContext {
    return {
      chat: { id: session.chatId, type: "private" },
      from: { id: session.userId, first_name: "User", is_bot: false },
      lang: session.lang,
      user: {
        id: session.userId,
        telegramId: session.userId,
        language: session.lang,
        isMuted: false,
        isActive: true,
      },
      session: {
        lang: session.lang,
        tempPoolSlug: session.poolSlug,
      },
      t: (key: string, params?: Record<string, string | number>) => {
        return translate(session.lang, key, params);
      },
      match: session.poolSlug || "",
    } as unknown as BotContext;
  }
}
