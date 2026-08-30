/**
 * src/bot/notifier/formatters/bundleAlertFormatter.ts
 * Multi-Region & Multi-Pool Alert Bundling Engine
 */

import { DiffEvent } from "../../../types/domain.js";
import { translate, escapeHtml, stripLeadingEmoji } from "../../../i18n/index.js";
import { PackedUserProfile } from "../subscriberIndex.js";
import { truncateToTelegramLimit } from "../htmlTagBalancer.js";
import { icon } from "../../views/iconTheme.js";
import { formatBlockHoursWithLocal } from "../../views/timezoneHelper.js";
import {
  cleanPoolTitle,
  cleanPriceString,
  formatPriceDeltaBadge,
  resolveBlockName,
  getRegionIcon,
} from "./priceBadgeHelper.js";
import {
  BundleButtonCandidate,
  buildBundleAlertKeyboard,
} from "../keyboards/alertKeyboardBuilder.js";
import { BroadcastPriority, OutgoingAlertMessage, formatSingleAlertMessage } from "./singleAlertFormatter.js";

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
  const candidates: BundleButtonCandidate[] = [];

  let highestPriority: BroadcastPriority = "P3";
  const pRank: Record<BroadcastPriority, number> = { P0: 4, P1: 3, P2: 2, P3: 1 };
  for (const item of matchedEvents) {
    if (pRank[item.priority] > pRank[highestPriority]) {
      highestPriority = item.priority;
    }
  }

  const allSoldOut = matchedEvents.every((e) => e.event.type === "SLOT_DISAPPEARED");
  const allSamePool = matchedEvents.every((e) => e.event.poolSlug === matchedEvents[0].event.poolSlug);
  const statusSoldOut = stripLeadingEmoji(translate(lang, "common.status_sold_out"));
  const botNotifyText =
    lang === "uk"
      ? "Бот миттєво сповістить вас, щойно слоти знову стануть доступними!"
      : lang === "ru"
      ? "Бот моментально оповестит вас, как только слоты снова станут доступны!"
      : "You will be alerted instantly as soon as slots re-open!";

  let title = `${icon("event_batch_drop")} ${stripLeadingEmoji(rawTitle)}`;

  const allAppeared = matchedEvents.every((e) => e.event.type === "SLOT_APPEARED");
  const allPriceChanged = matchedEvents.every(
    (e) =>
      e.event.type === "SLOT_PRICE_CHANGED" ||
      e.event.type === "POOL_BASE_PRICE_CHANGED" ||
      e.event.type === "PRICE_CHANGED"
  );

  if (allSoldOut && allSamePool) {
    const pName = escapeHtml(cleanPoolTitle(matchedEvents[0].event.poolName, matchedEvents[0].event.poolSlug));
    title =
      lang === "uk"
        ? `${icon("event_slot_sold")} <b>СЛОТИ РОЗПРОДАНО • ${pName} (${count})</b>`
        : lang === "ru"
        ? `${icon("event_slot_sold")} <b>СЛОТЫ РАСПРОДАНЫ • ${pName} (${count})</b>`
        : `${icon("event_slot_sold")} <b>SLOTS SOLD OUT • ${pName} (${count})</b>`;
  } else if (allSoldOut) {
    title =
      lang === "uk"
        ? `${icon("event_slot_sold")} <b>СЛОТИ РОЗПРОДАНО (${count})</b>`
        : lang === "ru"
        ? `${icon("event_slot_sold")} <b>СЛОТЫ РАСПРОДАНЫ (${count})</b>`
        : `${icon("event_slot_sold")} <b>SLOTS SOLD OUT (${count})</b>`;
  } else if (allAppeared && allSamePool) {
    const pName = escapeHtml(cleanPoolTitle(matchedEvents[0].event.poolName, matchedEvents[0].event.poolSlug));
    title =
      lang === "uk"
        ? `${icon("event_slot_drop")} <b>ВІЛЬНІ СЛОТИ • ${pName} (${count})</b>`
        : lang === "ru"
        ? `${icon("event_slot_drop")} <b>СВОБОДНЫЕ СЛОТЫ • ${pName} (${count})</b>`
        : `${icon("event_slot_drop")} <b>AVAILABLE SLOTS • ${pName} (${count})</b>`;
  } else if (allPriceChanged && allSamePool) {
    const pName = escapeHtml(cleanPoolTitle(matchedEvents[0].event.poolName, matchedEvents[0].event.poolSlug));
    title =
      lang === "uk"
        ? `${icon("event_price_drop")} <b>ЗМІНА ЦІН • ${pName} (${count})</b>`
        : lang === "ru"
        ? `${icon("event_price_drop")} <b>ИЗМЕНЕНИЕ ЦЕН • ${pName} (${count})</b>`
        : `${icon("event_price_drop")} <b>PRICE CHANGES • ${pName} (${count})</b>`;
  }

  for (const { event } of matchedEvents) {
    const blockName = resolveBlockName(event.block, lang);
    const poolName = cleanPoolTitle(event.poolName, event.poolSlug);
    const poolUrl = `https://cheapestinference.com/pools/${event.poolSlug}`;
    const blockHash = event.block && event.block !== "ALL" ? `#${event.block}` : "";
    const checkoutUrl = `${poolUrl}${blockHash}`;

    if (event.type === "SLOT_APPEARED") {
      const isLimited = event.newStatus === "limited";
      const statusIcon = isLimited ? icon("status_limited") : icon("status_available");
      const hoursLocal = event.hoursUtc ? formatBlockHoursWithLocal(event.block, event.hoursUtc, lang) : "";
      const hoursText = hoursLocal ? ` <code>(${escapeHtml(hoursLocal)})</code>` : "";

      const poolBlockHeader = allSamePool
        ? `${getRegionIcon(event.block)} <b>${escapeHtml(blockName)}</b>`
        : `<b>${escapeHtml(poolName)} • ${escapeHtml(blockName)}</b> ${getRegionIcon(event.block)}`;

      const line =
        `${statusIcon} ${poolBlockHeader}${hoursText}: ` +
        `<b>$${cleanPriceString(event.newPrice)}/${currencyMonth}</b>`;
      sectionLines.push(line);

      const btnLabel = translate(lang, "alerts.btn_claim_slot_block", {
        block_name: `${poolName} (${blockName})`,
        price: cleanPriceString(event.newPrice),
        currency_month: currencyMonth,
      });

      candidates.push({
        priority: 1,
        label: btnLabel,
        url: checkoutUrl,
        poolSlug: event.poolSlug,
        isSpecificAction: true,
      });
    } else if (event.type === "SLOT_DISAPPEARED") {
      const poolBlockHeader = allSamePool
        ? `${getRegionIcon(event.block)} <b>${escapeHtml(blockName)}</b>`
        : `<b>${escapeHtml(poolName)} • ${escapeHtml(blockName)}</b> ${getRegionIcon(event.block)}`;

      const line =
        `${icon("event_slot_sold")} ${poolBlockHeader}: ` +
        `<i>${statusSoldOut}</i>`;
      sectionLines.push(line);

      const poolBtnLabel =
        lang === "uk"
          ? `🌐 Відкрити ${poolName}`
          : lang === "ru"
          ? `🌐 Открыть ${poolName}`
          : `🌐 Open ${poolName}`;

      candidates.push({
        priority: 4,
        label: poolBtnLabel,
        url: poolUrl,
        poolSlug: event.poolSlug,
        isSpecificAction: false,
      });
    } else if (event.type === "SLOT_PRICE_CHANGED") {
      const isDiscount = (event.slotPrice?.priceDelta || 0) < 0;
      const trendIcon = isDiscount ? icon("event_price_drop") : icon("event_price_hike");
      const deltaBadge = event.slotPrice
        ? formatPriceDeltaBadge(event.slotPrice.priceDelta, event.slotPrice.percentageDelta, lang)
        : "";
      const hoursLocal = event.hoursUtc ? formatBlockHoursWithLocal(event.block, event.hoursUtc, lang) : "";
      const hoursText = hoursLocal ? ` <code>(${escapeHtml(hoursLocal)})</code>` : "";

      const poolBlockHeader = allSamePool
        ? `${getRegionIcon(event.block)} <b>${escapeHtml(blockName)}</b>`
        : `<b>${escapeHtml(poolName)} • ${escapeHtml(blockName)}</b> ${getRegionIcon(event.block)}`;

      const line =
        `${trendIcon} ${poolBlockHeader}${hoursText}: ` +
        `<s>$${cleanPriceString(event.previousPrice)}</s> ➔ <b>$${cleanPriceString(event.newPrice)}/${currencyMonth}</b> ` +
        `${deltaBadge}`;
      sectionLines.push(line);

      const btnLabel = translate(lang, "alerts.btn_claim_slot_block", {
        block_name: `${poolName} (${blockName})`,
        price: cleanPriceString(event.newPrice),
        currency_month: currencyMonth,
      });

      candidates.push({
        priority: 2,
        label: btnLabel,
        url: checkoutUrl,
        poolSlug: event.poolSlug,
        isSpecificAction: true,
      });
    } else if (event.type === "POOL_BASE_PRICE_CHANGED" || event.type === "PRICE_CHANGED") {
      const isDiscount = (event.basePrice?.priceDelta || 0) < 0;
      const trendIcon = isDiscount ? icon("event_price_drop") : icon("event_price_hike");
      const deltaBadge = event.basePrice
        ? formatPriceDeltaBadge(event.basePrice.priceDelta, event.basePrice.percentageDelta, lang)
        : "";

      const poolPrefix = allSamePool ? "" : `<b>${escapeHtml(poolName)}</b>: `;
      const baseRateLabel =
        lang === "uk"
          ? "Базовий тариф"
          : lang === "ru"
          ? "Базовый тариф"
          : "Base Rate";
      const line =
        `${trendIcon} ${poolPrefix}<b>${baseRateLabel}</b>: ` +
        `<s>$${cleanPriceString(event.previousPrice)}</s> ➔ <b>$${cleanPriceString(event.newPrice)}/${currencyMonth}</b> ` +
        `${deltaBadge}`;
      sectionLines.push(line);

      const poolBtnLabel =
        lang === "uk"
          ? `🌐 Тариф ${poolName}`
          : lang === "ru"
          ? `🌐 Тариф ${poolName}`
          : `🌐 ${poolName} Rate`;

      candidates.push({
        priority: 3,
        label: poolBtnLabel,
        url: poolUrl,
        poolSlug: event.poolSlug,
        isSpecificAction: false,
      });
    } else if (event.type === "MODEL_UPGRADE_EVENT") {
      const poolPrefix = allSamePool ? "" : `<b>${escapeHtml(poolName)}</b>: `;
      const modelsList = (event.models || []).map((m) => `<code>${escapeHtml(m)}</code>`).join(", ");
      const line = `${icon("event_model_upgrade")} ${poolPrefix}${modelsList}`;
      sectionLines.push(line);

      candidates.push({
        priority: 4,
        label: translate(lang, "common.open_site"),
        url: poolUrl,
        poolSlug: event.poolSlug,
        isSpecificAction: false,
      });
    } else {
      const poolPrefix = allSamePool ? "" : `<b>${escapeHtml(poolName)}</b> • `;
      const line = `${icon("event_new_pool")} ${poolPrefix}<b>${escapeHtml(blockName)}</b>: ${escapeHtml(event.newStatus || "updated")}`;
      sectionLines.push(line);

      candidates.push({
        priority: 4,
        label: translate(lang, "common.open_site"),
        url: poolUrl,
        poolSlug: event.poolSlug,
        isSpecificAction: false,
      });
    }
  }

  const sectionsText = sectionLines.join("\n\n");
  const timeLabel = lang === "uk" ? "Час" : lang === "ru" ? "Время" : "Time";
  const footerNote = allSoldOut ? `\n\n${icon("notify_bell_on")} <i>${botNotifyText}</i>` : "";
  const footer = `\n\n${icon("nav_clock")} <b>${timeLabel}:</b> <code>${timeFormatted} UTC</code>${footerNote}`;
  const text = `${title}\n\n${sectionsText}${footer}`;

  const keyboard = buildBundleAlertKeyboard(candidates, lang);

  return {
    id: crypto.randomUUID(),
    telegramId: user.telegramId,
    userId: user.userId,
    poolSlug: matchedEvents[0].event.poolSlug,
    blockId: "BUNDLE",
    eventType: "BUNDLE_EVENT",
    text: truncateToTelegramLimit(text),
    keyboard,
    isMuted: user.isMuted,
    priority: highestPriority,
    retries: 0,
    enqueuedAt: Date.now(),
  };
}

