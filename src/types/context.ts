import { Context, SessionFlavor } from "grammy";
import { MenuFlavor } from "@grammyjs/menu";
import { UserRecord, SupportedLanguage } from "./db.js";

export interface BroadcastLanguageDraft {
  htmlText: string;
  rawText: string;
  entitiesCount: number;
  hasCustomEmoji: boolean;
  mediaType: "text" | "photo" | "video" | "document" | "animation";
  fileId?: string;
  createdAt: number;
  isConfirmed: boolean;
}

export interface BroadcastSessionState {
  stage: "idle" | "language_select" | "awaiting_text" | "preview" | "confirm_send";
  activeEditLang?: SupportedLanguage;
  drafts: {
    uk?: BroadcastLanguageDraft;
    en?: BroadcastLanguageDraft;
    ru?: BroadcastLanguageDraft;
  };
  sendSilent: boolean;
  filter: "all" | "active_only" | "donors_only";
}

export interface SessionData {
  tempPoolSlug?: string;
  lastActiveMenu?: string;
  waitingForCustomStars?: boolean;
  pendingCustomStars?: number;
  pendingDeepLink?: string;
  fromSettings?: boolean;
  broadcast?: BroadcastSessionState;
}

export type BotContext = Context &
  SessionFlavor<SessionData> &
  MenuFlavor & {
    user: UserRecord;
    lang: SupportedLanguage;
    isNewUser?: boolean;
    t: (key: string, params?: Record<string, string | number>) => string;
  };
