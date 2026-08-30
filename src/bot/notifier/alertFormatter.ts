/**
 * src/bot/notifier/alertFormatter.ts
 * Pure Synchronous Alert & Bundle Message Formatter (Unified Facade)
 *
 * 100% Backward Compatible Facade for alert formatting across the codebase.
 */

export type {
  BroadcastPriority,
  OutgoingAlertMessage,
} from "./formatters/singleAlertFormatter.js";

export {
  cleanPoolTitle,
  cleanPriceString,
  formatPriceDeltaBadge,
  formatPriceRatingBadge,
  resolveBlockName,
  getRegionIcon,
} from "./formatters/priceBadgeHelper.js";

export {
  buildSingleAlertKeyboard,
  buildBundleAlertKeyboard,
  type BundleButtonCandidate,
} from "./keyboards/alertKeyboardBuilder.js";

export {
  formatSingleAlertMessage,
  formatSingleAlertMessage as formatAlertMessage,
} from "./formatters/singleAlertFormatter.js";

export {
  formatBundledAlertMessage,
  createTestAlertMessage,
} from "./formatters/bundleAlertFormatter.js";
