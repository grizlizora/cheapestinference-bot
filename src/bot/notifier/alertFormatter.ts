/**
 * src/bot/notifier/alertFormatter.ts
 * Pure Synchronous Alert & Bundle Message Formatter
 */

import { InlineKeyboard } from "grammy";
import { DiffEvent, PriceAnalyticsPayload } from "../../types/domain.js";
import { translate, escapeHtml, SupportedLanguage, stripLeadingEmoji } from "../../i18n/index.js";
import { PackedUserProfile } from "./subscriberIndex.js";
import { truncateToTelegramLimit } from "./htmlTagBalancer.js";
import { icon, getModel3DIcon } from "../views/iconTheme.js";

export type BroadcastPriority = "P0" | "P1" | "P2" | "P3";

export interface OutgoingAlertMessage {
  id: string;
  telegramId: number;
  userId: number;
  poolSlug: string;
  blockId: string;
  eventType: string;
  text: string;
  keyboard?: InlineKeyboard;
  isMuted: boolean;
  priority: BroadcastPriority;
  retries: number;
  enqueuedAt: number;
}

export function cleanPriceString(val: string | number | undefined | null): string {
  if (val === undefined || val === null || val === "") return "0";
  const cleaned = String(val).replace(/,/g, "").replace(/[^0-9.-]/g, "");
  const num = parseFloat(cleaned);
  if (isNaN(num) || Object.is(num, -0) || num === 0) return "0";
  return num % 1 === 0 ? num.toFixed(0) : num.toFixed(2);
}

export function formatPriceDeltaBadge(
  delta: number,
  pct: number,
  lang: SupportedLanguage
): string {
  if (!Number.isFinite(delta) || !Number.isFinite(pct)) return "";
  const roundedDelta = Math.round(Math.abs(delta) * 100) / 100;
  if (roundedDelta === 0) return "";
  const currencyMonth = translate(lang, "common.currency_month") || "mo";
  const absDelta = Number.isInteger(roundedDelta) ? roundedDelta.toFixed(0) : roundedDelta.toFixed(2);
  const roundedPct = Math.round(Math.abs(pct) * 10) / 10;
  const absPct = Number.isInteger(roundedPct) ? roundedPct.toFixed(0) : roundedPct.toFixed(1);

  if (delta < 0) {
    return translate(lang, "alerts.price_discount_badge", {
      delta: absDelta,
      percentage: absPct,
      currency_month: currencyMonth,
    });
  } else {
    return translate(lang, "alerts.price_increase_badge", {
      delta: absDelta,
      percentage: absPct,
      currency_month: currencyMonth,
    });
  }
}

export function formatPriceRatingBadge(
  pa: PriceAnalyticsPayload | undefined,
  currentPrice: number,
  lang: SupportedLanguage
): string {
  if (!pa || pa.rating === "insufficient_data" || pa.sampleCount < 3) return "";
  const currStr = currentPrice % 1 === 0 ? currentPrice.toFixed(0) : currentPrice.toFixed(2);
  const avgStr =
    pa.avgPrice != null ? (pa.avgPrice % 1 === 0 ? pa.avgPrice.toFixed(0) : pa.avgPrice.toFixed(2)) : "";

  if (pa.rating === "all_time_low") {
    const rawText = stripLeadingEmoji(translate(lang, "alerts.price_all_time_low") || `Історичний мінімум! Найнижча ціна ($${currStr})`);
    return `${icon("price_all_time_low")} ${rawText.startsWith("<b>") ? rawText : `<b>${rawText}</b>`}`;
  }
  if (pa.rating === "below_average" && pa.avgPrice != null) {
    const rawText = stripLeadingEmoji(translate(lang, "alerts.price_below_average", { current: currStr, avg: avgStr }) || `Нижче середнього ($${currStr} vs сер. $${avgStr})`);
    return `${icon("status_available")} ${rawText.startsWith("<b>") ? rawText : `<b>${rawText}</b>`}`;
  }
  if (pa.rating === "above_average" && pa.avgPrice != null) {
    const rawText = stripLeadingEmoji(translate(lang, "alerts.price_above_average", { current: currStr, avg: avgStr }) || `Вище середнього ($${currStr} vs сер. $${avgStr})`);
    return `${icon("status_sold_out")} ${rawText.startsWith("<b>") ? rawText : `<b>${rawText}</b>`}`;
  }
  if (pa.rating === "fair" && pa.avgPrice != null) {
    const rawText = stripLeadingEmoji(translate(lang, "alerts.price_fair_value") || "Стандартна ціна (в межах норми)");
    return `${icon("price_fair")} ${rawText.startsWith("<b>") ? rawText : `<b>${rawText}</b>`}`;
  }
  return "";
}

function resolveBlockName(eventBlock: string, lang: SupportedLanguage): string {
  const translated = translate(lang, `common.block_${eventBlock}`);
  if (translated && translated !== `common.block_${eventBlock}`) {
    return translated;
  }
  if (eventBlock === "ALL") {
    return translate(lang, "common.block_ALL") || "All Blocks";
  }
  return eventBlock;
}

import { formatBlockHoursWithLocal, getShiftPersonification } from "../views/timezoneHelper.js";

