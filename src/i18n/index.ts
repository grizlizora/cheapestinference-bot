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

export function escapeHtml(str: string): string {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
