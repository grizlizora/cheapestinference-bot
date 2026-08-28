/**
 * src/bot/views/poolRanks.ts
 * Compute pool ranks, tier hierarchies, and badges.
 */
import { SupportedLanguage } from "../../i18n/index.js";
import { icon } from "./iconTheme.js";

export interface PoolRankMeta {
  tierName: Record<SupportedLanguage, string>;
  iconsHtml: string;
  rawIcons: string;
  tagline: Record<SupportedLanguage, string>;
}

export const POOL_RANKS: Record<string, PoolRankMeta> = {
  flagship: {
    tierName: {
      uk: "Flagship Supercluster",
      en: "Flagship Supercluster",
      ru: "Flagship Supercluster",
    },
    iconsHtml: `${icon("nav_admin")} ${icon("rank_diamond")}`,
    rawIcons: "👑 💎",
    tagline: {
      uk: "Преміум суперкластер для важких моделей (DeepSeek-R1 671B, Claude Sonnet)",
      en: "Top-tier supercluster for extreme scale (DeepSeek-R1 671B, Claude Sonnet)",
      ru: "Премиум суперкластер для тяжелых моделей (DeepSeek-R1 671B, Claude Sonnet)",
    },
  },
  frontier: {
    tierName: {
      uk: "Frontier Speed",
      en: "Frontier Speed",
      ru: "Frontier Speed",
    },
    iconsHtml: `${icon("pool_flagship")} ${icon("event_slot_drop")}`,
    rawIcons: "🚀 ⚡",
    tagline: {
      uk: "Ультрашвидкісний інференс для Reasoning та кодогенерації",
      en: "Ultra high-speed reasoning & coding inference cluster",
      ru: "Ультраскоростной инференс для Reasoning и генерации кода",
    },
  },
  core: {
    tierName: {
      uk: "Core Infrastructure",
      en: "Core Infrastructure",
      ru: "Core Infrastructure",
    },
    iconsHtml: `${icon("rank_shield")} ${icon("nav_settings")}`,
    rawIcons: "🛡️ ⚙️",
    tagline: {
      uk: "Базова високодоступна інфраструктура з максимальною окупністю",
      en: "Cost-effective foundational open-weights infrastructure",
      ru: "Базовая высокодоступная инфраструктура с максимальной окупаемостью",
    },
  },
};
