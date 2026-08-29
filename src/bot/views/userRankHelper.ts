/**
 * src/bot/views/userRankHelper.ts
 * User Rank, Telegram Stars Loyalty Tier & Inactivity Retention Status Helper
 */

import { SupportedLanguage } from "../../types/db.js";
import { icon } from "./iconTheme.js";
import {
  calculateStarBonusDays,
  calculateRecencyDecayFactor,
  computeAdaptiveInactivityLimitMs,
  ONE_DAY_MS,
} from "../notifier/subscriberIndex.js";

export type UserRankTier =
  | "admin"
  | "diamond"
  | "speed"
  | "contributor"
  | "supporter"
  | "active"
  | "dormant";

export interface UserRankMeta {
  tier: UserRankTier;
  iconHtml: string;
  rankTitle: string;
  priorityTitle: string;
  retentionText: string;
  bonusDays: number;
  remainingDays: number;
  totalDonatedStars: number;
  isAdmin: boolean;
  isDormant: boolean;
}

export function getUserRankMeta(
  profile?: {
    isAdmin?: boolean;
    totalDonatedStars?: number;
    lastActiveAt?: number;
    lastDonatedAt?: number;
    isActive?: boolean;
  },
  lang: SupportedLanguage = "en",
  now = Date.now()
): UserRankMeta {
  const isAdmin = Boolean(profile?.isAdmin);
  const totalDonatedStars = profile?.totalDonatedStars || 0;
  const lastActiveAt = profile?.lastActiveAt || now;
  const lastDonatedAt = profile?.lastDonatedAt;
  const timeSinceActiveMs = Math.max(0, now - lastActiveAt);

  // 1. Admin (P0 Priority & Permanent Lifetime Immunity)
  if (isAdmin) {
    const iconHtml = icon("nav_admin");
    const infinityHtml = icon("infinity");
    const zapHtml = icon("zap");
    const rankTitle =
      lang === "uk"
        ? `${iconHtml} <b>Адміністратор / Автор</b>`
        : lang === "ru"
        ? `${iconHtml} <b>Администратор / Автор</b>`
        : `${iconHtml} <b>Admin / Creator</b>`;
    const priorityTitle =
      lang === "uk"
        ? `${zapHtml} <b>P0 • Миттєва доставка</b> (Абсолютний пріоритет)`
        : lang === "ru"
        ? `${zapHtml} <b>P0 • Мгновенная доставка</b> (Абсолютный приоритет)`
        : `${zapHtml} <b>P0 • Instant Dispatch</b> (Absolute Priority)`;
    const retentionText =
      lang === "uk"
        ? `${infinityHtml} <b>Безстроковий імунітет</b> (Завжди активний)`
        : lang === "ru"
        ? `${infinityHtml} <b>Бессрочный иммунитет</b> (Всегда активен)`
        : `${infinityHtml} <b>Lifetime Immunity</b> (Always active)`;

    return {
      tier: "admin",
      iconHtml,
      rankTitle,
      priorityTitle,
      retentionText,
      bonusDays: 9999,
      remainingDays: 9999,
      totalDonatedStars,
      isAdmin: true,
      isDormant: false,
    };
  }

  // 2. Compute Retention Limit
  const cutoffLimitMs = computeAdaptiveInactivityLimitMs(totalDonatedStars, lastDonatedAt, now);
  const remainingMs = Math.max(0, cutoffLimitMs - timeSinceActiveMs);
  const remainingDays = Math.ceil(remainingMs / ONE_DAY_MS);
  const isDormant = remainingMs === 0;

  const rawBonusDays = calculateStarBonusDays(totalDonatedStars);
  const donationAgeDays = lastDonatedAt ? Math.max(0, now - lastDonatedAt) / ONE_DAY_MS : 0;
  const freshness = calculateRecencyDecayFactor(donationAgeDays);
  const effectiveBonusDays = Math.round(rawBonusDays * freshness);

  // 3. Determine Rank Tier
  let tier: UserRankTier = "active";
  let iconHtml = icon("status_available");
  let rankTitle = "";
  let priorityTitle = "";

  const zapHtml = icon("zap");
  const rocketHtml = icon("rocket");
  const heartHtml = icon("heart");
  const coffeeHtml = icon("coffee");
  const bellHtml = icon("notify_bell_on");
  const standbyHtml = icon("status_standby");
  const liveHtml = icon("status_available");

  if (totalDonatedStars >= 250) {
    tier = "diamond";
    iconHtml = icon("rank_diamond");
    rankTitle =
      lang === "uk"
        ? `${iconHtml} <b>Diamond Patron</b>`
        : lang === "ru"
        ? `${iconHtml} <b>Diamond Patron</b>`
        : `${iconHtml} <b>Diamond Patron</b>`;
    priorityTitle =
      lang === "uk"
        ? `${rocketHtml} <b>P1 • Топ Черга</b> (1-ша хвиля сповіщень)`
        : lang === "ru"
        ? `${rocketHtml} <b>P1 • Топ Очередь</b> (1-я волна уведомлений)`
        : `${rocketHtml} <b>P1 • Top Queue</b> (1st wave of alerts)`;
  } else if (totalDonatedStars >= 100) {
    tier = "speed";
    iconHtml = zapHtml;
    rankTitle =
      lang === "uk"
        ? `${iconHtml} <b>Speed Patron</b>`
        : lang === "ru"
        ? `${iconHtml} <b>Speed Patron</b>`
        : `${iconHtml} <b>Speed Patron</b>`;
    priorityTitle =
      lang === "uk"
        ? `${zapHtml} <b>P1 • Високий пріоритет</b> (Черга донатерів)`
        : lang === "ru"
        ? `${zapHtml} <b>P1 • Высокий приоритет</b> (Очередь донатеров)`
        : `${zapHtml} <b>P1 • High Priority</b> (Supporter queue)`;
  } else if (totalDonatedStars >= 50) {
    tier = "contributor";
    iconHtml = heartHtml;
    rankTitle =
      lang === "uk"
        ? `${iconHtml} <b>Contributor</b>`
        : lang === "ru"
        ? `${iconHtml} <b>Contributor</b>`
        : `${iconHtml} <b>Contributor</b>`;
    priorityTitle =
      lang === "uk"
        ? `${heartHtml} <b>P1 • Підвищений пріоритет</b>`
        : lang === "ru"
        ? `${heartHtml} <b>P1 • Повышенный приоритет</b>`
        : `${heartHtml} <b>P1 • Elevated Priority</b>`;
  } else if (totalDonatedStars >= 1) {
    tier = "supporter";
    iconHtml = coffeeHtml;
    rankTitle =
      lang === "uk"
        ? `${iconHtml} <b>Supporter</b>`
        : lang === "ru"
        ? `${iconHtml} <b>Supporter</b>`
        : `${iconHtml} <b>Supporter</b>`;
    priorityTitle =
      lang === "uk"
        ? `${coffeeHtml} <b>P1 • Пріоритетна черга</b>`
        : lang === "ru"
        ? `${coffeeHtml} <b>P1 • Приоритетная очередь</b>`
        : `${coffeeHtml} <b>P1 • Priority Queue</b>`;
  } else if (isDormant) {
    tier = "dormant";
    iconHtml = standbyHtml;
    rankTitle =
      lang === "uk"
        ? `${iconHtml} <b>Режим очікування</b>`
        : lang === "ru"
        ? `${iconHtml} <b>Режим ожидания</b>`
        : `${iconHtml} <b>Standby Observer</b>`;
    priorityTitle =
      lang === "uk"
        ? `${standbyHtml} <b>Призупинено</b> (>14 днів неактивності)`
        : lang === "ru"
        ? `${standbyHtml} <b>Приостановлено</b> (>14 дней неактивности)`
        : `${standbyHtml} <b>Paused</b> (>14 days inactive)`;
  } else {
    tier = "active";
    iconHtml = liveHtml;
    rankTitle =
      lang === "uk"
        ? `${iconHtml} <b>Активний користувач</b>`
        : lang === "ru"
        ? `${iconHtml} <b>Активный пользователь</b>`
        : `${iconHtml} <b>Active Observer</b>`;
    priorityTitle =
      lang === "uk"
        ? `${bellHtml} <b>P2 • Стандартна черга</b>`
        : lang === "ru"
        ? `${bellHtml} <b>P2 • Стандартная очередь</b>`
        : `${bellHtml} <b>P2 • Standard Queue</b>`;
  }

  // 4. Localized Retention Description
  let retentionText = "";
  if (isDormant) {
    retentionText =
      lang === "uk"
        ? `${standbyHtml} <b>Сповіщення на паузі</b> <i>(Натисніть будь-яку кнопку для миттєвого відновлення)</i>`
        : lang === "ru"
        ? `${standbyHtml} <b>Уведомления на паузе</b> <i>(Нажмите любую кнопку для мгновенного возобновления)</i>`
        : `${standbyHtml} <b>Alerts on standby</b> <i>(Press any button to instantly resume)</i>`;
  } else if (totalDonatedStars > 0) {
    retentionText =
      lang === "uk"
        ? `${liveHtml} <b>Активно ще ${remainingDays} дн.</b> (+${effectiveBonusDays} дн. бонус Stars)`
        : lang === "ru"
        ? `${liveHtml} <b>Активно ещё ${remainingDays} дн.</b> (+${effectiveBonusDays} дн. бонус Stars)`
        : `${liveHtml} <b>Active for ${remainingDays} days</b> (+${effectiveBonusDays}d Stars bonus)`;
  } else {
    retentionText =
      lang === "uk"
        ? `${liveHtml} <b>Активно ще ${remainingDays} дн.</b> <i>(Поновлюється при взаємодії)</i>`
        : lang === "ru"
        ? `${liveHtml} <b>Активно ещё ${remainingDays} дн.</b> <i>(Продлевается при действии)</i>`
        : `${liveHtml} <b>Active for ${remainingDays} days</b> <i>(Auto-renews on interaction)</i>`;
  }

  return {
    tier,
    iconHtml,
    rankTitle,
    priorityTitle,
    retentionText,
    bonusDays: effectiveBonusDays,
    remainingDays,
    totalDonatedStars,
    isAdmin: false,
    isDormant,
  };
}

