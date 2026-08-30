import { SupportedLanguage } from "../types/db.js";
export type { SupportedLanguage };
import uk from "./locales/uk.json" with { type: "json" };
import en from "./locales/en.json" with { type: "json" };
import ru from "./locales/ru.json" with { type: "json" };

export const SUPPORTED_LANGUAGES: SupportedLanguage[] = ["uk", "en", "ru"];
export const DEFAULT_LANGUAGE: SupportedLanguage = "en";

const dictionaries: Record<SupportedLanguage, typeof uk> = {
  uk,
  en: en as typeof uk,
  ru: ru as typeof uk,
};

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

export function escapeHtml(str: string): string {
  if (!str) return "";
  return String(str).replace(/[&<>"]/g, (char) => HTML_ESCAPE_MAP[char] || char);
}

/**
 * Safely removes leading emoji, variation selectors (\uFE0F), skin tones,
 * and zero-width joiners (\u200D) without bisecting surrogate pairs.
 */
export function stripLeadingEmoji(text: string): string {
  if (!text) return "";
  return text.replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, "").trim();
}

export function resolveDefaultLanguage(rawLangCode?: string | null): SupportedLanguage {
  if (!rawLangCode) return "en";

  const primary = rawLangCode.toLowerCase().split(/[-_]/)[0];

  if (primary === "uk") {
    return "uk";
  }

  if (primary === "ru" || primary === "be" || primary === "kk") {
    return "ru";
  }

  // Universal Fallback for all other locales (en, de, fr, es, zh, etc.)
  return "en";
}

function lookupKey(dict: any, keys: string[]): string | undefined {
  let curr = dict;
  for (const k of keys) {
    if (curr && typeof curr === "object" && k in curr) {
      curr = curr[k];
    } else {
      return undefined;
    }
  }
  return typeof curr === "string" ? curr : undefined;
}

export function translate(
  lang: SupportedLanguage,
  key: string,
  params?: Record<string, string | number>
): string {
  const keys = key.split(".");
  const str =
    lookupKey(dictionaries[lang], keys) ??
    lookupKey(dictionaries[DEFAULT_LANGUAGE], keys) ??
    lookupKey(dictionaries.uk, keys) ??
    key;

  if (!params) return str;

  return str.replace(/{(\w+)}/g, (_, match) => {
    return params[match] !== undefined ? String(params[match]) : `{${match}}`;
  });
}

export function getLanguageFlag(lang: SupportedLanguage): string {
  switch (lang) {
    case "uk":
      return "🇺🇦 Українська";
    case "en":
      return "🇬🇧 English";
    case "ru":
      return "🇷🇺 Русский";
    default:
      return "🌐";
  }
}

export function formatRelativeTime(timestamp: number, lang: SupportedLanguage): string {
  if (!timestamp || timestamp <= 0) {
    return lang === "uk" ? "невідомо" : lang === "ru" ? "неизвестно" : "unknown";
  }
  const elapsedSec = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (elapsedSec <= 3) {
    return lang === "uk" ? "щойно" : lang === "ru" ? "только что" : "just now";
  }
  if (elapsedSec < 60) {
    return lang === "uk" ? `${elapsedSec}с тому` : lang === "ru" ? `${elapsedSec}с назад` : `${elapsedSec}s ago`;
  }
  const mins = Math.floor(elapsedSec / 60);
  if (mins < 60) {
    return lang === "uk" ? `${mins}хв тому` : lang === "ru" ? `${mins}мин назад` : `${mins}m ago`;
  }
  const hours = Math.floor(mins / 60);
  return lang === "uk" ? `${hours}год тому` : lang === "ru" ? `${hours}ч назад` : `${hours}h ago`;
}
