/**
 * src/bot/notifier/alertFormatter.ts
 * Pure Synchronous Alert & Bundle Message Formatter
 */

import { InlineKeyboard } from "grammy";
import { DiffEvent, PriceAnalyticsPayload } from "../../types/domain.js";
import { translate, escapeHtml, SupportedLanguage } from "../../i18n/index.js";
import { PackedUserProfile } from "./subscriberIndex.js";
import { truncateToTelegramLimit } from "./htmlTagBalancer.js";

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
  const cleaned = String(val).replace(/[^0-9.-]/g, "");
  const num = parseFloat(cleaned);
  if (isNaN(num) || Object.is(num, -0) || num === 0) return "0";
  return num % 1 === 0 ? num.toFixed(0) : num.toFixed(2);
}

export function formatPriceDeltaBadge(
  delta: number,
  pct: number,
  lang: SupportedLanguage
): string {
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
    return translate(lang, "alerts.price_all_time_low") || `🔥 <b>Історичний мінімум! Найнижча ціна ($${currStr})</b>`;
  }
  if (pa.rating === "below_average" && pa.avgPrice) {
    return (
      translate(lang, "alerts.price_below_average", { current: currStr, avg: avgStr }) ||
      `🟢 <b>Нижче середнього ($${currStr} vs сер. $${avgStr})</b>`
    );
  }
  if (pa.rating === "above_average" && pa.avgPrice) {
    return (
      translate(lang, "alerts.price_above_average", { current: currStr, avg: avgStr }) ||
      `🔴 <b>Вище середнього ($${currStr} vs сер. $${avgStr})</b>`
    );
  }
  if (pa.rating === "fair" && pa.avgPrice) {
    return translate(lang, "alerts.price_fair_value") || "⚖️ <b>Стандартна ціна (в межах норми)</b>";
  }
  return "";
}

