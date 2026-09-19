import { ModelDiffItem, ModelCatalogDiff } from "../types/domain.js";
export { ModelCatalogDiff };

export interface ParsedModelToken {
  raw: string;
  normalized: string;
  family: string;
  versionStr: string;
  versionMajor: number;
  versionMinor: number;
  versionPatch?: number;
  variant: string;
  paramSize?: string;
  dateCode?: number;
}

export class ModelSemanticMatcher {
  // Known architectural variant tokens (common modifiers across the AI ecosystem)
  private static readonly VARIANT_PATTERN =
    /\b(max|flash|turbo|plus|pro|coder|reasoner|chat|instruct|lite|ultra|base|large|small|medium|mini|haiku|sonnet|opus|preview|vision|vl|moe|dense|distill|air|longcontext)\b/i;

  // Structural parameter size pattern (e.g. 70b, 8x7b, 32b, 0.5b, 340b, 1m)
  private static readonly PARAM_SIZE_PATTERN = /\b(\d+(?:\.\d+)?(?:x\d+)?\s*[bmk])\b/i;

  // Structural date code pattern (e.g. 20241022, 20240620, 2407, 2501, 08-2024)
  private static readonly DATE_CODE_PATTERN = /\b((?:20\d{2}[-_]?\d{2}[-_]?\d{2})|(?:\d{2}[01]\d))\b/;