export function renderUserProfileCard(
  profile?: {
    isAdmin?: boolean;
    totalDonatedStars?: number;
    lastActiveAt?: number;
    lastDonatedAt?: number;
    telegramId?: number;
  },
  lang: SupportedLanguage = "en"
): string {
  const meta = getUserRankMeta(profile, lang);
  const starsBadge =
    meta.totalDonatedStars > 0 ? ` (${meta.totalDonatedStars} ⭐)` : "";

  if (lang === "uk") {
    return (
      `👤 <b>Профіль та статус:</b>\n` +
      `• <b>Ранг:</b> ${meta.rankTitle}${starsBadge}\n` +
      `• <b>Пріоритет черги:</b> ${meta.priorityTitle}\n` +
      `• <b>Стан моніторингу:</b> ${meta.retentionText}`
    );
  } else if (lang === "ru") {
    return (
      `👤 <b>Профиль и статус:</b>\n` +
      `• <b>Ранг:</b> ${meta.rankTitle}${starsBadge}\n` +
      `• <b>Приоритет очереди:</b> ${meta.priorityTitle}\n` +
      `• <b>Статус мониторинга:</b> ${meta.retentionText}`
    );
  } else {
    return (
      `👤 <b>Profile & Status:</b>\n` +
      `• <b>Rank:</b> ${meta.rankTitle}${starsBadge}\n` +
      `• <b>Queue Priority:</b> ${meta.priorityTitle}\n` +
      `• <b>Monitoring State:</b> ${meta.retentionText}`
    );
  }
}
