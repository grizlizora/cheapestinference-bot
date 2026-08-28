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

  it("should auto-resolve 3D custom emojis for all recognized model families", async () => {
    const { getModel3DIcon } = await import("../src/bot/views/iconTheme.js");

    expect(getModel3DIcon("DeepSeek-R1-Distill-Qwen-32B")).toContain("5222292529533167322");
    expect(getModel3DIcon("Qwen2.5-Coder-32B-Instruct")).toContain("5361837567463399422");
    expect(getModel3DIcon("GLM-4-Plus")).toContain("5217444336089714383");
    expect(getModel3DIcon("Kimi-K1.5-LongContext")).toContain("5451959871257713464");
    expect(getModel3DIcon("Moonshot-v1-32k")).toContain("5451959871257713464");
    expect(getModel3DIcon("mimo-v2.5")).toContain("5407025283456835913");
    expect(getModel3DIcon("minimax-m3")).toContain("5397575638146110953");
    expect(getModel3DIcon("Meta-Llama-3.3-70B-Instruct")).toContain("5343553685525899318");
    expect(getModel3DIcon("Mistral-Large-2407")).toContain("6332347924063717264");
    expect(getModel3DIcon("Claude-3.5-Sonnet")).toContain("5325547803936572038");
    expect(getModel3DIcon("Unknown-Custom-Model-v1")).toContain("5372981976804366741");
  });
});
