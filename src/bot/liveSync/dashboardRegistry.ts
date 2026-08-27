import { SupportedLanguage } from "../../types/db.js";

export type LiveViewType = "dashboard" | "pool_detail" | "subscriptions" | "settings" | "other";

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
  private readonly MAX_INACTIVE_MS = 2 * 60 * 60 * 1000; // 2 hours inactivity sleep
  private sweepTimer?: NodeJS.Timeout;

  constructor() {
    this.sweepTimer = setInterval(() => this.pruneStaleSessions(), 5 * 60 * 1000);
    this.sweepTimer.unref();
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
    this.activeSessions.set(chatId, {
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
    });
  }

  public updateView(chatId: number, viewType: LiveViewType, poolSlug?: string, lang?: SupportedLanguage): void {
    const session = this.activeSessions.get(chatId);
    if (session) {
      session.viewType = viewType;
      if (poolSlug !== undefined) session.poolSlug = poolSlug;
      if (lang !== undefined) session.lang = lang;
      session.lastUserInteractionAt = Date.now();
    }
  }

  public touchInteraction(chatId: number): void {
    const session = this.activeSessions.get(chatId);
    if (session) {
      session.lastUserInteractionAt = Date.now();
      session.consecutiveErrors = 0;
    }
  }

  public remove(chatId: number): void {
    this.activeSessions.delete(chatId);
  }

  public get(chatId: number): ActiveDashboardEntry | undefined {
    return this.activeSessions.get(chatId);
  }

  public getActiveSessions(): ActiveDashboardEntry[] {
    const now = Date.now();
    const candidates: ActiveDashboardEntry[] = [];

    for (const [, session] of this.activeSessions.entries()) {
      if (session.viewType !== "dashboard" && session.viewType !== "pool_detail") {
        continue;
      }
      if (now - session.lastUserInteractionAt > this.MAX_INACTIVE_MS) {
        continue;
      }
      candidates.push(session);
    }

    return candidates;
  }

  private pruneStaleSessions(): void {
    const now = Date.now();
    for (const [chatId, session] of this.activeSessions.entries()) {
      if (
        now - session.lastUserInteractionAt > this.MAX_INACTIVE_MS ||
        session.consecutiveErrors >= 3
      ) {
        this.activeSessions.delete(chatId);
      }
    }
  }

  public size(): number {
    return this.activeSessions.size;
  }
}
