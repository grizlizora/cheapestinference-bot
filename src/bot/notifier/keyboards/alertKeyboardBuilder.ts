/**
 * src/bot/notifier/keyboards/alertKeyboardBuilder.ts
 * Telegram Inline Keyboard Assembly & Smart Column Packing Engine
 */

import { InlineKeyboard } from "grammy";
import { DiffEvent } from "../../../types/domain.js";
import { translate, SupportedLanguage } from "../../../i18n/index.js";
import { cleanPriceString, resolveBlockName } from "../formatters/priceBadgeHelper.js";

export interface BundleButtonCandidate {
  priority: number; // 1 = Claim, 2 = SlotPrice, 3 = BasePrice, 4 = PoolOverview
  label: string;
  url: string;
  poolSlug: string;
  isSpecificAction: boolean;
}

const MAX_BUNDLE_BUTTONS = 4;
const SHORT_BUTTON_CHAR_LIMIT = 18;

export function buildSingleAlertKeyboard(
  event: DiffEvent,
  lang: SupportedLanguage,
  poolUrl: string,
  checkoutUrl: string
): InlineKeyboard | undefined {
  const currencyMonth = translate(lang, "common.currency_month") || "mo";
  const blockName = resolveBlockName(event.block, lang);

  if (event.type === "SLOT_APPEARED" || event.type === "SLOT_PRICE_CHANGED") {
    const btnLabel = translate(lang, "alerts.btn_claim_slot_block", {
      block_name: blockName,
      price: cleanPriceString(event.newPrice),
      currency_month: currencyMonth,
    });
    return new InlineKeyboard().url(btnLabel, checkoutUrl);
  }

  if (event.type === "SLOT_DISAPPEARED") {
    const poolBtnLabel =
      lang === "uk"
        ? `🌐 Відкрити ${event.poolName || "Pool"}`
        : lang === "ru"
        ? `🌐 Открыть ${event.poolName || "Pool"}`
        : `🌐 Open ${event.poolName || "Pool"}`;
    return new InlineKeyboard().url(poolBtnLabel, poolUrl);
  }

  if (
    event.type === "MODEL_UPGRADE_EVENT" ||
    event.type === "POOL_BASE_PRICE_CHANGED" ||
    event.type === "PRICE_CHANGED" ||
    event.type === "TIER_UPDATED_EVENT" ||
    event.type === "NEW_POOL_EVENT"
  ) {
    return new InlineKeyboard().url(translate(lang, "common.open_site"), poolUrl);
  }

  return undefined;
}

export function buildBundleAlertKeyboard(
  candidates: BundleButtonCandidate[],
  lang: SupportedLanguage
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // 1. Sort by urgency (1 -> 2 -> 3 -> 4)
  candidates.sort((a, b) => a.priority - b.priority);

  // 2. Deduplicate by URL and by Pool Slug
  const selectedButtons: BundleButtonCandidate[] = [];
  const seenUrls = new Set<string>();
  const poolsWithSpecificAction = new Set<string>();
  const poolsWithGenericButton = new Set<string>();

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

  // 3. Fallback or Smart 1-col / 2-col packing
  if (selectedButtons.length === 0) {
    keyboard.url(translate(lang, "common.open_site"), "https://cheapestinference.com/pools");
    return keyboard;
  }

  let pendingShortBtn: BundleButtonCandidate | null = null;
  for (const btn of selectedButtons) {
    const isShort = btn.label.length <= SHORT_BUTTON_CHAR_LIMIT;
    if (isShort) {
      if (pendingShortBtn) {
        keyboard.url(pendingShortBtn.label, pendingShortBtn.url).url(btn.label, btn.url).row();
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

  return keyboard;
}
