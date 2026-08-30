/**
 * src/bot/liveSync/dashboardRegistry.ts
 * Persistent & Multi-Tier Active Dashboard Registry
 */

import { SupportedLanguage } from "../../types/db.js";
import { ActiveDashboardDAO } from "../../db/dao/activeDashboards.js";

export type LiveViewType = "dashboard" | "pool_detail" | "subscriptions" | "settings" | "admin" | "other";

export interface ActiveDashboardEntry {
  chatId: number;
  messageId: number;
  userId: number;
  lang: SupportedLanguage;
  viewType: LiveViewType;
  poolSlug?: string;
  lastRenderedTextHash: number;
  lastRenderedKeyboardHash: number;
  lastScrapeTimestamp: number;
  lastTelegramEditAt: number;
  lastUserInteractionAt: number;
  consecutiveErrors: number;
}

export function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class ActiveDashboardRegistry {
  private activeSessions = new Map<number, ActiveDashboardEntry>();
  public static readonly ACTIVE_TIER_MS = 30 * 60 * 1000;       // 30 min high-frequency sync (15s)
  public static readonly ECO_TIER_MS = 24 * 60 * 60 * 1000;      // 24 hours eco heartbeat sync (60s)
  public static readonly MAX_LIFETIME_MS = 48 * 60 * 60 * 1000;  // 48 hours (Telegram API hard limit)

  private sweepTimer?: NodeJS.Timeout;

  constructor(private readonly dao?: ActiveDashboardDAO) {
    if (this.dao) {
      this.hydrateFromDb();
    }
    this.sweepTimer = setInterval(() => this.pruneStaleSessions(), 15 * 60 * 1000);
    this.sweepTimer.unref();
  }

  public hydrateFromDb(): void {
    if (!this.dao) return;
    try {
      const records = this.dao.getHydrationCandidates();
      let count = 0;
      for (const r of records) {
        const lastEditTs = r.last_telegram_edit_at
          ? (Date.parse(r.last_telegram_edit_at.replace(" ", "T") + "Z") || Date.parse(r.last_telegram_edit_at) || 0)
          : 0;
        const lastInteractionTs = r.last_interaction_at
          ? (Date.parse(r.last_interaction_at.replace(" ", "T") + "Z") || Date.parse(r.last_interaction_at) || Date.now())
          : Date.now();

        this.activeSessions.set(r.chat_id, {
          chatId: r.chat_id,
          messageId: r.message_id,
          userId: r.user_id,
          lang: r.language,
          viewType: r.view_type as LiveViewType,
          poolSlug: r.pool_slug || undefined,
          lastRenderedTextHash: 0, // Reset to 0 so startup scrape immediately pushes live update
          lastRenderedKeyboardHash: 0,
          lastScrapeTimestamp: 0,
          lastTelegramEditAt: 0,   // Reset to 0 to bypass throttle on boot
          lastUserInteractionAt: lastInteractionTs,
          consecutiveErrors: 0,
        });
        count++;
      }
      console.log(`⚡ [DashboardRegistry] Hydrated ${count} active dashboard sessions from SQLite.`);
    } catch (err: any) {
      console.error("⚠️ [DashboardRegistry] Failed to hydrate sessions:", err.message);
    }
  }

  public register(
    chatId: number,
    messageId: number,
    userId: number,
    lang: SupportedLanguage,
    viewType: LiveViewType = "dashboard",
    poolSlug?: string
  ): void {
    const now = Date.now();
    // High-watermark LRU bound: cap in-memory sessions at 10,000 to maintain flat heap <45MB
    if (this.activeSessions.size >= 10_000 && !this.activeSessions.has(chatId)) {
      const oldestKey = this.activeSessions.keys().next().value;
      if (oldestKey !== undefined) {
        this.activeSessions.delete(oldestKey);
      }
    }

    const entry: ActiveDashboardEntry = {
      chatId,
      messageId,
      userId,
      lang,
      viewType,
      poolSlug,
      lastRenderedTextHash: 0,
      lastRenderedKeyboardHash: 0,
      lastScrapeTimestamp: 0,
      lastTelegramEditAt: 0,
      lastUserInteractionAt: now,
      consecutiveErrors: 0,
    };
    this.activeSessions.set(chatId, entry);

    this.dao?.upsert({
      chat_id: chatId,
      message_id: messageId,
      user_id: userId,
      view_type: viewType,
      pool_slug: poolSlug,
      language: lang,
    });
  }

  public updateView(chatId: number, viewType: LiveViewType, poolSlug?: string, lang?: SupportedLanguage, messageId?: number, userId?: number): void {
    let session = this.activeSessions.get(chatId);
    if (!session) {
      if (messageId && messageId > 0) {
        this.register(chatId, messageId, userId || chatId, lang || "en", viewType, poolSlug);
        return;
      }
      return;
    }
    session.viewType = viewType;
    if (poolSlug !== undefined) session.poolSlug = poolSlug;
    if (lang !== undefined) session.lang = lang;
    if (messageId !== undefined && messageId > 0) session.messageId = messageId;
    session.lastUserInteractionAt = Date.now();
    session.lastRenderedTextHash = 0; // Reset text hash so new view renders immediately!
    session.consecutiveErrors = 0;
    // Re-insert at Map tail to ensure true LRU ordering
    this.activeSessions.delete(chatId);
    this.activeSessions.set(chatId, session);
    this.dao?.updateView(chatId, viewType, poolSlug, lang, messageId, userId);
  }

  public touchInteraction(chatId: number): void {
    const session = this.activeSessions.get(chatId);
    if (session) {
      session.lastUserInteractionAt = Date.now();
      session.consecutiveErrors = 0;
      // Re-insert at Map tail to ensure true LRU ordering
      this.activeSessions.delete(chatId);
      this.activeSessions.set(chatId, session);
    }
    this.dao?.touchInteraction(chatId);
  }

  public remove(chatId: number): void {
    this.activeSessions.delete(chatId);
    this.dao?.delete(chatId);
  }

  public get(chatId: number): ActiveDashboardEntry | undefined {
    return this.activeSessions.get(chatId);
  }

  public recordEditSuccess(chatId: number, textHash: number): void {
    const session = this.activeSessions.get(chatId);
    if (session) {
      session.lastRenderedTextHash = textHash;
      session.lastTelegramEditAt = Date.now();
      session.consecutiveErrors = 0;
    }
    this.dao?.markEditSuccess(chatId, textHash);
  }

  public recordEditError(chatId: number): void {
    const session = this.activeSessions.get(chatId);
    if (session) {
      session.consecutiveErrors++;
      if (session.consecutiveErrors >= 3) {
        this.remove(chatId);
        return;
      }
    }
    this.dao?.incrementError(chatId);
  }

  /**
   * Returns all sessions eligible for instant update on catalog/slot change (diff_events)
   * All active + eco sessions within 24h get immediate slot updates!
   */
  public getSessionsForDataChange(): ActiveDashboardEntry[] {
    const now = Date.now();
    const candidates: ActiveDashboardEntry[] = [];
    for (const [, session] of this.activeSessions.entries()) {
      if (session.viewType !== "dashboard" && session.viewType !== "pool_detail") continue;
      if (now - session.lastUserInteractionAt > ActiveDashboardRegistry.ECO_TIER_MS) continue;
      candidates.push(session);
    }
    return candidates;
  }

  /**
   * Returns sessions eligible for periodic heartbeat timestamp refresh
   * Tier 1 (Active <30m): every 15-20s
   * Tier 2 (Eco 30m-24h): every 60s (1 min)
   */
  public getSessionsForHeartbeat(): ActiveDashboardEntry[] {
    const now = Date.now();
    const candidates: ActiveDashboardEntry[] = [];

    for (const [, session] of this.activeSessions.entries()) {
      if (session.viewType !== "dashboard" && session.viewType !== "pool_detail") continue;

      const idleDuration = now - session.lastUserInteractionAt;

      // Beyond 24h: Standby tier, no routine heartbeat edit
      if (idleDuration > ActiveDashboardRegistry.ECO_TIER_MS) continue;

      // Tier 1: Active user (<30m) -> throttle 10s
      if (idleDuration <= ActiveDashboardRegistry.ACTIVE_TIER_MS) {
        if (now - session.lastTelegramEditAt >= 10_000) {
          candidates.push(session);
        }
      }
      // Tier 2: Eco user (30m - 24h) -> throttle 60s (1 min)
      else {
        if (now - session.lastTelegramEditAt >= 60_000) {
          candidates.push(session);
        }
      }
    }

    return candidates;
  }

  /**
   * Compatibility method
   */
  public getActiveSessions(): ActiveDashboardEntry[] {
    return this.getSessionsForDataChange();
  }

  private pruneStaleSessions(): void {
    const now = Date.now();
    for (const [chatId, session] of this.activeSessions.entries()) {
      if (
        now - session.lastUserInteractionAt > ActiveDashboardRegistry.MAX_LIFETIME_MS ||
        session.consecutiveErrors >= 3
      ) {
        this.activeSessions.delete(chatId);
      }
    }
    this.dao?.pruneStale();
  }

  public size(): number {
    return this.activeSessions.size;
  }

  public close(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }
}
