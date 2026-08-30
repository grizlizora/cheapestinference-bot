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
  const regionLabel = translate(lang, "common.region") || "Region";

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
        : `${icon("event_price_drop")} <b>PRICE UPDATES • ${pName} (${count})</b>`;
  }

  for (const { event } of matchedEvents) {
    const blockName = resolveBlockName(event.block, lang);
    const cleanName = cleanPoolTitle(event.poolName, event.poolSlug);
    const poolUrl = `https://cheapestinference.com/pools/${event.poolSlug}`;
    const blockHash = event.block && event.block !== "ALL" ? `#${event.block}` : "";
    const checkoutUrl = `${poolUrl}${blockHash}`;
    const hoursLocal = event.hoursUtc ? formatBlockHoursWithLocal(event.block, event.hoursUtc, lang) : "";
    const hoursText = hoursLocal ? ` <code>(${escapeHtml(hoursLocal)})</code>` : "";

    if (event.type === "SLOT_APPEARED") {
      const cleanPrice = cleanPriceString(event.newPrice);
      const lifespanBadge = event.analytics?.avgLifespanFormatted
        ? ` ${event.analytics.demandCategory === "hot" ? icon("event_hot_slot") : icon("event_slot_drop")} <code>${escapeHtml(event.analytics.avgLifespanFormatted)}</code>`
        : "";

      if (allSamePool) {
        sectionLines.push(
          `${getRegionIcon(event.block)} <b>${escapeHtml(blockName)}</b>${lifespanBadge}\n` +
          `  • ${icon("price_money")} <b>$${escapeHtml(cleanPrice)}/${currencyMonth}</b> | ${icon("nav_clock")} <code>${escapeHtml(hoursLocal || event.hoursUtc)}</code>`
        );
      } else {
        sectionLines.push(
          `${getRegionIcon(event.block)} <b>${escapeHtml(cleanName)} • ${escapeHtml(blockName)}</b>${lifespanBadge}\n` +
          `  • ${icon("price_money")} <b>$${escapeHtml(cleanPrice)}/${currencyMonth}</b> | ${icon("nav_clock")} <code>${escapeHtml(hoursLocal || event.hoursUtc)}</code>`
        );
      }

      candidates.push({
        priority: 1,
        label: `⚡ ${cleanName} (${blockName}) • $${cleanPrice}`,
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
          `${icon("event_slot_sold")} <b>${escapeHtml(cleanName)}</b>\n` +
          `  • ${getRegionIcon(event.block)} <b>${escapeHtml(blockName)}:</b> ${icon("status_sold_out")} <i>${statusSoldOut}</i>`
        );
      }
      const poolBtnLabel =
        lang === "uk"
          ? `🌐 Відкрити ${cleanName}`
          : lang === "ru"
          ? `🌐 Открыть ${cleanName}`
          : `🌐 Open ${cleanName}`;

      candidates.push({
        priority: 4,
        label: poolBtnLabel,
        url: poolUrl,
        poolSlug: event.poolSlug,
        isSpecificAction: false,
      });
    } else if (event.type === "MODEL_UPGRADE_EVENT") {
      const upgradeTitle = translate(lang, "alerts.bundle_title_models") || "Model Upgrade";
      sectionLines.push(
        `${icon("event_model_upgrade")} <b>${escapeHtml(cleanName)} • ${upgradeTitle}</b>\n` +
        `${icon("ai_robot")} ${(event.models || []).map((m) => `<code>${escapeHtml(m)}</code>`).join(", ")}`
      );
      candidates.push({
        priority: 4,
        label: `🔍 ${cleanName}`,
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
      const hoursStr = event.hoursUtc ? `\n  • ${icon("nav_clock")} <code>${escapeHtml(hoursLocal || event.hoursUtc)}</code>` : "";

      if (allSamePool) {
        sectionLines.push(
          `${getRegionIcon(event.block)} <b>${escapeHtml(blockName)}</b>\n` +
          `  • <s>$${escapeHtml(cleanOld)}</s> ➔ <b>$${escapeHtml(cleanNew)}/${currencyMonth}</b>${deltaStr}${hoursStr}`
        );
      } else {
        sectionLines.push(
          `${getRegionIcon(event.block)} <b>${escapeHtml(cleanName)} • ${escapeHtml(blockName)}</b>\n` +
          `  • <s>$${escapeHtml(cleanOld)}</s> ➔ <b>$${escapeHtml(cleanNew)}/${currencyMonth}</b>${deltaStr}${hoursStr}`
        );
      }

      candidates.push({
        priority: 2,
        label: `🏷 ${cleanName} (${blockName}) • $${cleanNew}`,
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
  type: "slot" | "model" | "bundle" = "slot"
): OutgoingAlertMessage {
  if (type === "slot") {
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
    return formatSingleAlertMessage(user, event, "P0");
  } else if (type === "bundle") {
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
    return formatBundledAlertMessage(user, [
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
    return formatSingleAlertMessage(user, event, "P0");
  }
}
