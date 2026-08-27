import { ModelDiffItem } from "../types/domain.js";

export interface ParsedModelToken {
  raw: string;
  normalized: string;
  family: string;
  versionStr: string;
  versionMajor: number;
  versionMinor: number;
  variant: string;
  paramSize?: string;
}

export interface ModelCatalogDiff {
  poolSlug: string;
  poolName: string;
  hasChanges: boolean;
  added: ModelDiffItem[];
  upgraded: ModelDiffItem[];
  removed: ModelDiffItem[];
  currentModels: string[];
  previousModels: string[];
}

export class ModelSemanticMatcher {
  private static readonly FAMILY_PATTERNS: Array<{ family: string; regex: RegExp }> = [
    { family: "glm", regex: /\b(glm|chatglm)[-_ ]*(\d+(?:\.\d+)*)?/i },
    { family: "qwen", regex: /\b(qwen)[-_ ]*(\d+(?:\.\d+)*)?/i },
    { family: "kimi", regex: /\b(kimi|moonshot)[-_ ]*(k?\d+(?:\.\d+)*)?/i },
    { family: "deepseek", regex: /\b(deepseek)[-_ ]*(v?\d+(?:\.\d+)*|r\d+)?/i },
    { family: "mimo", regex: /\b(mimo)[-_ ]*(v?\d+(?:\.\d+)*)?/i },
    { family: "minimax", regex: /\b(minimax)[-_ ]*(m?\d+(?:\.\d+)*)?/i },
    { family: "llama", regex: /\b(llama)[-_ ]*(\d+(?:\.\d+)*)?/i },
    { family: "claude", regex: /\b(claude)[-_ ]*(\d+(?:\.\d+)*)?/i },
    { family: "mistral", regex: /\b(mistral|mixtral)[-_ ]*(\d+(?:\.\d+)*)?/i },
    { family: "gpt", regex: /\b(gpt)[-_ ]*(\d+(?:\.\d+)*)?/i },
    { family: "gemma", regex: /\b(gemma)[-_ ]*(\d+(?:\.\d+)*)?/i },
    { family: "phi", regex: /\b(phi)[-_ ]*(\d+(?:\.\d+)*)?/i },
    { family: "yi", regex: /\b(yi)[-_ ]*(\d+(?:\.\d+)*)?/i },
    { family: "command", regex: /\b(command)[-_ ]*(r?\d+(?:\.\d+)*)?/i },
  ];

  public static parseModel(raw: string): ParsedModelToken {
    const clean = raw.trim().toLowerCase();
    let family = "other";
    let versionStr = "";
    let versionMajor = 0;
    let versionMinor = 0;

    let bestMatch: { family: string; match: RegExpMatchArray; index: number } | null = null;
    for (const p of this.FAMILY_PATTERNS) {
      const m = clean.match(p.regex);
      if (m && m.index !== undefined) {
        if (!bestMatch || m.index < bestMatch.index) {
          bestMatch = { family: p.family, match: m, index: m.index };
        }
      }
    }

    if (bestMatch) {
      family = bestMatch.family;
      if (bestMatch.match[2]) {
        versionStr = bestMatch.match[2].replace(/^[vkr]/i, "").replace(/[-_]/g, ".");
      }
    }

    if (!versionStr) {
      const verMatch = clean.match(/(?:v|k|r)?(\d+)(?:[._-](\d+))?/i);
      if (verMatch) {
        versionStr = verMatch[2] ? `${verMatch[1]}.${verMatch[2]}` : verMatch[1];
        versionMajor = parseInt(verMatch[1], 10) || 0;
        versionMinor = parseInt(verMatch[2] || "0", 10) || 0;
      }
    } else {
      const parts = versionStr.split(".");
      versionMajor = parseInt(parts[0], 10) || 0;
      versionMinor = parseInt(parts[1] || "0", 10) || 0;
    }

    let variant = "";
    const variantMatch = clean.match(/\b(max|flash|turbo|plus|pro|coder|reasoner|chat|instruct|lite|ultra|base|large|small|medium|mini|haiku|sonnet|opus)\b/i);
    if (variantMatch) {
      variant = variantMatch[1].toLowerCase();
    }

    let paramSize: string | undefined;
    const paramMatch = clean.match(/\b(\d+x\d+b|\d+b)\b/i);
    if (paramMatch) {
      paramSize = paramMatch[1].toLowerCase();
    }

    return {
      raw,
      normalized: clean,
      family,
      versionStr,
      versionMajor,
      versionMinor,
      variant,
      paramSize,
    };
  }