function getRegionIcon(block: string): string {
  const lower = (block || "").toLowerCase();
  if (lower.includes("asia") || lower.includes("азія") || lower.includes("азия")) {
    return icon("region_asia");
  }
  if (lower.includes("europe") || lower.includes("європа") || lower.includes("европа")) {
    return icon("region_europe");
  }
  if (lower.includes("america") || lower.includes("америка")) {
    return icon("region_americas");
  }
  return icon("nav_language");
}

export function formatAlertMessage(
  user: PackedUserProfile,
  event: DiffEvent,
  priority: BroadcastPriority,
  cachedDurationFormatted?: string
): OutgoingAlertMessage {
  const lang = user.language;
  const blockName = resolveBlockName(event.block, lang);
  const timeFormatted = new Date(event.timestamp).toISOString().replace("T", " ").substring(0, 19);
  const currencyMonth = translate(lang, "common.currency_month") || "mo";

  const blockHash = event.block && event.block !== "ALL" ? `#${event.block}` : "";
  const poolUrl = `https://cheapestinference.com/pools/${event.poolSlug}`;
  const checkoutUrl = `${poolUrl}${blockHash}`;

  let text = "";
  let keyboard: InlineKeyboard | undefined;

  if (event.type === "SLOT_APPEARED") {
    const isLimited = event.newStatus === "limited";
    const statusIcon = isLimited ? icon("status_limited") : icon("status_available");
    const rawStatusText = stripLeadingEmoji(isLimited
      ? translate(lang, "common.status_limited")
      : translate(lang, "common.status_available")
    );
    const statusBadge = `${statusIcon} ${rawStatusText}`;

    const rawHeader = translate(lang, "alerts.slot_appeared_header", {
      status_icon: statusIcon,
      pool_name: escapeHtml(event.poolName),
    });
    const header = `${icon("event_slot_drop")} ${stripLeadingEmoji(rawHeader)}`;

    const regionLabel = lang === "uk" ? "Регіон" : lang === "ru" ? "Регион" : "Region";
    const statusLabel = lang === "uk" ? "Статус" : lang === "ru" ? "Статус" : "Status";
    const modelsLabel = lang === "uk" ? "Моделі" : lang === "ru" ? "Модели" : "Models";
    const costLabel = lang === "uk" ? "Вартість" : lang === "ru" ? "Стоимость" : "Price";
    const timeLabel = lang === "uk" ? "Час" : lang === "ru" ? "Время" : "Time";
    const calloutText = lang === "uk"
      ? "Слоти розбирають за хвилини! Забронюйте за кнопкою нижче:"
      : lang === "ru"
      ? "Слоты разбирают за минуты! Забронируйте по кнопке ниже:"
      : "Slots sell out fast! Claim using the button below:";

    const hoursLocal = event.hoursUtc ? formatBlockHoursWithLocal(event.block, event.hoursUtc, lang) : "";
    const hoursText = hoursLocal ? ` • <code>${escapeHtml(hoursLocal)}</code>` : "";
    const modelsList = (event.models || []).map((m) => `<code>${escapeHtml(m)}</code>`).join(", ");

    const body = `${getRegionIcon(event.block)} <b>${regionLabel}:</b> ${escapeHtml(blockName)}${hoursText}\n` +
      `${icon("nav_chart")} <b>${statusLabel}:</b> ${statusBadge}\n` +
      `${icon("ai_robot")} <b>${modelsLabel}:</b> ${modelsList}\n` +
      `${icon("price_money")} <b>${costLabel}:</b> <code>$${cleanPriceString(event.newPrice)}/${currencyMonth}</code>\n` +
      `${icon("nav_clock")} <b>${timeLabel}:</b> <code>${timeFormatted} UTC</code>\n\n` +
      `${icon("event_slot_drop")} <i>${calloutText}</i>`;

    text = `${header}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${body}`;

    if (event.analytics?.isBatchDrop) {
      const rawBatch =
        translate(lang, "alerts.tag_multi_region_drop", { count: event.analytics.totalOpenings || 2 }) ||
        "<i>Новий дроп потужностей</i>";
      const batchBadge = `${icon("event_batch_drop")} ${stripLeadingEmoji(rawBatch)}`;
      text = `${batchBadge}\n${text}`;
    } else if (event.analytics?.demandCategory === "hot" && event.analytics.avgLifespanFormatted) {
      const rawHot =
        translate(lang, "alerts.tag_hot_slot_drop", { duration: escapeHtml(event.analytics.avgLifespanFormatted) }) ||
        `<i>Гарячий слот (розбирають за ${escapeHtml(event.analytics.avgLifespanFormatted)})</i>`;
      const hotBadge = `${icon("event_hot_slot")} ${stripLeadingEmoji(rawHot)}`;
      text = `${hotBadge}\n${text}`;
    } else if (cachedDurationFormatted) {
      text += translate(lang, "alerts.analytics_duration_tip", {
        duration: escapeHtml(cachedDurationFormatted),
      });
    }

    const btnLabel = translate(lang, "alerts.btn_claim_slot_block", {
      block_name: blockName,
      price: escapeHtml(cleanPriceString(event.newPrice)),
      currency_month: currencyMonth,
    });

    keyboard = new InlineKeyboard().url(btnLabel, checkoutUrl);
  } else if (event.type === "SLOT_DISAPPEARED") {
    const rawHeader = translate(lang, "alerts.slot_disappeared_header", {
      pool_name: escapeHtml(event.poolName),
    });
    const header = `${icon("event_slot_sold")} ${stripLeadingEmoji(rawHeader)}`;

    const regionLabel = lang === "uk" ? "Регіон" : lang === "ru" ? "Регион" : "Region";
    const closeTimeLabel = lang === "uk" ? "Час закриття" : lang === "ru" ? "Время закрытия" : "Closed at";
    const botNotifyText = lang === "uk"
      ? "Бот миттєво сповістить вас, щойно слот знову стане доступним!"
      : lang === "ru"
      ? "Бот моментально оповестит вас, как только слот снова станет доступен!"
      : "You will be alerted instantly as soon as a slot re-opens!";

    let body = `${getRegionIcon(event.block)} <b>${regionLabel}:</b> ${escapeHtml(blockName)}\n` +
      `${icon("nav_clock")} <b>${closeTimeLabel}:</b> <code>${timeFormatted} UTC</code>\n\n` +
      `${icon("notify_bell_on")} <i>${botNotifyText}</i>`;

    const eta = event.analytics?.eta;
    if (eta) {
      if (eta.isPredictable) {
        let confBadge = translate(lang, "intelligence.conf_low") || "⚪";
        if (eta.confidence === "HIGH") {
          confBadge = `${icon("status_available")} ${stripLeadingEmoji(translate(lang, "intelligence.conf_high") || "Висока точність")}`;
        } else if (eta.confidence === "MEDIUM") {
          confBadge = `${icon("status_partially_available")} ${stripLeadingEmoji(translate(lang, "intelligence.conf_medium") || "Середня точність")}`;
        }
        const cadence = eta.detectedCadenceHours === 24
          ? translate(lang, "intelligence.cadence_daily") || "добовий цикл ~24h"
          : eta.detectedCadenceHours
          ? `~${eta.detectedCadenceHours}h cycle`
          : eta.formattedEtaWindow;
        body += `\n\n${icon("prediction_crystal")} <b>${translate(lang, "intelligence.eta_title") || "Очікувана поява"}:</b> <code>${escapeHtml(cadence)}</code> [${confBadge}]`;
      } else {
        body += `\n\n${icon("prediction_crystal")} <b>${translate(lang, "intelligence.eta_title") || "Прогноз"}:</b> <i>${
          translate(lang, "intelligence.eta_gathering_data", {
            count: eta.sampleCount,
            min: eta.minRequired,
          }) || `Збір статистики (${eta.sampleCount}/${eta.minRequired})`
        }</i>`;
      }
    }

    text = `${header}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${body}`;
  } else if (event.type === "MODEL_UPGRADE_EVENT") {
    const rawHeader = translate(lang, "alerts.model_upgrade_header", {
      pool_name: escapeHtml(event.poolName),
    });
    const header = `${icon("event_model_upgrade")} ${stripLeadingEmoji(rawHeader)}`;
    const diffLines: string[] = [];

    if (event.modelUpgrade) {
      for (const up of event.modelUpgrade.upgraded) {
        diffLines.push(
          translate(lang, "alerts.model_item_upgraded", {
            old_model: escapeHtml(up.previousModelName || ""),
            new_model: escapeHtml(up.modelName),
          })
        );
      }
      for (const add of event.modelUpgrade.added) {
        diffLines.push(
          translate(lang, "alerts.model_item_added", {
            model_name: escapeHtml(add.modelName),
          })
        );
      }
      for (const rem of event.modelUpgrade.removed) {
        diffLines.push(
          translate(lang, "alerts.model_item_removed", {
            model_name: escapeHtml(rem.modelName),
          })
        );
      }
    }

    const allModelsList = (event.models || []).map((m) => `${getModel3DIcon(m)} <code>${escapeHtml(m)}</code>`).join(", ");
    const updatedModelsTitle = lang === "uk"
      ? `У пулі оновлено конфігурацію нейромереж:`
      : lang === "ru"
      ? `В пуле обновлена конфигурация нейросетей:`
      : `Neural network configuration updated:`;
    const allModelsLabel = lang === "uk"
      ? `Усі активні моделі (${(event.models || []).length}):`
      : lang === "ru"
      ? `Все активные модели (${(event.models || []).length}):`
      : `All active models (${(event.models || []).length}):`;
    const upgradeFreeText = lang === "uk"
      ? "Оновлені моделі доступні за поточною підпискою без доплат!"
      : lang === "ru"
      ? "Обновленные модели доступны по текущей подписке без доплат!"
      : "Upgraded models are available under existing plan at no extra charge!";

    const body = `${updatedModelsTitle}\n\n` +
      `${diffLines.length > 0 ? diffLines.join("\n") : "• " + allModelsList}\n\n` +
      `${icon("ai_robot")} <b>${allModelsLabel}</b>\n` +
      `${allModelsList}\n\n` +
      `${icon("event_slot_drop")} <i>${upgradeFreeText}</i>`;

    text = `${header}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${body}`;
    keyboard = new InlineKeyboard().url(
      translate(lang, "common.open_site"),
      poolUrl
    );
  } else if (event.type === "SLOT_PRICE_CHANGED") {
    const isDiscount = (event.slotPrice?.priceDelta || 0) < 0;
    const trendIcon = isDiscount ? icon("event_price_drop") : icon("event_price_hike");
    const rawHeader = translate(lang, "alerts.slot_price_changed_header", {
      trend_icon: trendIcon,
      pool_name: escapeHtml(event.poolName),
    });
    const header = `${trendIcon} ${stripLeadingEmoji(rawHeader)}`;

    const deltaBadge = event.slotPrice
      ? formatPriceDeltaBadge(event.slotPrice.priceDelta, event.slotPrice.percentageDelta, lang)
      : "";

    const cleanNewPrice = cleanPriceString(event.newPrice);
    const newPriceNum = parseFloat(cleanNewPrice) || 0;
    const ratingBadge = formatPriceRatingBadge(event.slotPrice?.priceAnalytics, newPriceNum, lang);

    const regionLabel = lang === "uk" ? "Регіон" : lang === "ru" ? "Регион" : "Region";
    const priceLabel = lang === "uk" ? "Ціна слота" : lang === "ru" ? "Цена слота" : "Slot Price";
    const lockPriceText = lang === "uk"
      ? "Зафіксувати ціну можна за посиланням нижче:"
      : lang === "ru"
      ? "Зафиксировать цену можно по ссылке ниже:"
      : "Lock in this rate via the button below:";

    const hoursLocal = event.hoursUtc ? formatBlockHoursWithLocal(event.block, event.hoursUtc, lang) : "";
    const hoursText = hoursLocal ? ` <code>(${escapeHtml(hoursLocal)})</code>` : "";
    const cleanOld = cleanPriceString(event.previousPrice);

    const body = `${getRegionIcon(event.block)} <b>${regionLabel}:</b> ${escapeHtml(blockName)}${hoursText}\n` +
      `${icon("price_money")} <b>${priceLabel}:</b> <s>$${cleanOld}</s> ➔ <b>$${cleanNewPrice}/${currencyMonth}</b>\n` +
      `${deltaBadge}${ratingBadge ? `\n${ratingBadge}` : ""}\n\n` +
      `${icon("nav_link")} <i>${lockPriceText}</i>`;

    text = `${header}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${body}`;

    const btnLabel = translate(lang, "alerts.btn_claim_slot_block", {
      block_name: blockName,
      price: escapeHtml(cleanNewPrice),
      currency_month: currencyMonth,
    });

    keyboard = new InlineKeyboard().url(btnLabel, checkoutUrl);
  } else if (event.type === "POOL_BASE_PRICE_CHANGED" || event.type === "PRICE_CHANGED") {
    const isDiscount = (event.basePrice?.priceDelta || 0) < 0;
    const trendIcon = isDiscount ? icon("event_price_drop") : icon("event_price_hike");
    const rawHeader = translate(lang, "alerts.pool_base_price_header", {
      trend_icon: trendIcon,
      pool_name: escapeHtml(event.poolName),
    });
    const header = `${trendIcon} ${stripLeadingEmoji(rawHeader)}`;

    const deltaBadge = event.basePrice
      ? formatPriceDeltaBadge(event.basePrice.priceDelta, event.basePrice.percentageDelta, lang)
      : "";

    const cleanNewPrice = cleanPriceString(event.newPrice);
    const newPriceNum = parseFloat(cleanNewPrice) || 0;
    const ratingBadge = formatPriceRatingBadge(event.basePrice?.priceAnalytics, newPriceNum, lang);

    const baseLabel = lang === "uk" ? "Базовий тариф пулу" : lang === "ru" ? "Базовый тариф пула" : "Pool Base Rate";
    const modelsLabel = lang === "uk" ? "Моделі" : lang === "ru" ? "Модели" : "Models";
    const allSubsText = lang === "uk"
      ? "Ціна поширюється на всі нові підписки цього тарифу!"
      : lang === "ru"
      ? "Цена действует для всех новых подписок этого тарифа!"
      : "Applies to all new subscriptions for this pool!";

    const cleanOld = cleanPriceString(event.previousPrice);
    const modelsList = (event.models || []).map((m) => `${getModel3DIcon(m)} <code>${escapeHtml(m)}</code>`).join(", ");

    const body = `${icon("price_money")} <b>${baseLabel}:</b> <s>$${cleanOld}</s> ➔ <b>$${cleanNewPrice}/${currencyMonth}</b>\n` +
      `${deltaBadge}${ratingBadge ? `\n${ratingBadge}` : ""}\n` +
      `${icon("ai_robot")} <b>${modelsLabel}:</b> ${modelsList}\n\n` +
      `${icon("event_slot_drop")} <i>${allSubsText}</i>`;

    text = `${header}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${body}`;
    keyboard = new InlineKeyboard().url(
      translate(lang, "common.open_site"),
      poolUrl
    );
  } else if (event.type === "TIER_UPDATED_EVENT") {
    const rawHeader = translate(lang, "alerts.tier_updated_header", {
      pool_name: escapeHtml(event.poolName),
    });
    const header = `${icon("event_tier_update")} ${stripLeadingEmoji(rawHeader)}`;
    const diffLines: string[] = [];
    if (event.tierUpdate?.newDescription) {
      diffLines.push(
        translate(lang, "alerts.tier_desc_change", {
          new_description: escapeHtml(event.tierUpdate.newDescription),
        })
      );
    }
    if (event.tierUpdate?.newAnnualDiscount !== undefined) {
      diffLines.push(
        translate(lang, "alerts.tier_discount_change", {
          old_discount: (((event.tierUpdate.previousAnnualDiscount ?? 0.15)) * 100).toFixed(0),
          new_discount: ((event.tierUpdate.newAnnualDiscount * 100)).toFixed(0),
        })
      );
    }
    if (event.tierUpdate?.newInfraSpec) {
      diffLines.push(
        translate(lang, "alerts.tier_infra_change", {
          new_infra: escapeHtml(event.tierUpdate.newInfraSpec),
        })
      );
    }
    if (event.tierUpdate?.newManualProvisioning !== undefined) {
      const provText = event.tierUpdate.newManualProvisioning
        ? lang === "uk"
          ? "Ручна видача"
          : lang === "ru"
          ? "Ручная выдача"
          : "Manual"
        : lang === "uk"
        ? "Миттєва авто-видача"
        : lang === "ru"
        ? "Мгновенная авто-выдача"
        : "Instant Automatic";
      diffLines.push(
        translate(lang, "alerts.tier_prov_change", {
          provisioning: escapeHtml(provText),
        })
      );
    }

    const timeLabel = lang === "uk" ? "Час" : lang === "ru" ? "Время" : "Time";
    const body = `${diffLines.join("\n")}\n\n` +
      `${icon("nav_clock")} <b>${timeLabel}:</b> <code>${timeFormatted} UTC</code>`;

    text = `${header}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${body}`;
    keyboard = new InlineKeyboard().url(
      translate(lang, "common.open_site"),
      poolUrl
    );
  } else if (event.type === "NEW_POOL_EVENT") {
    const rawHeader = translate(lang, "alerts.new_pool_header", {
      pool_name: escapeHtml(event.poolName),
    });
    const header = `${icon("event_new_pool")} ${stripLeadingEmoji(rawHeader)}`;

    const newPoolDesc = lang === "uk"
      ? "На платформі CheapestInference запущено новий пул!"
      : lang === "ru"
      ? "На платформе CheapestInference запущен новый пул!"
      : "A new compute pool has launched on CheapestInference!";
    const modelsLabel = lang === "uk" ? "Моделі" : lang === "ru" ? "Модели" : "Models";
    const costLabel = lang === "uk" ? "Вартість" : lang === "ru" ? "Стоимость" : "Pricing";
    const descLabel = lang === "uk" ? "Опис" : lang === "ru" ? "Описание" : "Description";
    const autoSubText = lang === "uk"
      ? "Пул автоматично підключено до моніторингу та меню сповіщень!"
      : lang === "ru"
      ? "Пул автоматически подключен к мониторингу и меню уведомлений!"
      : "Pool is automatically connected to live monitoring and alerts!";

    const modelsList = (event.models || []).map((m) => `${getModel3DIcon(m)} <code>${escapeHtml(m)}</code>`).join(", ");

    const body = `${newPoolDesc}\n\n` +
      `${icon("ai_robot")} <b>${modelsLabel}:</b> ${modelsList}\n` +
      `${icon("price_money")} <b>${costLabel}:</b> від <code>$${cleanPriceString(event.newPrice)}/${currencyMonth}</code>\n` +
      `${icon("event_tier_update")} <b>${descLabel}:</b> <i>${escapeHtml((event.metadata?.description as string) || "High-performance compute pool")}</i>\n\n` +
      `${icon("event_slot_drop")} <i>${autoSubText}</i>`;

    text = `${header}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${body}`;
    keyboard = new InlineKeyboard().url(
      translate(lang, "common.open_site"),
      poolUrl
    );
  } else {
    text = `🚨 <b>CheapestInference Alert</b>\n\nPool: <b>${escapeHtml(event.poolName)}</b> (${escapeHtml(blockName)})\nStatus: <b>${escapeHtml(event.newStatus || "updated")}</b>`;
  }

  return {
    id: crypto.randomUUID(),
    telegramId: user.telegramId,
    userId: user.userId,
    poolSlug: event.poolSlug,
    blockId: event.block,
    eventType: event.type,
    text: truncateToTelegramLimit(text),
    keyboard,
    isMuted: user.isMuted,
    priority,
    retries: 0,
    enqueuedAt: Date.now(),
  };
}