/**
 * Creates a synthetic test alert message for /testalert or administrative verification.
 */
export function createTestAlertMessage(
  user: PackedUserProfile,
  type: "slot" | "bundle" = "slot"
): OutgoingAlertMessage {
  if (type === "bundle") {
    const mockEvents: Array<{ event: DiffEvent; priority: BroadcastPriority }> = [
      {
        event: {
          id: "test-slot-1",
          poolSlug: "flagship",
          poolName: "Flagship Pool",
          block: "asia",
          type: "SLOT_APPEARED",
          newStatus: "available",
          previousStatus: "sold-out",
          newPrice: "149",
          hoursUtc: "00:00-08:00 UTC",
          models: ["DeepSeek-V3", "Kimi-K1.5"],
          timestamp: Date.now(),
        },
        priority: "P1",
      },
      {
        event: {
          id: "test-slot-2",
          poolSlug: "flagship",
          poolName: "Flagship Pool",
          block: "europe",
          type: "SLOT_APPEARED",
          newStatus: "available",
          previousStatus: "sold-out",
          newPrice: "149",
          hoursUtc: "08:00-16:00 UTC",
          models: ["DeepSeek-V3", "Kimi-K1.5"],
          timestamp: Date.now(),
        },
        priority: "P1",
      },
    ];
    return formatBundledAlertMessage(user, mockEvents);
  }

  const mockEvent: DiffEvent = {
    id: "test-alert-single",
    poolSlug: "flagship",
    poolName: "Flagship Pool",
    block: "europe",
    type: "SLOT_APPEARED",
    newStatus: "available",
    previousStatus: "sold-out",
    newPrice: "149",
    hoursUtc: "08:00-16:00 UTC",
    models: ["DeepSeek-V3", "Kimi-K1.5"],
    timestamp: Date.now(),
  };

  return formatSingleAlertMessage(user, mockEvent, "P1");
}