  /**
   * Performs granular bipartite diff matching between two model arrays
   */
  public static diffModelLists(
    poolSlug: string,
    poolName: string,
    prevList: string[],
    newList: string[]
  ): ModelCatalogDiff {
    const prevNormalized = prevList.map((m) => this.parseModel(m));
    const newNormalized = newList.map((m) => this.parseModel(m));

    const exactMatches = new Set<string>();
    for (const n of newNormalized) {
      const match = prevNormalized.find((p) => p.normalized === n.normalized);
      if (match) {
        exactMatches.add(n.normalized);
      }
    }

    const removedCandidates = prevNormalized.filter((p) => !exactMatches.has(p.normalized));
    const addedCandidates = newNormalized.filter((n) => !exactMatches.has(n.normalized));

    const upgraded: ModelDiffItem[] = [];
    const usedRemoved = new Set<string>();
    const usedAdded = new Set<string>();

    // Phase 1: High-confidence family + variant upgrade pairing (e.g. glm-5.2 -> glm-5.3)
    for (const added of addedCandidates) {
      const match = removedCandidates.find(
        (rem) =>
          !usedRemoved.has(rem.normalized) &&
          rem.family !== "other" &&
          rem.family === added.family &&
          rem.variant === added.variant &&
          (rem.paramSize === added.paramSize || (!rem.paramSize && !added.paramSize))
      );

      if (match) {
        usedRemoved.add(match.normalized);
        usedAdded.add(added.normalized);
        upgraded.push({
          type: "upgraded",
          modelName: added.raw,
          previousModelName: match.raw,
          family: added.family,
          oldVersion: match.versionStr,
          newVersion: added.versionStr,
          changeNote: `${match.raw} ➡️ ${added.raw}`,
        });
      }
    }

    // Phase 2: Relaxed family upgrade pairing (e.g. qwen-2.5 -> qwen-3.5-turbo)
    for (const added of addedCandidates) {
      if (usedAdded.has(added.normalized)) continue;
      const match = removedCandidates.find(
        (rem) =>
          !usedRemoved.has(rem.normalized) &&
          rem.family !== "other" &&
          rem.family === added.family
      );

      if (match) {
        usedRemoved.add(match.normalized);
        usedAdded.add(added.normalized);
        upgraded.push({
          type: "upgraded",
          modelName: added.raw,
          previousModelName: match.raw,
          family: added.family,
          oldVersion: match.versionStr,
          newVersion: added.versionStr,
          changeNote: `${match.raw} ➡️ ${added.raw}`,
        });
      }
    }

    // Phase 3: Remaining additions
    const added: ModelDiffItem[] = addedCandidates
      .filter((n) => !usedAdded.has(n.normalized))
      .map((n) => ({
        type: "added",
        modelName: n.raw,
        family: n.family,
        newVersion: n.versionStr,
      }));

    // Phase 4: Remaining removals / deprecations
    const removed: ModelDiffItem[] = removedCandidates
      .filter((r) => !usedRemoved.has(r.normalized))
      .map((r) => ({
        type: "removed",
        modelName: r.raw,
        family: r.family,
        oldVersion: r.versionStr,
      }));

    const hasChanges = added.length > 0 || upgraded.length > 0 || removed.length > 0;

    return {
      poolSlug,
      poolName,
      hasChanges,
      added,
      upgraded,
      removed,
      currentModels: newList,
      previousModels: prevList,
    };
  }
}