export function formatBundledAlertMessage(
  user: PackedUserProfile,
  matchedEvents: Array<{ event: DiffEvent; priority: BroadcastPriority }>
): OutgoingAlertMessage {
  const lang = user.language;
  const count = matchedEvents.length;
  const timeFormatted = new Date().toISOString().replace("T", " ").substring(0, 19);
  const currencyMonth = translate(lang, "common.currency_month") || "mo";

  const rawTitle =
    translate(lang, "alerts.batch_title", { count }) ||
    `<b>CheapestInference — Slot Updates (${count})</b>`;

  const sectionLines: string[] = [];
  const keyboard = new InlineKeyboard();

  let highestPriority: BroadcastPriority = "P3";
  const pRank: Record<BroadcastPriority, number> = { P0: 4, P1: 3, P2: 2, P3: 1 };
  for (const item of matchedEvents) {
    if (pRank[item.priority] > pRank[highestPriority]) {
      highestPriority = item.priority;
    }
  }

  interface BundleButtonCandidate {
    priority: number; // 1 = Claim, 2 = SlotPrice, 3 = BasePrice, 4 = PoolOverview
    label: string;
    url: string;
    poolSlug: string;
    isSpecificAction: boolean;
  }

  const candidates: BundleButtonCandidate[] = [];

  const allSoldOut = matchedEvents.every((e) => e.event.type === "SLOT_DISAPPEARED");
  const allSamePool = matchedEvents.every((e) => e.event.poolSlug === matchedEvents[0].event.poolSlug);
  const regionLabel = lang === "uk" ? "Регіон" : lang === "ru" ? "Регион" : "Region";
  const statusSoldOut = stripLeadingEmoji(translate(lang, "common.status_sold_out"));
  const botNotifyText = lang === "uk"
    ? "Бот миттєво сповістить вас, щойно слоти знову стануть доступними!"
    : lang === "ru"
    ? "Бот моментально оповестит вас, как только слоты снова станут доступны!"
    : "You will be alerted instantly as soon as slots re-open!";

  let title = `${icon("event_batch_drop")} ${stripLeadingEmoji(rawTitle)}`;

  if (allSoldOut && allSamePool) {
    const pName = escapeHtml(matchedEvents[0].event.poolName);
    title = lang === "uk"
      ? `${icon("event_slot_sold")} <b>СЛОТИ РОЗПРОДАНО • ${pName}</b>`
      : lang === "ru"
      ? `${icon("event_slot_sold")} <b>СЛОТЫ РАСПРОДАНЫ • ${pName}</b>`
      : `${icon("event_slot_sold")} <b>SLOTS SOLD OUT • ${pName}</b>`;
  } else if (allSoldOut) {
    title = lang === "uk"
      ? `${icon("event_slot_sold")} <b>СЛОТИ РОЗПРОДАНО (${count})</b>`
      : lang === "ru"
      ? `${icon("event_slot_sold")} <b>СЛОТЫ РАСПРОДАНЫ (${count})</b>`
      : `${icon("event_slot_sold")} <b>SLOTS SOLD OUT (${count})</b>`;
  }

  for (const { event } of matchedEvents) {
    const blockName = resolveBlockName(event.block, lang);
    const blockHash = event.block && event.block !== "ALL" ? `#${event.block}` : "";
    const checkoutUrl = `https://cheapestinference.com/pools/${event.poolSlug}${blockHash}`;
    const poolUrl = `https://cheapestinference.com/pools/${event.poolSlug}`;
    const hoursLocal = event.hoursUtc ? formatBlockHoursWithLocal(event.block, event.hoursUtc, lang) : "";
    const hoursText = hoursLocal ? ` <code>(${escapeHtml(hoursLocal)})</code>` : "";

    if (event.type === "SLOT_APPEARED") {
      const cleanPrice = cleanPriceString(event.newPrice);
      const lifespanBadge = event.analytics?.avgLifespanFormatted
        ? ` ${event.analytics.demandCategory === "hot" ? icon("event_hot_slot") : icon("event_slot_drop")} <code>${escapeHtml(event.analytics.avgLifespanFormatted)}</code>`
        : "";
      sectionLines.push(
        `${icon("status_available")} <b>${escapeHtml(event.poolName)} • ${escapeHtml(blockName)}</b>${lifespanBadge}\n` +
        `${icon("price_money")} <code>$${escapeHtml(cleanPrice)}/${currencyMonth}</code> | ${icon("nav_clock")} <code>${escapeHtml(event.hoursUtc)}</code>\n` +
        `${icon("ai_robot")} ${(event.models || []).map((m) => `<code>${escapeHtml(m)}</code>`).join(", ")}`
      );

      candidates.push({
        priority: 1,
        label: `⚡ ${event.poolSlug.toUpperCase()} (${blockName}) • $${cleanPrice}`,
        url: checkoutUrl,
        poolSlug: event.poolSlug,
        isSpecificAction: true,
      });
    } else if (event.type === "SLOT_DISAPPEARED") {
      if (allSamePool) {
        sectionLines.push(
          `${getRegionIcon(event.block)} <b>${regionLabel}:</b> ${escapeHtml(blockName)}${hoursText} — ${icon("status_sold_out")} <i>${statusSoldOut}</i>`
        );
      } else {
        sectionLines.push(
          `${icon("event_slot_sold")} <b>${escapeHtml(event.poolName)}</b>\n` +
          `  • ${getRegionIcon(event.block)} <b>${escapeHtml(blockName)}:</b> ${icon("status_sold_out")} <i>${statusSoldOut}</i>`
        );
      }
      candidates.push({
        priority: 4,
        label: `🔍 ${event.poolSlug.toUpperCase()}`,
        url: poolUrl,
        poolSlug: event.poolSlug,
        isSpecificAction: false,
      });
    } else if (event.type === "MODEL_UPGRADE_EVENT") {
      const upgradeTitle = translate(lang, "alerts.bundle_title_models") || "Model Upgrade";
      sectionLines.push(
        `${icon("event_model_upgrade")} <b>${escapeHtml(event.poolName)} • ${upgradeTitle}</b>\n` +
        `${icon("ai_robot")} ${(event.models || []).map((m) => `<code>${escapeHtml(m)}</code>`).join(", ")}`
      );
      candidates.push({
        priority: 4,
        label: `🔍 ${event.poolSlug.toUpperCase()}`,
        url: poolUrl,
        poolSlug: event.poolSlug,
        isSpecificAction: false,
      });
    } else if (event.type === "SLOT_PRICE_CHANGED") {
      const deltaStr = event.slotPrice
        ? ` (${formatPriceDeltaBadge(event.slotPrice.priceDelta, event.slotPrice.percentageDelta, lang)})`
        : "";
      const cleanOld = cleanPriceString(event.previousPrice);
      const cleanNew = cleanPriceString(event.newPrice);
      const hoursStr = event.hoursUtc ? ` | ${icon("nav_clock")} <code>${escapeHtml(event.hoursUtc)}</code>` : "";
      sectionLines.push(
        `${icon("price_tag")} <b>${escapeHtml(event.poolName)} • ${escapeHtml(blockName)}</b>\n` +
        `${icon("price_money")} <s>$${escapeHtml(cleanOld)}</s> ➔ <b>$${escapeHtml(cleanNew)}/${currencyMonth}</b>${deltaStr}${hoursStr}`
      );
      candidates.push({
        priority: 2,
        label: `🏷 ${event.poolSlug.toUpperCase()} (${blockName}) • $${cleanNew}`,
        url: checkoutUrl,
        poolSlug: event.poolSlug,
        isSpecificAction: true,
      });
    } else if (event.type === "POOL_BASE_PRICE_CHANGED" || event.type === "PRICE_CHANGED") {
      const deltaStr = event.basePrice
        ? ` (${formatPriceDeltaBadge(event.basePrice.priceDelta, event.basePrice.percentageDelta, lang)})`
        : "";
      const cleanOld = cleanPriceString(event.previousPrice);
      const cleanNew = cleanPriceString(event.newPrice);
      const tariffBadge = translate(lang, "alerts.bundle_title_base_price") || "Base Tariff";
      sectionLines.push(
        `${icon("price_money")} <b>${escapeHtml(event.poolName)} • ${tariffBadge}</b>\n` +
        `${icon("price_dollar")} <s>$${escapeHtml(cleanOld)}</s> ➔ <b>$${escapeHtml(cleanNew)}/${currencyMonth}</b>${deltaStr}\n` +
        `${icon("ai_robot")} ${(event.models || []).map((m) => `<code>${escapeHtml(m)}</code>`).join(", ")}`
      );
      candidates.push({
        priority: 3,
        label: `💰 ${event.poolSlug.toUpperCase()} • $${cleanNew}`,
        url: poolUrl,
        poolSlug: event.poolSlug,
        isSpecificAction: false,
      });
    } else if (event.type === "TIER_UPDATED_EVENT") {
      const tierTitle = translate(lang, "alerts.bundle_title_tier") || "Tier Specification Updated";
      sectionLines.push(`${icon("event_tier_update")} <b>${escapeHtml(event.poolName)} • ${tierTitle}</b>`);
      candidates.push({
        priority: 4,
        label: `🔍 ${event.poolSlug.toUpperCase()}`,
        url: poolUrl,
        poolSlug: event.poolSlug,
        isSpecificAction: false,
      });
    } else if (event.type === "NEW_POOL_EVENT") {
      const newPoolTitle = translate(lang, "alerts.bundle_title_new_pool") || "New Pool Launched";
      sectionLines.push(
        `${icon("event_new_pool")} <b>${escapeHtml(event.poolName)} • ${newPoolTitle}</b>\n` +
        `🤖 ${(event.models || []).map((m) => `<code>${escapeHtml(m)}</code>`).join(", ")}`
      );
      candidates.push({
        priority: 4,
        label: `🔍 ${event.poolSlug.toUpperCase()}`,
        url: poolUrl,
        poolSlug: event.poolSlug,
        isSpecificAction: false,
      });
    } else {
      sectionLines.push(`• <b>${escapeHtml(event.poolName)}</b> (${escapeHtml(blockName)}): ${escapeHtml(event.newStatus || "updated")}`);
    }
  }

  // 2. Sort by priority ASC (High urgency checkout buttons first)
  candidates.sort((a, b) => a.priority - b.priority);

  // 3. Deduplicate by URL and by Pool Slug
  const selectedButtons: BundleButtonCandidate[] = [];
  const seenUrls = new Set<string>();
  const poolsWithSpecificAction = new Set<string>();
  const poolsWithGenericButton = new Set<string>();
  const MAX_BUNDLE_BUTTONS = 4;

  for (const candidate of candidates) {
    if (selectedButtons.length >= MAX_BUNDLE_BUTTONS) break;
    if (seenUrls.has(candidate.url)) continue;

    if (!candidate.isSpecificAction) {
      if (poolsWithSpecificAction.has(candidate.poolSlug)) continue;
      if (poolsWithGenericButton.has(candidate.poolSlug)) continue;
    }

    selectedButtons.push(candidate);
    seenUrls.add(candidate.url);
    if (candidate.isSpecificAction) {
      poolsWithSpecificAction.add(candidate.poolSlug);
    } else {
      poolsWithGenericButton.add(candidate.poolSlug);
    }
  }

  // 4. Construct InlineKeyboard with smart 1-col / 2-col row packing
  if (selectedButtons.length === 0) {
    keyboard.url(translate(lang, "common.open_site"), "https://cheapestinference.com/pools");
  } else {
    let pendingShortBtn: BundleButtonCandidate | null = null;
    for (const btn of selectedButtons) {
      const isShort = btn.label.length <= 18;
      if (isShort) {
        if (pendingShortBtn) {
          keyboard.url(pendingShortBtn.label, pendingShortBtn.url)
                  .url(btn.label, btn.url)
                  .row();
          pendingShortBtn = null;
        } else {
          pendingShortBtn = btn;
        }
      } else {
        if (pendingShortBtn) {
          keyboard.url(pendingShortBtn.label, pendingShortBtn.url).row();
          pendingShortBtn = null;
        }
        keyboard.url(btn.label, btn.url).row();
      }
    }
    if (pendingShortBtn) {
      keyboard.url(pendingShortBtn.label, pendingShortBtn.url).row();
    }
  }

  const footer =
    lang === "uk"
      ? `${icon("nav_clock")} <i>Час оновлення: ${timeFormatted} UTC</i>`
      : lang === "ru"
      ? `${icon("nav_clock")} <i>Время обновления: ${timeFormatted} UTC</i>`
      : `${icon("nav_clock")} <i>Updated at: ${timeFormatted} UTC</i>`;

  const bodyContent = allSoldOut
    ? `${sectionLines.join(allSamePool ? "\n" : "\n───\n")}\n\n${icon("notify_bell_on")} <i>${botNotifyText}</i>`
    : sectionLines.join("\n───\n");

  const text = `${title}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${bodyContent}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${footer}`;
  const firstEvent = matchedEvents[0].event;

  return {
    id: crypto.randomUUID(),
    telegramId: user.telegramId,
    userId: user.userId,
    poolSlug: firstEvent.poolSlug,
    blockId: "BUNDLE",
    eventType: "BUNDLE_EVENT",
    text: truncateToTelegramLimit(text),
    keyboard: (selectedButtons.length > 0 || keyboard.inline_keyboard.length > 0) ? keyboard : undefined,
    isMuted: user.isMuted,
    priority: highestPriority,
    retries: 0,
    enqueuedAt: Date.now(),
  };
}

