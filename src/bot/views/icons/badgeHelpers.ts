/**
 * src/bot/views/icons/badgeHelpers.ts
 * Contextual Badge Builders & Domain-Specific Visual Resolvers
 */

import { icon } from "./iconTheme.js";
import { ModelSemanticMatcher } from "../../../engine/modelSemanticMatcher.js";

/**
 * Helper to retrieve 3D rotating regional globe based on block ID
 */
export function getRegionalGlobeIcon(blockId: string): string {
  switch ((blockId || "").toLowerCase()) {
    case "asia":
      return icon("region_asia");
    case "europe":
      return icon("region_europe");
    case "americas":
      return icon("region_americas");
    default:
      return icon("region_all");
  }
}

/**
 * Helper to compute status orb for capacity
 */
export function getCapacityOrbIcon(availableCount: number, totalBlocks: number = 3): string {
  if (availableCount >= totalBlocks && totalBlocks > 0) {
    return icon("status_available");
  } else if (availableCount > 0) {
    return icon("status_partially_available");
  } else {
    return icon("status_sold_out");
  }
}

/**
 * Helper to automatically retrieve 3D animated custom emoji for any neural network model
 */
export function getModel3DIcon(modelName: string): string {
  const parsed = ModelSemanticMatcher.parseModel(modelName);
  switch (parsed.family) {
    case "deepseek":
      return icon("ai_deepseek");
    case "qwen":
      return icon("ai_qwen");
    case "glm":
      return icon("ai_glm");
    case "kimi":
      return icon("ai_kimi");
    case "mimo":
      return icon("ai_mimo");
    case "minimax":
      return icon("ai_minimax");
    case "llama":
      return icon("ai_llama");
    case "mistral":
      return icon("ai_mistral");
    case "claude":
      return icon("ai_claude");
    default:
      return icon("ai_robot");
  }
}
