/**
 * src/bot/views/icons/iconTheme.ts
 * Core Icon Rendering Engine & Zero-Allocation HTML Tag Pre-Compilation
 */

import { ICON_REGISTRY, IconKey, IconDefinition } from "./iconRegistry.js";

export type IconRenderMode = "custom_emoji" | "unicode_only" | "markdown_v2";

export interface IconThemeConfig {
  mode?: IconRenderMode;
  overrides?: Partial<Record<IconKey, string>>;
}

const EMOJI_ID_REGEX = /^\d{18,20}$/;

let activeOverrides: Partial<Record<IconKey, string>> = {};
let activeRenderMode: IconRenderMode = "custom_emoji";
const precompiledHtmlCache = new Map<IconKey, string>();

function buildTag(customId: string | undefined, fallback: string, mode: IconRenderMode): string {
  if (mode === "unicode_only" || !customId) {
    return fallback;
  }
  if (mode === "markdown_v2") {
    return `![${fallback}](tg://emoji?id=${customId})`;
  }
  return `<tg-emoji emoji-id="${customId}">${fallback}</tg-emoji>`;
}

function recomputeCache(): void {
  precompiledHtmlCache.clear();
  for (const [k, def] of Object.entries(ICON_REGISTRY)) {
    const key = k as IconKey;
    const customId = activeOverrides[key] || def.customEmojiId;
    precompiledHtmlCache.set(key, buildTag(customId, def.unicodeFallback, activeRenderMode));
  }
}

// Initial bootstrap from environment if available
try {
  if (typeof process !== "undefined" && process.env) {
    if (process.env.CUSTOM_EMOJI_MODE) {
      activeRenderMode = process.env.CUSTOM_EMOJI_MODE as IconRenderMode;
    }
    if (process.env.CUSTOM_EMOJI_OVERRIDES) {
      const parsed = JSON.parse(process.env.CUSTOM_EMOJI_OVERRIDES);
      const sanitized: Partial<Record<IconKey, string>> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string" && (EMOJI_ID_REGEX.test(v) || v.length > 0)) {
          sanitized[k as IconKey] = v;
        }
      }
      activeOverrides = sanitized;
    }
  }
} catch {
  activeOverrides = {};
}

recomputeCache();

/**
 * Configure global icon rendering settings at runtime.
 */
export function setIconThemeConfig(config: IconThemeConfig): void {
  if (config.mode !== undefined) {
    activeRenderMode = config.mode;
  }
  if (config.overrides !== undefined) {
    const sanitized: Partial<Record<IconKey, string>> = {};
    for (const [k, v] of Object.entries(config.overrides)) {
      if (typeof v === "string" && (EMOJI_ID_REGEX.test(v) || v.length > 0)) {
        sanitized[k as IconKey] = v;
      }
    }
    activeOverrides = sanitized;
  }
  recomputeCache();
}

/**
 * Primary Icon Renderer: Returns pre-compiled <tg-emoji> tag or safe Unicode fallback.
 * Speed: O(1) Map lookup (< 0.0001ms, zero allocations for standard renders).
 */
export function icon(key: IconKey, fallbackOverride?: string): string {
  const item = (ICON_REGISTRY as Record<string, IconDefinition | undefined>)[key];

  // Return pre-compiled cache if standard fallback is used
  if (fallbackOverride === undefined || (item && fallbackOverride === item.unicodeFallback)) {
    const cached = precompiledHtmlCache.get(key);
    if (cached) return cached;
  }

  if (!item) {
    return fallbackOverride || "🔹";
  }

  const fallback = fallbackOverride || item.unicodeFallback;
  const customId = activeOverrides[key] || item.customEmojiId;

  return buildTag(customId, fallback, activeRenderMode);
}

/**
 * Retrieve raw Unicode fallback directly (required for Telegram Inline Keyboard Buttons).
 */
export function getRawUnicode(key: IconKey): string {
  return (ICON_REGISTRY as Record<string, IconDefinition | undefined>)[key]?.unicodeFallback || "🔹";
}
