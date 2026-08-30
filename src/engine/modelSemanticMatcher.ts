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
    { family: "glm", regex: /\b(glm|chatglm)[-_ ]*(\d+(?:[._-]\d+)*)?/i },
    { family: "qwen", regex: /\b(qwen)[-_ ]*(\d+(?:[._-]\d+)*)?/i },
    { family: "kimi", regex: /\b(kimi|moonshot)[-_ ]*(k?\d+(?:[._-]\d+)*)?/i },
    { family: "deepseek", regex: /\b(deepseek)[-_ ]*(v?\d+(?:[._-]\d+)*|r\d+)?/i },
    { family: "mimo", regex: /\b(mimo)[-_ ]*(v?\d+(?:[._-]\d+)*)?/i },
    { family: "minimax", regex: /\b(minimax)[-_ ]*(m?\d+(?:[._-]\d+)*)?/i },
    { family: "llama", regex: /\b(llama)[-_ ]*(\d+(?:[._-]\d+)*)?/i },
    { family: "claude", regex: /\b(claude)[-_ ]*(\d+(?:[._-]\d+)*)?/i },
    { family: "mistral", regex: /\b(mistral|mixtral)[-_ ]*(\d+(?:[._-]\d+)*)?/i },
    { family: "gpt", regex: /\b(gpt)[-_ ]*(\d+(?:[._-]\d+)*)?/i },
    { family: "openai-o", regex: /\b(o[1-9])[-_ ]*(\d+(?:[._-]\d+)*)?/i },
    { family: "gemini", regex: /\b(gemini)[-_ ]*(\d+(?:[._-]\d+)*)?/i },
    { family: "gemma", regex: /\b(gemma)[-_ ]*(\d+(?:[._-]\d+)*)?/i },
    { family: "phi", regex: /\b(phi)[-_ ]*(\d+(?:[._-]\d+)*)?/i },
    { family: "yi", regex: /\b(yi)[-_ ]*(\d+(?:[._-]\d+)*)?/i },
    { family: "command", regex: /\b(command)[-_ ]*(r?\d+(?:[._-]\d+)*)?/i },
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

    let paramSize: string | undefined;
    const paramMatch = clean.match(/\b(\d+x\d+b|\d+b)\b/i);
    if (paramMatch) {
      paramSize = paramMatch[1].toLowerCase();
    }

    if (bestMatch) {
      family = bestMatch.family;
      if (bestMatch.match[2]) {
        versionStr = bestMatch.match[2].replace(/^[vkrm]/i, "").replace(/[-_]/g, ".");
      }
    }

    if (!versionStr) {
      const verMatch = clean.match(/(?:v|k|r|m)?(\d+)(?:[._-](\d+))?/i);
      if (verMatch) {
        versionStr = verMatch[2] ? `${verMatch[1]}.${verMatch[2]}` : verMatch[1];
        versionMajor = parseInt(verMatch[1], 10) || 0;
        versionMinor = parseInt(verMatch[2] || "0", 10) || 0;
      }
    }

    if (paramSize && versionStr) {
      const paramNum = paramSize.replace("b", "");
      if (versionStr.endsWith(`.${paramNum}`)) {
        versionStr = versionStr.substring(0, versionStr.length - paramNum.length - 1);
      }
    }

    if (versionStr) {
      const parts = versionStr.split(".");
      versionMajor = parseInt(parts[0], 10) || 0;
      versionMinor = parseInt(parts[1] || "0", 10) || 0;
    }

    let variant = "";
    const variantMatch = clean.match(/\b(max|flash|turbo|plus|pro|coder|reasoner|chat|instruct|lite|ultra|base|large|small|medium|mini|haiku|sonnet|opus)\b/i);
    if (variantMatch) {
      variant = variantMatch[1].toLowerCase();
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

  public static compareVersions(a: ParsedModelToken, b: ParsedModelToken): number {
    if (a.versionMajor !== b.versionMajor) {
      return a.versionMajor - b.versionMajor;
    }
    if (a.versionMinor !== b.versionMinor) {
      return a.versionMinor - b.versionMinor;
    }
    if (a.versionStr && b.versionStr) {
      return a.versionStr.localeCompare(b.versionStr, undefined, { numeric: true });
    }
    return 0;
  }

  /**
   * Performs granular bipartite diff matching between two model arrays
   * with full support for model version evolution, coexistence windows, and silent phaseouts.
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

    // Phase 1: Direct Upgrade Pairing (Replaced Models e.g. glm-5.2 -> glm-5.3)
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

    // Phase 2: Coexistence Upgrade Pairing (Newer version added while older version is still listed in pool)
    for (const added of addedCandidates) {
      if (usedAdded.has(added.normalized)) continue;
      if (added.family === "other") continue;

      // Find an existing predecessor in the same family with lower/equal version
      const predecessor = prevNormalized.find(
        (prev) =>
          prev.family === added.family &&
          prev.normalized !== added.normalized &&
          this.compareVersions(added, prev) > 0
      );

      if (predecessor) {
        usedAdded.add(added.normalized);
        upgraded.push({
          type: "upgraded",
          modelName: added.raw,
          previousModelName: predecessor.raw,
          family: added.family,
          oldVersion: predecessor.versionStr,
          newVersion: added.versionStr,
          changeNote: `${predecessor.raw} ➡️ ${added.raw}`,
        });
      }
    }

    // Phase 3: Relaxed family upgrade pairing for major generational transitions (e.g. qwen-2.5 -> qwen-3.5-turbo)
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

    // Phase 4: Superseded Phaseout Detection (Older model removed after its successor is already active in new list)
    for (const rem of removedCandidates) {
      if (usedRemoved.has(rem.normalized)) continue;
      if (rem.family === "other") continue;

      // Check if a newer version in the same family is already active in the new list
      const activeSuccessor = newNormalized.find(
        (curr) =>
          curr.family === rem.family &&
          this.compareVersions(curr, rem) >= 0
      );

      if (activeSuccessor) {
        // Silently mark as superseded phaseout without triggering false-alarm model deletion
        usedRemoved.add(rem.normalized);
      }
    }

    // Phase 5: Remaining additions
    const added: ModelDiffItem[] = addedCandidates
      .filter((n) => !usedAdded.has(n.normalized))
      .map((n) => ({
        type: "added",
        modelName: n.raw,
        family: n.family,
        newVersion: n.versionStr,
      }));

    // Phase 6: Remaining genuine removals / deprecations
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