export function formatAlertMessage(
  user: PackedUserProfile,
  event: DiffEvent,
  priority: BroadcastPriority,
  cachedDurationFormatted?: string
): OutgoingAlertMessage {
  const lang = user.language;
  const blockName = translate(lang, `common.block_${event.block}`) || event.block;
  const timeFormatted = new Date(event.timestamp).toISOString().replace("T", " ").substring(0, 19);
  const currencyMonth = translate(lang, "common.currency_month") || "mo";

  const blockHash = event.block && event.block !== "ALL" ? `#${event.block}` : "";
  const poolUrl = `https://cheapestinference.com/pools/${event.poolSlug}`;
  const checkoutUrl = `${poolUrl}${blockHash}`;

  let text = "";
  let keyboard: InlineKeyboard | undefined;

  if (event.type === "SLOT_APPEARED") {
    const isLimited = event.newStatus === "limited";
    const statusIcon = isLimited ? "🟡" : "🟢";
    const statusBadge = isLimited
      ? translate(lang, "common.status_limited")
      : translate(lang, "common.status_available");

    const header = translate(lang, "alerts.slot_appeared_header", {
      status_icon: statusIcon,
      pool_name: escapeHtml(event.poolName),
    });

    const body = translate(lang, "alerts.slot_appeared_body", {
      pool_name: escapeHtml(event.poolName),
      block_name: escapeHtml(blockName),
      hours_utc: escapeHtml(event.hoursUtc),
      models: (event.models || []).map((m) => `<code>${escapeHtml(m)}</code>`).join(", "),
      price: escapeHtml(cleanPriceString(event.newPrice)),
      currency_month: currencyMonth,
      status_badge: statusBadge,
      timestamp: timeFormatted,
    });

    text = `${header}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${body}`;

    if (event.analytics?.isBatchDrop) {
      const batchBadge =
        translate(lang, "alerts.tag_multi_region_drop", { count: event.analytics.totalOpenings || 2 }) ||
        "🆕 <i>Новий дроп потужностей</i>";
      text = `${batchBadge}\n${text}`;
    } else if (event.analytics?.demandCategory === "hot" && event.analytics.avgLifespanFormatted) {
      const hotBadge =
        translate(lang, "alerts.tag_hot_slot_drop", { duration: escapeHtml(event.analytics.avgLifespanFormatted) }) ||
        `🔥 <i>Гарячий слот (розбирають за ${escapeHtml(event.analytics.avgLifespanFormatted)})</i>`;
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
    const header = translate(lang, "alerts.slot_disappeared_header", {
      pool_name: escapeHtml(event.poolName),
    });
    let body = translate(lang, "alerts.slot_disappeared_body", {
      pool_name: escapeHtml(event.poolName),
      block_name: escapeHtml(blockName),
      timestamp: timeFormatted,
    });

    const eta = event.analytics?.eta;
    if (eta) {
      if (eta.isPredictable) {
        let confBadge = translate(lang, "intelligence.conf_low") || "⚪";
        if (eta.confidence === "HIGH") {
          confBadge = translate(lang, "intelligence.conf_high") || "🟢 Висока точність";
        } else if (eta.confidence === "MEDIUM") {
          confBadge = translate(lang, "intelligence.conf_medium") || "🟡 Середня точність";
        }
        const cadence = eta.detectedCadenceHours
          ? translate(lang, "intelligence.cadence_daily") || "добовий цикл ~24h"
          : eta.formattedEtaWindow;
        body += `\n\n🔮 <b>${translate(lang, "intelligence.eta_title") || "Очікувана поява"}:</b> <code>${escapeHtml(cadence)}</code> [${confBadge}]`;
      } else {
        body += `\n\n🔮 <b>${translate(lang, "intelligence.eta_title") || "Прогноз"}:</b> <i>${
          translate(lang, "intelligence.eta_gathering_data", {
            count: eta.sampleCount,
            min: eta.minRequired,
          }) || `Збір статистики (${eta.sampleCount}/${eta.minRequired})`
        }</i>`;
      }
    }

    text = `${header}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${body}`;
  } else if (event.type === "MODEL_UPGRADE_EVENT") {
    const header = translate(lang, "alerts.model_upgrade_header", {
      pool_name: escapeHtml(event.poolName),
    });
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

    const allModelsList = (event.models || []).map((m) => `<code>${escapeHtml(m)}</code>`).join(", ");

    const body = translate(lang, "alerts.model_upgrade_body", {
      pool_name: escapeHtml(event.poolName),
      model_diff_block:
        diffLines.length > 0
          ? diffLines.join("\n")
          : "• " + allModelsList,
      all_models: allModelsList,
      model_count: (event.models || []).length,
    });

    text = `${header}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${body}`;
    keyboard = new InlineKeyboard().url(
      translate(lang, "common.open_site"),
      poolUrl
    );
  } else if (event.type === "SLOT_PRICE_CHANGED") {
    const isDiscount = (event.slotPrice?.priceDelta || 0) < 0;
    const trendIcon = isDiscount ? "📉" : "📈";
    const header = translate(lang, "alerts.slot_price_changed_header", {
      trend_icon: trendIcon,
      pool_name: escapeHtml(event.poolName),
    });

    const deltaBadge = event.slotPrice
      ? formatPriceDeltaBadge(event.slotPrice.priceDelta, event.slotPrice.percentageDelta, lang)
      : "";

    const cleanNewPrice = cleanPriceString(event.newPrice);
    const newPriceNum = parseFloat(cleanNewPrice) || 0;
    const ratingBadge = formatPriceRatingBadge(event.slotPrice?.priceAnalytics, newPriceNum, lang);

    const body = translate(lang, "alerts.slot_price_changed_body", {
      pool_name: escapeHtml(event.poolName),
      block_name: escapeHtml(blockName),
      old_price: escapeHtml(cleanPriceString(event.previousPrice)),
      new_price: escapeHtml(cleanNewPrice),
      currency_month: currencyMonth,
      delta_badge: deltaBadge + (ratingBadge ? `\n${ratingBadge}` : ""),
      hours_utc: escapeHtml(event.hoursUtc),
    });

    text = `${header}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${body}`;

    const btnLabel = translate(lang, "alerts.btn_claim_slot_block", {
      block_name: blockName,
      price: escapeHtml(cleanNewPrice),
      currency_month: currencyMonth,
    });

    keyboard = new InlineKeyboard().url(btnLabel, checkoutUrl);
  } else if (event.type === "POOL_BASE_PRICE_CHANGED" || event.type === "PRICE_CHANGED") {
    const isDiscount = (event.basePrice?.priceDelta || 0) < 0;
    const trendIcon = isDiscount ? "📉" : "📈";
    const header = translate(lang, "alerts.pool_base_price_header", {
      trend_icon: trendIcon,
      pool_name: escapeHtml(event.poolName),
    });

    const deltaBadge = event.basePrice
      ? formatPriceDeltaBadge(event.basePrice.priceDelta, event.basePrice.percentageDelta, lang)
      : "";

    const cleanNewPrice = cleanPriceString(event.newPrice);
    const newPriceNum = parseFloat(cleanNewPrice) || 0;
    const ratingBadge = formatPriceRatingBadge(event.basePrice?.priceAnalytics, newPriceNum, lang);

    const body = translate(lang, "alerts.pool_base_price_body", {
      pool_name: escapeHtml(event.poolName),
      old_price: escapeHtml(cleanPriceString(event.previousPrice)),
      new_price: escapeHtml(cleanNewPrice),
      currency_month: currencyMonth,
      delta_badge: deltaBadge + (ratingBadge ? `\n${ratingBadge}` : ""),
      models: (event.models || []).map((m) => `<code>${escapeHtml(m)}</code>`).join(", "),
    });

    text = `${header}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${body}`;
    keyboard = new InlineKeyboard().url(
      translate(lang, "common.open_site"),
      poolUrl
    );
  } else if (event.type === "TIER_UPDATED_EVENT") {
    const header = translate(lang, "alerts.tier_updated_header", {
      pool_name: escapeHtml(event.poolName),
    });
    const diffLines: string[] = [];
    if (event.tierUpdate?.newDescription) {
      diffLines.push(
        translate(lang, "alerts.tier_desc_change", {
          new_description: escapeHtml(event.tierUpdate.newDescription),
        })
      );
    }
    if (event.tierUpdate?.newAnnualDiscount) {
      diffLines.push(
        translate(lang, "alerts.tier_discount_change", {
          old_discount: ((event.tierUpdate.previousAnnualDiscount || 0.15) * 100).toFixed(0),
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

    const body = translate(lang, "alerts.tier_updated_body", {
      pool_name: escapeHtml(event.poolName),
      tier_diff_block: diffLines.join("\n"),
      timestamp: timeFormatted,
    });

    text = `${header}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${body}`;
    keyboard = new InlineKeyboard().url(
      translate(lang, "common.open_site"),
      poolUrl
    );
  } else if (event.type === "NEW_POOL_EVENT") {
    const header = translate(lang, "alerts.new_pool_header", {
      pool_name: escapeHtml(event.poolName),
    });
    const body = translate(lang, "alerts.new_pool_body", {
      pool_name: escapeHtml(event.poolName),
      models: (event.models || []).map((m) => `<code>${escapeHtml(m)}</code>`).join(", "),
      min_price: escapeHtml(cleanPriceString(event.newPrice)),
      currency_month: currencyMonth,
      description: escapeHtml((event.metadata?.description as string) || "High-performance compute pool"),
    });

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

  const title =
    translate(lang, "alerts.batch_title", { count }) ||
    `⚡ <b>CheapestInference — Slot Updates (${count})</b>`;

  const sectionLines: string[] = [];
  const keyboard = new InlineKeyboard();

  let highestPriority: BroadcastPriority = "P3";
  for (const item of matchedEvents) {
    if (item.priority === "P1") highestPriority = "P1";
    else if (item.priority === "P2" && highestPriority !== "P1") highestPriority = "P2";
  }

  let buttonCount = 0;

  for (const { event } of matchedEvents) {
    const blockName = translate(lang, `common.block_${event.block}`) || event.block;
    const blockHash = event.block && event.block !== "ALL" ? `#${event.block}` : "";
    const checkoutUrl = `https://cheapestinference.com/pools/${event.poolSlug}${blockHash}`;

    if (event.type === "SLOT_APPEARED") {
      const cleanPrice = cleanPriceString(event.newPrice);
      const lifespanBadge = event.analytics?.avgLifespanFormatted
        ? ` ${event.analytics.demandCategory === "hot" ? "🔥" : "⚡"} <code>${escapeHtml(event.analytics.avgLifespanFormatted)}</code>`
        : "";
      sectionLines.push(
        `🟢 <b>${escapeHtml(event.poolName)} • ${escapeHtml(blockName)}</b>${lifespanBadge}\n` +
        `💰 <code>$${escapeHtml(cleanPrice)}/${currencyMonth}</code> | 🕒 <code>${escapeHtml(event.hoursUtc)}</code>\n` +
        `🤖 ${(event.models || []).map((m) => `<code>${escapeHtml(m)}</code>`).join(", ")}`
      );

      if (buttonCount < 3) {
        const btnLabel = `⚡ ${event.poolSlug.toUpperCase()} (${blockName}) • $${cleanPrice}`;
        keyboard.url(btnLabel, checkoutUrl).row();
        buttonCount++;
      }
    } else if (event.type === "SLOT_DISAPPEARED") {
      sectionLines.push(
        `🔒 <b>${escapeHtml(event.poolName)} • ${escapeHtml(blockName)}</b> — <i>${translate(lang, "common.status_sold_out")}</i>`
      );
      if (buttonCount < 3) {
        const btnLabel = `🔍 ${event.poolSlug.toUpperCase()}`;
        keyboard.url(btnLabel, `https://cheapestinference.com/pools/${event.poolSlug}`).row();
        buttonCount++;
      }
    } else if (event.type === "MODEL_UPGRADE_EVENT") {
      const upgradeTitle = translate(lang, "alerts.bundle_title_models") || "Model Upgrade";
      sectionLines.push(
        `🚀 <b>${escapeHtml(event.poolName)} • ${upgradeTitle}</b>\n` +
        `🤖 ${(event.models || []).map((m) => `<code>${escapeHtml(m)}</code>`).join(", ")}`
      );
    } else if (event.type === "SLOT_PRICE_CHANGED") {
      const deltaStr = event.slotPrice
        ? ` (${formatPriceDeltaBadge(event.slotPrice.priceDelta, event.slotPrice.percentageDelta, lang)})`
        : "";
      const cleanOld = cleanPriceString(event.previousPrice);
      const cleanNew = cleanPriceString(event.newPrice);
      const hoursStr = event.hoursUtc ? ` | 🕒 <code>${escapeHtml(event.hoursUtc)}</code>` : "";
      sectionLines.push(
        `🏷 <b>${escapeHtml(event.poolName)} • ${escapeHtml(blockName)}</b>\n` +
        `💰 <s>$${escapeHtml(cleanOld)}</s> ➔ <b>$${escapeHtml(cleanNew)}/${currencyMonth}</b>${deltaStr}${hoursStr}`
      );
      if (buttonCount < 3) {
        const btnLabel = `🏷 ${event.poolSlug.toUpperCase()} (${blockName}) • $${cleanNew}`;
        keyboard.url(btnLabel, checkoutUrl).row();
        buttonCount++;
      }
    } else if (event.type === "POOL_BASE_PRICE_CHANGED" || event.type === "PRICE_CHANGED") {
      const deltaStr = event.basePrice
        ? ` (${formatPriceDeltaBadge(event.basePrice.priceDelta, event.basePrice.percentageDelta, lang)})`
        : "";
      const cleanOld = cleanPriceString(event.previousPrice);
      const cleanNew = cleanPriceString(event.newPrice);
      const tariffBadge = translate(lang, "alerts.bundle_title_base_price") || "Base Tariff";
      sectionLines.push(
        `💰 <b>${escapeHtml(event.poolName)} • ${tariffBadge}</b>\n` +
        `💵 <s>$${escapeHtml(cleanOld)}</s> ➔ <b>$${escapeHtml(cleanNew)}/${currencyMonth}</b>${deltaStr}\n` +
        `🤖 ${(event.models || []).map((m) => `<code>${escapeHtml(m)}</code>`).join(", ")}`
      );
      if (buttonCount < 3) {
        const btnLabel = `💰 ${event.poolSlug.toUpperCase()} • $${cleanNew}`;
        keyboard.url(btnLabel, `https://cheapestinference.com/pools/${event.poolSlug}`).row();
        buttonCount++;
      }
    } else if (event.type === "TIER_UPDATED_EVENT") {
      const tierTitle = translate(lang, "alerts.bundle_title_tier") || "Tier Specification Updated";
      sectionLines.push(`📝 <b>${escapeHtml(event.poolName)} • ${tierTitle}</b>`);
    } else if (event.type === "NEW_POOL_EVENT") {
      const newPoolTitle = translate(lang, "alerts.bundle_title_new_pool") || "New Pool Launched";
      sectionLines.push(
        `✨ <b>${escapeHtml(event.poolName)} • ${newPoolTitle}</b>\n` +
        `🤖 ${(event.models || []).map((m) => `<code>${escapeHtml(m)}</code>`).join(", ")}`
      );
    } else {
      sectionLines.push(`• <b>${escapeHtml(event.poolName)}</b> (${escapeHtml(blockName)}): ${escapeHtml(event.newStatus || "updated")}`);
    }
  }

  if (buttonCount === 0) {
    keyboard.url(translate(lang, "common.open_site"), "https://cheapestinference.com/pools");
    buttonCount++;
  }

  const footer =
    lang === "uk"
      ? `🕒 <i>Час оновлення: ${timeFormatted} UTC</i>`
      : lang === "ru"
      ? `🕒 <i>Время обновления: ${timeFormatted} UTC</i>`
      : `🕒 <i>Updated at: ${timeFormatted} UTC</i>`;

  const text = `${title}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${sectionLines.join("\n───\n")}\n━━━━━━━━━━━━━━━━━━━━━━━━\n${footer}`;
  const firstEvent = matchedEvents[0].event;

  return {
    id: crypto.randomUUID(),
    telegramId: user.telegramId,
    userId: user.userId,
    poolSlug: firstEvent.poolSlug,
    blockId: "BUNDLE",
    eventType: "BUNDLE_EVENT",
    text: truncateToTelegramLimit(text),
    keyboard: buttonCount > 0 ? keyboard : undefined,
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
