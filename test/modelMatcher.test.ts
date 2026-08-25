import { describe, it, expect } from "vitest";
import { ModelSemanticMatcher } from "../src/engine/modelSemanticMatcher.js";

describe("ModelSemanticMatcher", () => {
  it("should parse model tokens with family, version, and variants", () => {
    const glm = ModelSemanticMatcher.parseModel("glm-5.2");
    expect(glm.family).toBe("glm");
    expect(glm.versionMajor).toBe(5);
    expect(glm.versionMinor).toBe(2);

    const qwen = ModelSemanticMatcher.parseModel("qwen-3.8-max");
    expect(qwen.family).toBe("qwen");
    expect(qwen.variant).toBe("max");

    const deepseek = ModelSemanticMatcher.parseModel("deepseek-v4-flash");
    expect(deepseek.family).toBe("deepseek");
    expect(deepseek.variant).toBe("flash");
  });

  it("should accurately detect model upgrades (e.g. GLM 5.2 -> GLM 5.3)", () => {
    const diff = ModelSemanticMatcher.diffModelLists(
      "frontier",
      "Frontier Pool",
      ["glm-5.2", "minimax-m3"],
      ["glm-5.3", "minimax-m3"]
    );

    expect(diff.hasChanges).toBe(true);
    expect(diff.upgraded).toHaveLength(1);
    expect(diff.upgraded[0].modelName).toBe("glm-5.3");
    expect(diff.upgraded[0].previousModelName).toBe("glm-5.2");
    expect(diff.upgraded[0].changeNote).toBe("glm-5.2 ➡️ glm-5.3");
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it("should detect newly added models", () => {
    const diff = ModelSemanticMatcher.diffModelLists(
      "flagship",
      "Flagship Pool",
      ["kimi-k3", "qwen3.8-max"],
      ["kimi-k3", "qwen3.8-max", "qwen-3.5-turbo"]
    );

    expect(diff.hasChanges).toBe(true);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].modelName).toBe("qwen-3.5-turbo");
    expect(diff.upgraded).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it("should detect removed / deprecated models", () => {
    const diff = ModelSemanticMatcher.diffModelLists(
      "core",
      "Core Pool",
      ["deepseek-v4-flash", "mimo-v2.5"],
      ["deepseek-v4-flash"]
    );

    expect(diff.hasChanges).toBe(true);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0].modelName).toBe("mimo-v2.5");
  });

  it("should return hasChanges = false when models are identical", () => {
    const diff = ModelSemanticMatcher.diffModelLists(
      "core",
      "Core Pool",
      ["deepseek-v4-flash", "mimo-v2.5"],
      ["deepseek-v4-flash", "mimo-v2.5"]
    );

    expect(diff.hasChanges).toBe(false);
    expect(diff.added).toHaveLength(0);
    expect(diff.upgraded).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });
});
