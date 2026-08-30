/**
 * src/bot/views/iconTheme.ts
 * High-Tech Animated Telegram Custom Emoji & Iconography Theme Engine (Unified Facade)
 *
 * Provides:
 * 1. Pre-compiled HTML <tg-emoji emoji-id="...">fallback</tg-emoji> tag caching (O(1) <0.0001ms)
 * 2. Instant Unicode fallback for legacy clients or standard accounts
 * 3. Runtime / Environment variable custom emoji pack ID overrides (CUSTOM_EMOJI_OVERRIDES)
 * 4. Safe string-length balancing compatible with htmlTagBalancer
 *
 * 100% Backward Compatible Facade for all modules across the codebase.
 */

export {
  ICON_REGISTRY,
  type IconKey,
  type IconDefinition,
} from "./icons/iconRegistry.js";

export {
  icon,
  getRawUnicode,
  setIconThemeConfig,
  type IconRenderMode,
  type IconThemeConfig,
} from "./icons/iconTheme.js";

export {
  getRegionalGlobeIcon,
  getCapacityOrbIcon,
  getModel3DIcon,
} from "./icons/badgeHelpers.js";