export function createTestAlertMessage(
  profile: PackedUserProfile,
  eventType: "slot" | "model" | "bundle" = "slot"
): OutgoingAlertMessage {
  if (eventType === "slot") {
    const event: DiffEvent = {
      id: crypto.randomUUID(),
      type: "SLOT_APPEARED",
      poolSlug: "frontier",
      poolName: "Frontier Pool",
      block: "europe",
      models: ["deepseek-r1", "qwen-2.5-coder-32b", "glm-5.3"],
      hoursUtc: "08:00 – 16:00 UTC",
      newPrice: "149",
      newStatus: "available",
      timestamp: Date.now(),
    };
    return formatAlertMessage(profile, event, "P0");
  } else if (eventType === "bundle") {
    const events: DiffEvent[] = [
      {
        id: crypto.randomUUID(),
        type: "SLOT_APPEARED",
        poolSlug: "frontier",
        poolName: "Frontier Pool",
        block: "europe",
        models: ["deepseek-r1", "glm-5.3"],
        hoursUtc: "08:00 – 16:00 UTC",
        newPrice: "149",
        newStatus: "available",
        timestamp: Date.now(),
      },
      {
        id: crypto.randomUUID(),
        type: "SLOT_APPEARED",
        poolSlug: "core",
        poolName: "Core Pool",
        block: "asia",
        models: ["deepseek-v3", "kimi-k2.5"],
        hoursUtc: "00:00 – 08:00 UTC",
        newPrice: "49",
        newStatus: "available",
        timestamp: Date.now(),
      },
    ];
    return formatBundledAlertMessage(profile, [
      { event: events[0], priority: "P0" },
      { event: events[1], priority: "P0" },
    ]);
  } else {
    const event: DiffEvent = {
      id: crypto.randomUUID(),
      type: "MODEL_UPGRADE_EVENT",
      poolSlug: "flagship",
      poolName: "Flagship Pool",
      block: "ALL",
      models: ["claude-3-7-sonnet", "deepseek-r1"],
      hoursUtc: "",
      timestamp: Date.now(),
      modelUpgrade: {
        added: [{ type: "added", modelName: "deepseek-r1", family: "deepseek" }],
        upgraded: [{ type: "upgraded", modelName: "claude-3-7-sonnet", previousModelName: "claude-3-5-sonnet", family: "claude" }],
        removed: [],
        allActiveModels: ["claude-3-7-sonnet", "deepseek-r1"],
      },
    };
    return formatAlertMessage(profile, event, "P0");
  }
}
