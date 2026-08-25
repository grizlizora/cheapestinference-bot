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

export function translate(
  lang: SupportedLanguage,
  key: string,
  params?: Record<string, string | number>
): string {
  const dict = dictionaries[lang] || dictionaries[DEFAULT_LANGUAGE];
  const keys = key.split(".");
  let current: any = dict;

  for (const k of keys) {
    if (current && typeof current === "object" && k in current) {
      current = current[k];
    } else {
      // Fallback to English, then Ukrainian
      let fallback: any = dictionaries.en;
      for (const fk of keys) {
        if (fallback && typeof fallback === "object" && fk in fallback) {
          fallback = fallback[fk];
        } else {
          let ukFallback: any = dictionaries.uk;
          for (const ukk of keys) {
            if (ukFallback && typeof ukFallback === "object" && ukk in ukFallback) {
              ukFallback = ukFallback[ukk];
            } else {
              return key;
            }
          }
          current = ukFallback;
          break;
        }
      }
      if (current === dict) current = fallback;
      break;
    }
  }

  if (typeof current !== "string") return key;

  if (!params) return current;

  return current.replace(/{(\w+)}/g, (_, match) => {
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
