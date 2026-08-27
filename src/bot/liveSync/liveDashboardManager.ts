import { Bot } from "grammy";
import { Menu } from "@grammyjs/menu";
import { BotContext } from "../../types/context.js";
import { PoolStateDAO } from "../../db/dao/poolState.js";
import { SlotHistoryDAO } from "../../db/dao/slotHistory.js";
import { SubscriptionDAO } from "../../db/dao/subscriptions.js";
import { ScraperOrchestrator } from "../../engine/scraperOrchestrator.js";
import { ActiveDashboardRegistry, ActiveDashboardEntry, fnv1a32 } from "./dashboardRegistry.js";
import { renderDashboardText } from "../menus/mainDashboard.js";
import { renderPoolDetailText } from "../menus/poolDetail.js";
import { translate } from "../../i18n/index.js";

export interface LiveDashboardManagerOptions {
  heartbeatSyncThrottleMs?: number; // Throttle timestamp updates during heartbeat (default 45s)
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

  private readonly heartbeatSyncThrottleMs: number;
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
    this.heartbeatSyncThrottleMs = options.heartbeatSyncThrottleMs ?? 10_000;
    this.targetRatePerSec = options.maxEditsPerSecond ?? 20;
    this.tokenIntervalMs = 1000 / this.targetRatePerSec;

    // Attach hooks to ScraperOrchestrator
    this.scraper.on("diff_events", () => this.handleDataChanged());
    this.scraper.on("heartbeat", (hb: any) => this.handleScraperHeartbeat(Boolean(hb?.modified)));
  }

  public getRegistry(): ActiveDashboardRegistry {
    return this.registry;
  }

  /**
   * Fast Path: Invoked immediately when DiffEngine detects catalog or slot changes
   */
  public handleDataChanged(): void {
    // Prune stale sessions (>2h) and clear stale lastChatEditTime entries (>10m)
    this.registry.pruneStaleSessions();
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [chatId, ts] of this.lastChatEditTime.entries()) {
      if (ts < cutoff) {
        this.lastChatEditTime.delete(chatId);
      }
    }
    const activeSessions = this.registry.getActiveSessions();
    for (const session of activeSessions) {
      this.enqueueUpdate(session);
    }
  }

  /**
   * Invoked on routine heartbeat polls and scrape cycles
   */
  public handleScraperHeartbeat(isModified: boolean): void {
    const now = Date.now();
    const activeSessions = this.registry.getActiveSessions();

    for (const session of activeSessions) {
      // If data modified or throttle time elapsed (>=10s), sync live dashboard message
      if (isModified || (now - session.lastTelegramEditAt >= this.heartbeatSyncThrottleMs)) {
        this.enqueueUpdate(session);
      }
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
            this.executeEdit(session).catch(() => {});
          }
        }
      }

      setTimeout(processTick, Math.max(10, this.tokenIntervalMs));
    };

    setImmediate(processTick);
  }

  private async executeEdit(session: ActiveDashboardEntry): Promise<void> {
    try {
      const syntheticCtx = this.createSyntheticContext(session);
      let text = "";
      let targetMenu: Menu<BotContext>;

      if (session.viewType === "dashboard") {
        text = renderDashboardText(syntheticCtx, this.poolStateDao, this.historyDao, this.scraper);
        targetMenu = this.mainDashboardMenu;
      } else if (session.viewType === "pool_detail") {
        text = renderPoolDetailText(syntheticCtx, this.poolStateDao, this.historyDao, this.scraper);
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

      const payload: Record<string, any> = {
        parse_mode: "HTML",
        reply_markup: targetMenu,
        link_preview_options: { is_disabled: true },
      };

      if (typeof (targetMenu as any).prepare === "function") {
        await (targetMenu as any).prepare(payload, syntheticCtx);
      }

      await this.bot.api.editMessageText(session.chatId, session.messageId, text, payload as any);

      session.lastRenderedTextHash = textHash;
      session.lastTelegramEditAt = Date.now();
      session.consecutiveErrors = 0;
    } catch (err: any) {
      this.handleEditError(err, session);
    }
  }

  private handleEditError(err: any, session: ActiveDashboardEntry): void {
    const errorCode = err?.error_code || err?.response?.error_code;
    const desc = err?.description || err?.message || "";

    // 1. Message not modified (normal Telegram response when text is identical)
    if (desc.includes("message is not modified")) {
      session.lastTelegramEditAt = Date.now();
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

    // 5. General Error (increment retry count)
    session.consecutiveErrors++;
    if (session.consecutiveErrors >= 3) {
      this.lastChatEditTime.delete(session.chatId);
      this.registry.remove(session.chatId);
    }
  }

  private createSyntheticContext(session: ActiveDashboardEntry): BotContext {
    return {
      chat: { id: session.chatId, type: "private" },
      from: { id: session.chatId, is_bot: false, first_name: "User" },
      user: {
        id: session.userId,
        telegram_id: session.chatId,
        language: session.lang,
      } as any,
      lang: session.lang,
      session: { tempPoolSlug: session.poolSlug } as any,
      t: (key: string, params?: Record<string, string | number>) =>
        translate(session.lang, key, params),
    } as unknown as BotContext;
  }
}