  /**
   * Universal AI Model Parser:
   * Pure linguistic & structural token decomposition without hardcoding specific model brand names.
   * Dynamically breaks ANY arbitrary current or future model string into:
   * [Namespace] -> [Family Stem] -> [Semantic Version] -> [Variant] -> [Param Size] -> [Date Code]
   */
  public static parseModel(raw: string): ParsedModelToken {
    let clean = raw.trim().toLowerCase();

    // 1. Strip organization / namespace prefix (e.g. "meta-llama/", "deepseek-ai/", "google/", "01-ai-")
    clean = clean.replace(/^[a-z0-9_.-]+\//i, "");

    // 2. Normalize compound names and typographical variants before token splitting
    clean = clean.replace(/\bmini[-_ ]?max\b/gi, "minimax");
    clean = clean.replace(/\bchat[-_]?glm\b/gi, "glm");
    clean = clean.replace(/\bmino\b/gi, "mimo");

    // 3. Extract structural parameter size (e.g. 70b, 32b, 8x7b)
    let paramSize: string | undefined;
    const paramMatch = clean.match(this.PARAM_SIZE_PATTERN);
    if (paramMatch) {
      paramSize = paramMatch[1].toLowerCase().replace(/\s+/g, "");
    }

    // 4. Extract architectural variant modifier (e.g. flash, turbo, coder, instruct)
    let variant = "";
    const variantMatches = clean.match(new RegExp(this.VARIANT_PATTERN.source, "gi"));
    if (variantMatches && variantMatches.length > 0) {
      variant = variantMatches[0].toLowerCase();
    }

    // 4. Extract date revision code (e.g. 2407, 20241022)
    let dateCode: number | undefined;
    const dateMatch = clean.match(this.DATE_CODE_PATTERN);
    if (dateMatch) {
      const parsedDate = parseInt(dateMatch[1].replace(/[-_]/g, ""), 10);
      if (!isNaN(parsedDate) && parsedDate > 0) {
        dateCode = parsedDate;
      }
    }

    // 5. Extract multi-segment semantic version (e.g. "v4.1", "3.5", "r1", "k2", "1.2.3")
    let versionStr = "";
    let versionMajor = 0;
    let versionMinor = 0;
    let versionPatch = 0;

    // Clean out extracted paramSize and dateCode to avoid false version matching
    let working = clean;
    if (paramSize) {
      working = working.replace(new RegExp(`\\b${paramSize}\\b`, "i"), "");
    }
    if (dateMatch) {
      working = working.replace(new RegExp(`\\b${dateMatch[1]}\\b`, "i"), "");
    }

    // Match explicit version markers:
    // a) Version with dot notation (e.g. v4.1, 3.5, 1.2.3)
    // b) Version with hyphenated sub-version (e.g. claude-3-5-sonnet, gemini-1-5-pro)
    // c) Version with single integer preceded by v/r/k/m/o (e.g. v4, r1, k2, m3, o1)
    // d) Delimited integer between tokens (e.g. grok-2, nemotron-4, llama-3)
    // e) Alphanumeric boundary digits (e.g. grok2, qwen3)
    const verMatch =
      working.match(/(?:^|[-_ .])(?:v|r|k|m|o)?(\d+(?:\.\d+)+)(?:[-_ .]|$)/i) ||
      working.match(/(?:^|[-_ .])(?:v|r|k|m|o)?(\d+(?:[-_]\d+)+)(?:[-_ .]|$)/i) ||
      working.match(/(?:^|[-_ .])(?:v|r|k|m|o)(\d+)(?:[-_ .]|$)/i) ||
      working.match(/(?:^|[-_ .])(\d+)(?:o|omni)(?:[-_ .]|$)/i) ||
      working.match(/[-_ .](\d+)(?:[-_ .]|$)/i) ||
      working.match(/([a-z]+)(\d+)(?:[-_ .]|$)/i);

    if (verMatch) {
      // If matched by inline pattern like grok2 -> group 2 is the digits
      const digits = verMatch[2] && !verMatch[1].match(/^\d/) ? verMatch[2] : verMatch[1];
      versionStr = digits.replace(/[-_]/g, ".");
      const parts = versionStr.split(".");
      versionMajor = parseInt(parts[0], 10) || 0;
      versionMinor = parseInt(parts[1] || "0", 10) || 0;
      versionPatch = parseInt(parts[2] || "0", 10) || 0;
    }

    // 6. Derive Canonical Family Stem:
    // Remove the version token, variant, param size, date code and punctuation
    let stemWorking = clean;
    if (paramSize) {
      stemWorking = stemWorking.replace(new RegExp(`\\b${paramSize}\\b`, "i"), "");
    }
    if (dateMatch) {
      stemWorking = stemWorking.replace(new RegExp(`\\b${dateMatch[1]}\\b`, "i"), "");
    }
    // Globally strip all architectural variant tokens from stem
    stemWorking = stemWorking.replace(new RegExp(this.VARIANT_PATTERN.source, "gi"), "");

    if (versionStr) {
      // Remove version digits and common prefixes (v, r, k, m, o)
      const verRegexPart = versionStr.replace(/\./g, "[-_.]?");
      stemWorking = stemWorking.replace(new RegExp(`(?:v|r|k|m|o)?${verRegexPart}`, "i"), "");
    }

    // Clean up trailing and leading punctuation/delimiters
    let family = stemWorking
      .replace(/[-_ .]+/g, "-")
      .replace(/^[-_ .]+|[-_ .]+$/g, "")
      .trim();

    // Fallback: if stem reduced to empty, take the first continuous alphabetic token
    if (!family || family.length < 2) {
      const fallbackMatch = clean.match(/^([a-z]+)/i);
      family = fallbackMatch ? fallbackMatch[1] : "generic";
    }

    return {
      raw,
      normalized: clean,
      family,
      versionStr,
      versionMajor,
      versionMinor,
      versionPatch,
      variant,
      paramSize,
      dateCode,
    };
  }

  /**
   * Generalized Family Matcher:
   * Compares any two models using exact stem equality, ecosystem aliases,
   * or common prefix/containment matching.
   */
  public static areModelsSameFamily(a: ParsedModelToken, b: ParsedModelToken): boolean {
    if (a.family === b.family && a.family !== "generic") {
      return true;
    }
    // Ecosystem Aliases (Moonshot AI / Kimi)
    if (
      (a.family === "kimi" && b.family === "moonshot") ||
      (a.family === "moonshot" && b.family === "kimi")
    ) {
      return true;
    }
    // Prefix / Substring containment (e.g. "llama" and "meta-llama", "glm" and "glm-coder")
    if (
      a.family.length >= 3 &&
      b.family.length >= 3 &&
      (a.family.startsWith(b.family) || b.family.startsWith(a.family))
    ) {
      return true;
    }
    return false;
  }

  /**
   * Multi-Segment Semantic Version & Generational Comparator
   */
  public static compareVersions(a: ParsedModelToken, b: ParsedModelToken): number {
    if (a.versionMajor !== b.versionMajor) {
      return a.versionMajor - b.versionMajor;
    }
    if (a.versionMinor !== b.versionMinor) {
      return a.versionMinor - b.versionMinor;
    }
    const patchA = a.versionPatch ?? 0;
    const patchB = b.versionPatch ?? 0;
    if (patchA !== patchB) {
      return patchA - patchB;
    }
    if (a.dateCode && b.dateCode && a.dateCode !== b.dateCode) {
      return a.dateCode - b.dateCode;
    }
    if (a.versionStr && b.versionStr && a.versionStr !== b.versionStr) {
      const partsA = a.versionStr.split(/[._-]/).map((p) => parseInt(p, 10) || 0);
      const partsB = b.versionStr.split(/[._-]/).map((p) => parseInt(p, 10) || 0);
      const maxLen = Math.max(partsA.length, partsB.length);
      for (let i = 0; i < maxLen; i++) {
        const valA = partsA[i] || 0;
        const valB = partsB[i] || 0;
        if (valA !== valB) return valA - valB;
      }
      return a.versionStr.localeCompare(b.versionStr, undefined, { numeric: true });
    }
    if (a.versionStr && !b.versionStr) return 1;
    if (!a.versionStr && b.versionStr) return -1;
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

    // Phase 1: Direct Upgrade Pairing (Replaced Models e.g. glm-5.2 -> glm-5.3 or custom-v1 -> custom-v2)
    for (const added of addedCandidates) {
      const match = removedCandidates.find(
        (rem) =>
          !usedRemoved.has(rem.normalized) &&
          this.areModelsSameFamily(rem, added) &&
          rem.variant === added.variant &&
          (rem.paramSize === added.paramSize || (!rem.paramSize && !added.paramSize))
      );

      if (match) {
        const cmp = this.compareVersions(added, match);
        if (cmp > 0) {
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
        } else if (cmp < 0) {
          // Version rollback / temporary cache downgrade: consume candidates to prevent false upgrade alerts
          usedRemoved.add(match.normalized);
          usedAdded.add(added.normalized);
        }
      }
    }

    // Phase 2: Coexistence Upgrade Pairing (Newer version added while older version is still listed in pool)
    for (const added of addedCandidates) {
      if (usedAdded.has(added.normalized)) continue;

      // Find best matching predecessor in the same family with lower version
      const candidates = prevNormalized
        .filter(
          (prev) =>
            this.areModelsSameFamily(prev, added) &&
            prev.normalized !== added.normalized &&
            this.compareVersions(added, prev) > 0
        )
        .sort((a, b) => {
          const aScore =
            (a.variant === added.variant ? 2 : 0) +
            (a.paramSize === added.paramSize ? 2 : 0);
          const bScore =
            (b.variant === added.variant ? 2 : 0) +
            (b.paramSize === added.paramSize ? 2 : 0);
          if (aScore !== bScore) return bScore - aScore;
          return this.compareVersions(b, a);
        });

      const predecessor = candidates[0];
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
          this.areModelsSameFamily(rem, added)
      );

      if (match) {
        const cmp = this.compareVersions(added, match);
        if (cmp > 0) {
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
        } else if (cmp < 0) {
          usedRemoved.add(match.normalized);
          usedAdded.add(added.normalized);
        }
      }
    }

    // Phase 4: Superseded Phaseout Detection (Older model removed after its successor is already active in new list)
    for (const rem of removedCandidates) {
      if (usedRemoved.has(rem.normalized)) continue;

      // Check if a newer version in the same family with matching variant/paramSize is already active in the new list
      const activeSuccessor = newNormalized.find(
        (curr) =>
          this.areModelsSameFamily(curr, rem) &&
          (curr.variant === rem.variant || !rem.variant) &&
          (curr.paramSize === rem.paramSize || !rem.paramSize) &&
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
