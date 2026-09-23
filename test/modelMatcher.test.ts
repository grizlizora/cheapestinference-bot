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

    const minimax = ModelSemanticMatcher.parseModel("minimax-m3");
    expect(minimax.family).toBe("minimax");
    expect(minimax.versionMajor).toBe(3);
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

  it("should recognize model upgrade during coexistence window when both versions exist on site (e.g. GLM 5.2 and GLM 5.3 simultaneously)", () => {
    // Tick 1: Site adds glm-5.3 but keeps glm-5.2 in the list
    const diff = ModelSemanticMatcher.diffModelLists(
      "frontier",
      "Frontier Speed",
      ["minimax-m3", "glm-5.2"],
      ["minimax-m3", "glm-5.2", "glm-5.3"]
    );

    expect(diff.hasChanges).toBe(true);
    expect(diff.upgraded).toHaveLength(1);
    expect(diff.upgraded[0].modelName).toBe("glm-5.3");
    expect(diff.upgraded[0].previousModelName).toBe("glm-5.2");
    expect(diff.upgraded[0].changeNote).toBe("glm-5.2 ➡️ glm-5.3");
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it("should silently handle subsequent removal of superseded predecessor (GLM 5.2) without emitting false model loss alert", () => {
    // Tick 2: Site subsequently removes glm-5.2 while glm-5.3 is active
    const diff = ModelSemanticMatcher.diffModelLists(
      "frontier",
      "Frontier Speed",
      ["minimax-m3", "glm-5.2", "glm-5.3"],
      ["minimax-m3", "glm-5.3"]
    );

    expect(diff.hasChanges).toBe(false);
    expect(diff.upgraded).toHaveLength(0);
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
    expect(getModel3DIcon("Kimi-K1.5-LongContext")).toContain("5449569374065152798");
    expect(getModel3DIcon("Moonshot-v1-32k")).toContain("5449569374065152798");
    expect(getModel3DIcon("mimo-v2.5")).toContain("5407025283456835913");
    expect(getModel3DIcon("minimax-m3")).toContain("5397575638146110953");
    expect(getModel3DIcon("Meta-Llama-3.3-70B-Instruct")).toContain("5343553685525899318");
    expect(getModel3DIcon("Mistral-Large-2407")).toContain("6332347924063717264");
    expect(getModel3DIcon("Claude-3.5-Sonnet")).toContain("5325547803936572038");
    expect(getModel3DIcon("Unknown-Custom-Model-v1")).toContain("5372981976804366741");
  });

  it("should NOT treat a version rollback/downgrade (e.g. DeepSeek v4.1 -> v4) as an upgrade", () => {
    const diff = ModelSemanticMatcher.diffModelLists(
      "core",
      "Core Pool",
      ["mimo-v2.5", "deepseek-v4.1-flash"],
      ["mimo-v2.5", "deepseek-v4-flash"]
    );

    // Downgrades must NOT be put into upgraded list
    expect(diff.upgraded).toHaveLength(0);
  });

  it("should render 3D lightning icon in model upgrade alert formatting", async () => {
    const { formatSingleAlertMessage } = await import("../src/bot/notifier/formatters/singleAlertFormatter.js");

    const event = {
      id: "test-event",
      type: "MODEL_UPGRADE_EVENT" as const,
      poolSlug: "core",
      poolName: "Core Pool",
      block: "ALL",
      models: ["deepseek-v4.1-flash", "mimo-v2.5"],
      hoursUtc: "",
      timestamp: Date.now(),
      modelUpgrade: {
        added: [],
        upgraded: [
          {
            type: "upgraded" as const,
            modelName: "deepseek-v4.1-flash",
            previousModelName: "deepseek-v4-flash",
            family: "deepseek",
            oldVersion: "4",
            newVersion: "4.1",
            changeNote: "deepseek-v4-flash ➔ deepseek-v4.1-flash",
          },
        ],
        removed: [],
        allActiveModels: ["deepseek-v4.1-flash", "mimo-v2.5"],
      },
    };

    const user = {
      userId: 1,
      telegramId: 123456,
      language: "uk" as const,
      isAdmin: false,
      isMuted: false,
    };

    const msg = formatSingleAlertMessage(user as any, event, "P2");
    // Must contain 3D animated lightning emoji ID (5456140674028019486)
    expect(msg.text).toContain("5456140674028019486");
    // Must NOT contain flat 2D lightning standalone on the upgrade line
    expect(msg.text).not.toContain("  ⚡ <code>deepseek-v4-flash</code>");
  });

  it("should render 3D fire icon and no nested parentheses in bundled price discount alert", async () => {
    const { formatBundledAlertMessage } = await import("../src/bot/notifier/formatters/bundleAlertFormatter.js");

    const event = {
      id: "price-event",
      type: "SLOT_PRICE_CHANGED" as const,
      poolSlug: "flagship",
      poolName: "Flagship Pool",
      block: "asia",
      models: ["qwen-3.8-max"],
      previousPrice: "363",
      newPrice: "207",
      hoursUtc: "00:00-08:00 UTC",
      timestamp: Date.now(),
      slotPrice: {
        priceDelta: -156,
        percentageDelta: -43,
        previousPrice: 363,
        newPrice: 207,
        isDiscount: true,
      },
    };

    const user = {
      userId: 1,
      telegramId: 123456,
      language: "uk" as const,
      isAdmin: false,
      isMuted: false,
    };

    const bundle = formatBundledAlertMessage(user as any, [{ event: event as any, priority: "P2" }]);
    // Must contain 3D hot flame emoji ID (5420315771991497307)
    expect(bundle.text).toContain("5420315771991497307");
    // Must NOT contain double nested parentheses like ( 🟢 ... (-43%) ... )
    expect(bundle.text).not.toMatch(/\(\s*<tg-emoji[^>]*>.*?\(-43%\).*?\)/);
    expect(bundle.text).not.toContain("( 🟢 Знижка");
    expect(bundle.text).toContain("• <tg-emoji");
  });

  it("should dynamically detect arbitrary unknown/future neural networks without hardcoding", () => {
    // 1. Completely arbitrary future AI
    const diff1 = ModelSemanticMatcher.diffModelLists(
      "custom-pool",
      "Custom Pool",
      ["futuristic-neuro-transformer-v1.0"],
      ["futuristic-neuro-transformer-v2.0"]
    );
    expect(diff1.hasChanges).toBe(true);
    expect(diff1.upgraded).toHaveLength(1);
    expect(diff1.upgraded[0].previousModelName).toBe("futuristic-neuro-transformer-v1.0");
    expect(diff1.upgraded[0].modelName).toBe("futuristic-neuro-transformer-v2.0");

    // 2. Grok evolution (grok-2 -> grok-3)
    const diffGrok = ModelSemanticMatcher.diffModelLists(
      "xai-pool",
      "xAI Pool",
      ["xai/grok-2"],
      ["xai/grok-3"]
    );
    expect(diffGrok.upgraded).toHaveLength(1);
    expect(diffGrok.upgraded[0].newVersion).toBe("3");

    // 3. Nemotron 340B evolution (nemotron-4-340b -> nemotron-5-340b)
    const diffNemo = ModelSemanticMatcher.diffModelLists(
      "nvidia-pool",
      "Nvidia Pool",
      ["nvidia/nemotron-4-340b"],
      ["nvidia/nemotron-5-340b"]
    );
    expect(diffNemo.upgraded).toHaveLength(1);
    expect(diffNemo.upgraded[0].modelName).toBe("nvidia/nemotron-5-340b");

    // 4. Date-based revision upgrades (e.g. 2402 -> 2407)
    const diffDate = ModelSemanticMatcher.diffModelLists(
      "mistral-pool",
      "Mistral Pool",
      ["mistral-large-2402"],
      ["mistral-large-2407"]
    );
    expect(diffDate.upgraded).toHaveLength(1);
    expect(diffDate.upgraded[0].modelName).toBe("mistral-large-2407");

    // 5. Hyphenated sub-version parsing (e.g. claude-3-5-sonnet -> claude-3-7-sonnet)
    const diffHyphen = ModelSemanticMatcher.diffModelLists(
      "anthropic-pool",
      "Anthropic Pool",
      ["claude-3-5-sonnet"],
      ["claude-3-7-sonnet"]
    );
    expect(diffHyphen.upgraded).toHaveLength(1);
    expect(diffHyphen.upgraded[0].oldVersion).toBe("3.5");
    expect(diffHyphen.upgraded[0].newVersion).toBe("3.7");

    // 6. Arbitrary semantic patch upgrade (1.2.3 -> 1.2.4)
    const diffPatch = ModelSemanticMatcher.diffModelLists(
      "custom-pool",
      "Custom Pool",
      ["community/any-model-1.2.3"],
      ["community/any-model-1.2.4"]
    );
    expect(diffPatch.upgraded).toHaveLength(1);
    expect(diffPatch.upgraded[0].newVersion).toBe("1.2.4");
  });

  it("should prioritize matching parameter size during coexistence pairing", () => {
    // Both 8b and 70b exist; 70b gets upgraded to v2. Must pair with 70b, NOT 8b!
    const diff = ModelSemanticMatcher.diffModelLists(
      "llama-pool",
      "Llama Pool",
      ["custom-llama-v1-8b", "custom-llama-v1-70b"],
      ["custom-llama-v1-8b", "custom-llama-v1-70b", "custom-llama-v2-70b"]
    );

    expect(diff.hasChanges).toBe(true);
    expect(diff.upgraded).toHaveLength(1);
    expect(diff.upgraded[0].modelName).toBe("custom-llama-v2-70b");
    expect(diff.upgraded[0].previousModelName).toBe("custom-llama-v1-70b");
  });

  it("should NOT pair completely unrelated neural network architectures", () => {
    const diff = ModelSemanticMatcher.diffModelLists(
      "mixed-pool",
      "Mixed Pool",
      ["model-alpha-v1"],
      ["model-beta-v2"]
    );

    // Unrelated stems must be reported as 1 removed + 1 added, NOT upgraded
    expect(diff.upgraded).toHaveLength(0);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0].modelName).toBe("model-alpha-v1");
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].modelName).toBe("model-beta-v2");
  });

  it("should render 3D lightning icon in bundled alert for model upgrades", async () => {
    const { formatBundledAlertMessage } = await import("../src/bot/notifier/formatters/bundleAlertFormatter.js");

    const event = {
      id: "bundle-upgrade-event",
      type: "MODEL_UPGRADE_EVENT" as const,
      poolSlug: "frontier",
      poolName: "Frontier Speed",
      block: "ALL",
      models: ["glm-5.3"],
      hoursUtc: "",
      timestamp: Date.now(),
      modelUpgrade: {
        added: [],
        upgraded: [
          {
            type: "upgraded" as const,
            modelName: "glm-5.3",
            previousModelName: "glm-5.2",
            family: "glm",
            oldVersion: "5.2",
            newVersion: "5.3",
            changeNote: "glm-5.2 ➡️ glm-5.3",
          },
        ],
        removed: [],
        allActiveModels: ["glm-5.3"],
      },
    };

    const user = {
      userId: 1,
      telegramId: 123456,
      language: "uk" as const,
      isAdmin: false,
      isMuted: false,
    };

    const bundle = formatBundledAlertMessage(user as any, [{ event: event as any, priority: "P2" }]);
    // Must contain 3D animated lightning emoji ID (5456140674028019486)
    expect(bundle.text).toContain("5456140674028019486");
    expect(bundle.text).toContain("<code>glm-5.2</code> ➔ <code>glm-5.3</code>");
  });

  it("should seamlessly handle all core models requested by user: Kimi, Qwen, GLM, MiniMax, DeepSeek, MiMo", () => {
    // 1. Kimi / Moonshot ecosystem alias upgrade
    const diffKimi = ModelSemanticMatcher.diffModelLists(
      "kimi-pool",
      "Kimi Pool",
      ["moonshot-v1-32k"],
      ["kimi-k1.5"]
    );
    expect(diffKimi.upgraded).toHaveLength(1);
    expect(diffKimi.upgraded[0].changeNote).toBe("moonshot-v1-32k ➡️ kimi-k1.5");

    // 2. Kimi version bump (k1.5 -> k2)
    const diffKimi2 = ModelSemanticMatcher.diffModelLists(
      "kimi-pool",
      "Kimi Pool",
      ["kimi-k1.5"],
      ["kimi-k2"]
    );
    expect(diffKimi2.upgraded).toHaveLength(1);
    expect(diffKimi2.upgraded[0].newVersion).toBe("2");

    // 3. MiniMax with compound spacing ("mini max-m3" -> "minimax-m4")
    const diffMiniMax = ModelSemanticMatcher.diffModelLists(
      "minimax-pool",
      "MiniMax Pool",
      ["mini max-m3"],
      ["minimax-m4"]
    );
    expect(diffMiniMax.upgraded).toHaveLength(1);
    expect(diffMiniMax.upgraded[0].changeNote).toBe("mini max-m3 ➡️ minimax-m4");

    // 4. GLM & ChatGLM unification (chatglm-3 -> glm-4)
    const diffGLM = ModelSemanticMatcher.diffModelLists(
      "glm-pool",
      "GLM Pool",
      ["chatglm-3"],
      ["glm-4"]
    );
    expect(diffGLM.upgraded).toHaveLength(1);
    expect(diffGLM.upgraded[0].changeNote).toBe("chatglm-3 ➡️ glm-4");

    // 5. MiMo and typographical variant mino ("mino-v2" -> "mimo-v2.5")
    const diffMiMo = ModelSemanticMatcher.diffModelLists(
      "mimo-pool",
      "MiMo Pool",
      ["mino-v2"],
      ["mimo-v2.5"]
    );
    expect(diffMiMo.upgraded).toHaveLength(1);
    expect(diffMiMo.upgraded[0].changeNote).toBe("mino-v2 ➡️ mimo-v2.5");

    // 6. Qwen with multi-variant tokens (coder + instruct stripped cleanly)
    const diffQwen = ModelSemanticMatcher.diffModelLists(
      "qwen-pool",
      "Qwen Pool",
      ["qwen-2.5-coder-32b-instruct"],
      ["qwen-3-coder-32b-instruct"]
    );
    expect(diffQwen.upgraded).toHaveLength(1);
    expect(diffQwen.upgraded[0].family).toBe("qwen");

    // 7. DeepSeek Distill models stay within their distill sub-family
    const diffDeepSeekDistill = ModelSemanticMatcher.diffModelLists(
      "frontier",
      "Frontier Pool",
      ["DeepSeek-R1-Distill-Qwen-32B"],
      ["DeepSeek-R2-Distill-Qwen-32B"]
    );
    expect(diffDeepSeekDistill.upgraded).toHaveLength(1);
    expect(diffDeepSeekDistill.upgraded[0].changeNote).toBe("DeepSeek-R1-Distill-Qwen-32B ➡️ DeepSeek-R2-Distill-Qwen-32B");

    // 8. DeepSeek Distill is NOT falsely paired with plain Qwen
    const diffNoCrossPair = ModelSemanticMatcher.diffModelLists(
      "frontier",
      "Frontier Pool",
      ["qwen-2.5-32b"],
      ["DeepSeek-R1-Distill-Qwen-32B"]
    );
    expect(diffNoCrossPair.upgraded).toHaveLength(0);
    expect(diffNoCrossPair.removed).toHaveLength(1);
    expect(diffNoCrossPair.added).toHaveLength(1);
  });

  describe("filterSupersededModels & Active Models Resolution", () => {
    it("should generically prune superseded predecessors for arbitrary unknown/future models without hardcoding", () => {
      const input = ["futureai-v1.0", "futureai-v2.0-turbo", "quantum-net-v4"];
      const active = ModelSemanticMatcher.filterSupersededModels(input);
      expect(active).toEqual(["futureai-v2.0-turbo", "quantum-net-v4"]);
      expect(active).toHaveLength(2);
    });

    it("should retain distinct specialized variants (e.g. coder vs instruct) in the same family", () => {
      const input = ["qwen-2.5-coder", "qwen-2.5-instruct", "deepseek-v3"];
      const active = ModelSemanticMatcher.filterSupersededModels(input);
      expect(active).toContain("qwen-2.5-coder");
      expect(active).toContain("qwen-2.5-instruct");
      expect(active).toContain("deepseek-v3");
      expect(active).toHaveLength(3);
    });

    it("should retain distinct parameter size tiers (e.g. 8b vs 70b) in the same family", () => {
      const input = ["llama-3-8b", "llama-3-70b"];
      const active = ModelSemanticMatcher.filterSupersededModels(input);
      expect(active).toContain("llama-3-8b");
      expect(active).toContain("llama-3-70b");
      expect(active).toHaveLength(2);
    });

    it("should exclude superseded mimo-v2.5 when mimo-v2.6-flash is upgraded during coexistence", () => {
      const prevList = ["deepseek-v4.1-flash", "mimo-v2.5"];
      const newList = ["deepseek-v4.1-flash", "mimo-v2.5", "mimo-v2.6-flash"];

      const diff = ModelSemanticMatcher.diffModelLists(
        "core",
        "Core Pool — DeepSeek V4.1 Flash, MiMo V2.6 Flash",
        prevList,
        newList
      );

      expect(diff.hasChanges).toBe(true);
      expect(diff.upgraded).toHaveLength(1);
      expect(diff.upgraded[0].previousModelName).toBe("mimo-v2.5");
      expect(diff.upgraded[0].modelName).toBe("mimo-v2.6-flash");

      // In activeModels, mimo-v2.5 MUST be pruned out!
      expect(diff.activeModels).toHaveLength(2);
      expect(diff.activeModels).toContain("deepseek-v4.1-flash");
      expect(diff.activeModels).toContain("mimo-v2.6-flash");
      expect(diff.activeModels).not.toContain("mimo-v2.5");
    });

    it("should format single alert with exact active model count and without superseded models", async () => {
      const { formatSingleAlertMessage } = await import("../src/bot/notifier/formatters/singleAlertFormatter.js");

      const user = {
        userId: 1,
        telegramId: 12345,
        language: "uk" as const,
        isAdmin: false,
        isMuted: false,
      };

      const event = {
        id: "test-event-1",
        type: "MODEL_UPGRADE_EVENT" as const,
        poolSlug: "core",
        poolName: "Core Pool — DeepSeek V4.1 Flash, MiMo V2.6 Flash",
        block: "ALL",
        models: ["mimo-v2.5", "mimo-v2.6-flash", "deepseek-v4.1-flash"],
        hoursUtc: "",
        timestamp: Date.now(),
        modelUpgrade: {
          added: [],
          upgraded: [
            {
              type: "upgraded" as const,
              modelName: "mimo-v2.6-flash",
              previousModelName: "mimo-v2.5",
              family: "mimo",
              oldVersion: "2.5",
              newVersion: "2.6",
              changeNote: "mimo-v2.5 ➡️ mimo-v2.6-flash",
            },
          ],
          removed: [],
          allActiveModels: ["deepseek-v4.1-flash", "mimo-v2.6-flash"],
        },
      };

      const alert = formatSingleAlertMessage(user as any, event as any, "P2");

      // Verify active models count is 2 (NOT 3!)
      expect(alert.text).toContain("Усі активні моделі (2):");
      expect(alert.text).not.toContain("Усі активні моделі (3):");

      // Verify diff line has the upgrade
      expect(alert.text).toContain("mimo-v2.5");
      expect(alert.text).toContain("mimo-v2.6-flash");

      // Verify in 'Усі активні моделі' section, mimo-v2.5 is NOT listed after the label
      const activeSection = alert.text.split("Усі активні моделі (2):")[1];
      expect(activeSection).toBeDefined();
      expect(activeSection).toContain("mimo-v2.6-flash");
      expect(activeSection).toContain("deepseek-v4.1-flash");
      expect(activeSection).not.toContain("mimo-v2.5");
    });

    it("should format bundled alert without superseded models in fallback", async () => {
      const { formatBundledAlertMessage } = await import("../src/bot/notifier/formatters/bundleAlertFormatter.js");

      const user = {
        userId: 1,
        telegramId: 12345,
        language: "uk" as const,
        isAdmin: false,
        isMuted: false,
      };

      const event = {
        id: "test-event-bundle-1",
        type: "MODEL_UPGRADE_EVENT" as const,
        poolSlug: "core",
        poolName: "Core Pool",
        block: "ALL",
        models: ["mimo-v2.5", "mimo-v2.6-flash", "deepseek-v4.1-flash"],
        hoursUtc: "",
        timestamp: Date.now(),
        modelUpgrade: {
          added: [],
          upgraded: [
            {
              type: "upgraded" as const,
              modelName: "mimo-v2.6-flash",
              previousModelName: "mimo-v2.5",
              family: "mimo",
              oldVersion: "2.5",
              newVersion: "2.6",
              changeNote: "mimo-v2.5 ➡️ mimo-v2.6-flash",
            },
          ],
          removed: [],
          allActiveModels: ["deepseek-v4.1-flash", "mimo-v2.6-flash"],
        },
      };

      const msg = formatBundledAlertMessage(user as any, [{ event: event as any, priority: "P2" }]);
      expect(msg.text).toContain("mimo-v2.6-flash");
      expect(msg.text).toContain("Core Pool");
    });

    it("should seamlessly handle simultaneous multi-upgrades in a single pool and exclude all superseded predecessors", () => {
      // Both mimo (v2.5 -> v2.6-flash) and deepseek (v4.0 -> v4.1-flash) upgraded simultaneously while site lists all 4
      const prevList = ["mimo-v2.5", "deepseek-v4.0", "stable-diffusion-xl"];
      const newList = ["mimo-v2.5", "mimo-v2.6-flash", "deepseek-v4.0", "deepseek-v4.1-flash", "stable-diffusion-xl"];

      const diff = ModelSemanticMatcher.diffModelLists(
        "multi-pool",
        "Multi AI Pool",
        prevList,
        newList
      );

      expect(diff.hasChanges).toBe(true);
      expect(diff.upgraded).toHaveLength(2);

      // Verify activeModels contains ONLY the 2 successors + unaffected model (3 total, NOT 5)
      expect(diff.activeModels).toHaveLength(3);
      expect(diff.activeModels).toContain("mimo-v2.6-flash");
      expect(diff.activeModels).toContain("deepseek-v4.1-flash");
      expect(diff.activeModels).toContain("stable-diffusion-xl");
      expect(diff.activeModels).not.toContain("mimo-v2.5");
      expect(diff.activeModels).not.toContain("deepseek-v4.0");
    });

    it("should adaptively handle date-based revision coexistence for future models", () => {
      const prevList = ["future-vision-202401", "other-tool"];
      const newList = ["future-vision-202401", "future-vision-202406", "other-tool"];

      const diff = ModelSemanticMatcher.diffModelLists(
        "vision-pool",
        "Vision Pool",
        prevList,
        newList
      );

      expect(diff.hasChanges).toBe(true);
      expect(diff.upgraded).toHaveLength(1);
      expect(diff.upgraded[0].modelName).toBe("future-vision-202406");
      expect(diff.activeModels).toEqual(["future-vision-202406", "other-tool"]);
      expect(diff.activeModels).not.toContain("future-vision-202401");
    });

    it("should adapt to brand-new unseen architecture without any prior knowledge (e.g. bio-nexus-neuro)", () => {
      const prevList = ["bio-nexus-neuro-1"];
      const newList = ["bio-nexus-neuro-1", "bio-nexus-neuro-2-ultra"];

      const diff = ModelSemanticMatcher.diffModelLists(
        "bio-pool",
        "Bio Pool",
        prevList,
        newList
      );

      expect(diff.hasChanges).toBe(true);
      expect(diff.upgraded).toHaveLength(1);
      expect(diff.upgraded[0].previousModelName).toBe("bio-nexus-neuro-1");
      expect(diff.upgraded[0].modelName).toBe("bio-nexus-neuro-2-ultra");
      expect(diff.activeModels).toEqual(["bio-nexus-neuro-2-ultra"]);
    });
  });
});
