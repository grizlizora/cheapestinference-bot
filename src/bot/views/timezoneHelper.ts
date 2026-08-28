/**
 * src/bot/views/timezoneHelper.ts
 * Timezone localization, dual time formatting, and day/night shift personification.
 */
import { SupportedLanguage } from "../../i18n/index.js";
import { icon } from "./iconTheme.js";

export interface TimezoneConfig {
  timeZone: string;
  cityName: Record<SupportedLanguage, string>;
}

export const LOCALE_TIMEZONES: Record<SupportedLanguage, TimezoneConfig> = {
  uk: { timeZone: "Europe/Kyiv", cityName: { uk: "Київ", en: "Kyiv", ru: "Киев" } },
  en: { timeZone: "UTC", cityName: { uk: "UTC", en: "UTC", ru: "UTC" } },
  ru: { timeZone: "Europe/Moscow", cityName: { uk: "МСК", en: "MSK", ru: "МСК" } },
};

/**
 * Formats a block schedule into dual UTC + Localized Time
 * e.g. "08:00 – 16:00 UTC (11:00 – 19:00 Київ)"
 */
export function formatBlockHoursWithLocal(
  blockId: string,
  hoursUtc: string,
  lang: SupportedLanguage
): string {
  const tzConfig = LOCALE_TIMEZONES[lang] || LOCALE_TIMEZONES.en;
  if (tzConfig.timeZone === "UTC") {
    return hoursUtc;
  }

  // Parse start/end hours from "HH:00 – HH:00 UTC" or "HH:00 - HH:00 UTC"
  const match = hoursUtc.match(/(\d{2}):00\s*[-–—]\s*(\d{2}):00/);
  if (!match) return hoursUtc;

  const startUtcHour = parseInt(match[1], 10);
  const endUtcHour = parseInt(match[2], 10);

  const now = new Date();
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), startUtcHour, 0, 0));
  const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), endUtcHour, 0, 0));

  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: tzConfig.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const localStart = dtf.format(startDate);
  const localEnd = dtf.format(endDate);
  const city = tzConfig.cityName[lang] || tzConfig.cityName.en;

  return `${hoursUtc} (${localStart} – ${localEnd} ${city})`;
}

export interface ShiftInfo {
  icon: string;
  name: string;
  shiftName: string;
}

/**
 * Returns the personified shift title with single 3D globe and localized name
 */
export function getShiftPersonification(blockId: string, lang: SupportedLanguage): ShiftInfo {
  const b = (blockId || "").toLowerCase();
  if (b.includes("asia") || b.includes("азія") || b.includes("азия")) {
    const shiftName = lang === "uk" ? "Нічна зміна" : lang === "ru" ? "Ночная смена" : "Night Shift";
    const name = lang === "uk" ? "Азія" : lang === "ru" ? "Азия" : "Asia";
    return { icon: icon("region_asia"), name, shiftName };
  }
  if (b.includes("europe") || b.includes("європа") || b.includes("европа")) {
    const shiftName = lang === "uk" ? "Денна зміна" : lang === "ru" ? "Дневная смена" : "Day Shift";
    const name = lang === "uk" ? "Європа" : lang === "ru" ? "Европа" : "Europe";
    return { icon: icon("region_europe"), name, shiftName };
  }
  if (b.includes("america") || b.includes("америка")) {
    const shiftName = lang === "uk" ? "Вечірня зміна" : lang === "ru" ? "Вечерняя смена" : "Evening Shift";
    const name = lang === "uk" ? "Америка" : lang === "ru" ? "Америка" : "Americas";
    return { icon: icon("region_americas"), name, shiftName };
  }
  return { icon: icon("region_all"), name: "Global", shiftName: "24/7" };
}
