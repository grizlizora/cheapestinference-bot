import { Context, SessionFlavor } from "grammy";
import { MenuFlavor } from "@grammyjs/menu";
import { UserRecord, SupportedLanguage } from "./db.js";

export interface SessionData {
  tempPoolSlug?: string;
  lastActiveMenu?: string;
}

export type BotContext = Context &
  SessionFlavor<SessionData> &
  MenuFlavor & {
    user: UserRecord;
    lang: SupportedLanguage;
    isNewUser?: boolean;
    t: (key: string, params?: Record<string, string | number>) => string;
  };
