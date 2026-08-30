/**
 * src/bot/notifier/formatters/singleAlertFormatter.ts
 * Single DiffEvent Alert Formatter & Envelope Generator
 */

import { InlineKeyboard } from "grammy";
import { DiffEvent } from "../../../types/domain.js";
import { translate, escapeHtml, SupportedLanguage, stripLeadingEmoji } from "../../../i18n/index.js";
import { PackedUserProfile } from "../subscriberIndex.js";
import { truncateToTelegramLimit } from "../htmlTagBalancer.js";
import { icon, getModel3DIcon } from "../../views/iconTheme.js";
import { formatBlockHoursWithLocal } from "../../views/timezoneHelper.js";
import {
  cleanPoolTitle,
  cleanPriceString,
  formatPriceDeltaBadge,
  formatPriceRatingBadge,
  resolveBlockName,
  getRegionIcon,
} from "./priceBadgeHelper.js";
import { buildSingleAlertKeyboard } from "../keyboards/alertKeyboardBuilder.js";

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
  mediaType?: "text" | "photo" | "video" | "document" | "animation";
  fileId?: string;
  language?: string;
}

export function formatSingleAlertMessage(
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

  if (event.type === "SLOT_APPEARED") {
    const isLimited = event.newStatus === "limited";
    const statusIcon = isLimited ? icon("status_limited") : icon("status_available");
    const rawStatusText = stripLeadingEmoji(
      isLimited ? translate(lang, "common.status_limited") : translate(lang, "common.status_available")
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
    const calloutText =
      lang === "uk"
        ? "Слоти розбирають за хвилини! Забронюйте за кнопкою нижче:"
        : lang === "ru"
        ? "Слоты разбирают за минуты! Забронируйте по кнопке ниже:"
        : "Slots sell out fast! Claim using the button below:";

    const hoursLocal = event.hoursUtc ? formatBlockHoursWithLocal(event.block, event.hoursUtc, lang) : "";
    const hoursText = hoursLocal ? ` • <code>${escapeHtml(hoursLocal)}</code>` : "";
    const modelsList = (event.models || []).map((m) => `<code>${escapeHtml(m)}</code>`).join(", ");

    const body =
      `${getRegionIcon(event.block)} <b>${regionLabel}:</b> ${escapeHtml(blockName)}${hoursText}\n` +
      `${icon("nav_chart")} <b>${statusLabel}:</b> ${statusBadge}\n` +
      `${icon("ai_robot")} <b>${modelsLabel}:</b> ${modelsList}\n` +
      `${icon("price_money")} <b>${costLabel}:</b> <code>$${cleanPriceString(event.newPrice)}/${currencyMonth}</code>\n` +
      `${icon("nav_clock")} <b>${timeLabel}:</b> <code>${timeFormatted} UTC</code>\n\n` +
      `${icon("event_slot_drop")} <i>${calloutText}</i>`;

    text = `${header}\n\n${body}`;

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
  } else if (event.type === "SLOT_DISAPPEARED") {
    const cleanName = cleanPoolTitle(event.poolName, event.poolSlug);
    const rawHeader = translate(lang, "alerts.slot_disappeared_header", {
      pool_name: escapeHtml(cleanName),
    });
    const header = `${icon("event_slot_sold")} ${stripLeadingEmoji(rawHeader)}`;

    const regionLabel = lang === "uk" ? "Регіон" : lang === "ru" ? "Регион" : "Region";
    const closeTimeLabel = lang === "uk" ? "Час закриття" : lang === "ru" ? "Время закрытия" : "Closed at";
    const botNotifyText =
      lang === "uk"
        ? "Бот миттєво сповістить вас, щойно слот знову стане доступним!"
        : lang === "ru"
        ? "Бот моментально оповестит вас, как только слот снова станет доступен!"
        : "You will be alerted instantly as soon as a slot re-opens!";

    let body =
      `${getRegionIcon(event.block)} <b>${regionLabel}:</b> ${escapeHtml(blockName)}\n` +
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
        const cadence =
          eta.detectedCadenceHours === 24
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

    text = `${header}\n\n${body}`;
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
    const updatedModelsTitle =
      lang === "uk"
        ? `У пулі оновлено конфігурацію нейромереж:`
        : lang === "ru"
        ? `В пуле обновлена конфигурация нейросетей:`
        : `Neural network configuration updated:`;
    const allModelsLabel =
      lang === "uk"
        ? `Усі активні моделі (${(event.models || []).length}):`
        : lang === "ru"
        ? `Все активные модели (${(event.models || []).length}):`
        : `All active models (${(event.models || []).length}):`;
    const upgradeFreeText =
      lang === "uk"
        ? "Оновлені моделі доступні за поточною підпискою без доплат!"
        : lang === "ru"
        ? "Обновленные модели доступны по текущей подписке без доплат!"
        : "Upgraded models are available under existing plan at no extra charge!";

    const body =
      `${updatedModelsTitle}\n\n` +
      `${diffLines.length > 0 ? diffLines.join("\n") : "• " + allModelsList}\n\n` +
      `${icon("ai_robot")} <b>${allModelsLabel}</b>\n` +
      `${allModelsList}\n\n` +
      `${icon("event_slot_drop")} <i>${upgradeFreeText}</i>`;

    text = `${header}\n\n${body}`;
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
    const lockPriceText =
      lang === "uk"
        ? "Зафіксувати ціну можна за посиланням нижче:"
        : lang === "ru"
        ? "Зафиксировать цену можно по ссылке ниже:"
        : "Lock in this rate via the button below:";

    const hoursLocal = event.hoursUtc ? formatBlockHoursWithLocal(event.block, event.hoursUtc, lang) : "";
    const hoursText = hoursLocal ? ` <code>(${escapeHtml(hoursLocal)})</code>` : "";
    const cleanOld = cleanPriceString(event.previousPrice);

    const body =
      `${getRegionIcon(event.block)} <b>${regionLabel}:</b> ${escapeHtml(blockName)}${hoursText}\n` +
      `${icon("price_money")} <b>${priceLabel}:</b> <s>$${cleanOld}</s> ➔ <b>$${cleanNewPrice}/${currencyMonth}</b>\n` +
      `${deltaBadge}${ratingBadge ? `\n${ratingBadge}` : ""}\n\n` +
      `${icon("nav_link")} <i>${lockPriceText}</i>`;

    text = `${header}\n\n${body}`;
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
    const allSubsText =
      lang === "uk"
        ? "Ціна поширюється на всі нові підписки цього тарифу!"
        : lang === "ru"
        ? "Цена действует для всех новых подписок этого тарифа!"
        : "Applies to all new subscriptions for this pool!";

    const cleanOld = cleanPriceString(event.previousPrice);
    const modelsList = (event.models || []).map((m) => `${getModel3DIcon(m)} <code>${escapeHtml(m)}</code>`).join(", ");

    const body =
      `${icon("price_money")} <b>${baseLabel}:</b> <s>$${cleanOld}</s> ➔ <b>$${cleanNewPrice}/${currencyMonth}</b>\n` +
      `${deltaBadge}${ratingBadge ? `\n${ratingBadge}` : ""}\n` +
      `${icon("ai_robot")} <b>${modelsLabel}:</b> ${modelsList}\n\n` +
      `${icon("event_slot_drop")} <i>${allSubsText}</i>`;

    text = `${header}\n\n${body}`;
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
          old_discount: ((event.tierUpdate.previousAnnualDiscount ?? 0.15) * 100).toFixed(0),
          new_discount: (event.tierUpdate.newAnnualDiscount * 100).toFixed(0),
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
    const body =
      `${diffLines.join("\n")}\n\n` +
      `${icon("nav_clock")} <b>${timeLabel}:</b> <code>${timeFormatted} UTC</code>`;

    text = `${header}\n\n${body}`;
  } else if (event.type === "NEW_POOL_EVENT") {
    const rawHeader = translate(lang, "alerts.new_pool_header", {
      pool_name: escapeHtml(event.poolName),
    });
    const header = `${icon("event_new_pool")} ${stripLeadingEmoji(rawHeader)}`;

    const newPoolDesc =
      lang === "uk"
        ? "На платформі CheapestInference запущено новий пул!"
        : lang === "ru"
        ? "На платформе CheapestInference запущен новый пул!"
        : "A new compute pool has launched on CheapestInference!";
    const modelsLabel = lang === "uk" ? "Моделі" : lang === "ru" ? "Модели" : "Models";
    const costLabel = lang === "uk" ? "Вартість" : lang === "ru" ? "Стоимость" : "Pricing";
    const descLabel = lang === "uk" ? "Опис" : lang === "ru" ? "Описание" : "Description";
    const autoSubText =
      lang === "uk"
        ? "Пул автоматично підключено до моніторингу та меню сповіщень!"
        : lang === "ru"
        ? "Пул автоматически подключен к мониторингу и меню уведомлений!"
        : "Pool is automatically connected to live monitoring and alerts!";

    const modelsList = (event.models || []).map((m) => `${getModel3DIcon(m)} <code>${escapeHtml(m)}</code>`).join(", ");

    const body =
      `${newPoolDesc}\n\n` +
      `${icon("ai_robot")} <b>${modelsLabel}:</b> ${modelsList}\n` +
      `${icon("price_money")} <b>${costLabel}:</b> від <code>$${cleanPriceString(event.newPrice)}/${currencyMonth}</code>\n` +
      `${icon("event_tier_update")} <b>${descLabel}:</b> <i>${escapeHtml((event.metadata?.description as string) || "High-performance compute pool")}</i>\n\n` +
      `${icon("event_slot_drop")} <i>${autoSubText}</i>`;

    text = `${header}\n\n${body}`;
  } else {
    text = `🚨 <b>CheapestInference Alert</b>\n\nPool: <b>${escapeHtml(event.poolName)}</b> (${escapeHtml(blockName)})\nStatus: <b>${escapeHtml(event.newStatus || "updated")}</b>`;
  }

  const keyboard = buildSingleAlertKeyboard(event, lang, poolUrl, checkoutUrl);

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
