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

export function getModel3DIcon(modelName: string): string {
  const parsed = ModelSemanticMatcher.parseModel(modelName);
  const fam = (parsed.family || "").toLowerCase();
  const raw = (modelName || "").toLowerCase();

  // 3D custom emoji matching by family keyword
  if (fam.includes("deepseek") || raw.includes("deepseek")) {
    return icon("ai_deepseek");
  }
  if (fam.includes("qwen") || raw.includes("qwen")) {
    return icon("ai_qwen");
  }
  if (fam.includes("glm") || fam.includes("chatglm") || raw.includes("glm")) {
    return icon("ai_glm");
  }
  if (
    fam.includes("kimi") ||
    fam.includes("moonshot") ||
    raw.includes("kimi") ||
    raw.includes("moonshot")
  ) {
    return icon("ai_kimi");
  }
  if (
    fam.includes("mimo") ||
    fam.includes("mino") ||
    raw.includes("mimo") ||
    raw.includes("mino")
  ) {
    return icon("ai_mimo");
  }
  if (
    fam.includes("minimax") ||
    raw.includes("minimax") ||
    raw.includes("mini max") ||
    raw.includes("mini-max")
  ) {
    return icon("ai_minimax");
  }
  if (fam.includes("llama") || raw.includes("llama")) {
    return icon("ai_llama");
  }
  if (fam.includes("mistral") || fam.includes("codestral") || raw.includes("mistral")) {
    return icon("ai_mistral");
  }
  if (fam.includes("claude") || raw.includes("claude")) {
    return icon("ai_claude");
  }

  // Dynamic 3D fallback for ANY arbitrary or future neural network
  return icon("ai_robot");
}

