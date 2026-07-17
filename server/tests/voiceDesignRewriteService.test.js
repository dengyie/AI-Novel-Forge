/**
 * Milestone G: design rewrite with injectable mock LLM (no network).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  rewriteCharacterVoiceDesign,
} = require("../dist/services/audiobook/voiceDesignRewriteService");

const SAMPLE_CHAR = {
  id: "char-1",
  name: "林远",
  role: "主角",
  gender: "男",
  personality: "沉稳克制",
  appearance: "青年",
  background: "边城少年",
  ttsDesignPrompt: "旧草稿：偏低略沙",
};

describe("voiceDesignRewriteService", () => {
  it("mock LLM 返回候选；applied=false；剥离路径噪声", async () => {
    const result = await rewriteCharacterVoiceDesign({
      novelId: "novel-1",
      characterId: "char-1",
      loadCharacter: async () => SAMPLE_CHAR,
      llm: {
        invoke: async () => ({
          content:
            "青年男性，声线沉稳略沙哑，语速中等，适合冷硬独白。路径 /Users/secret/ref.wav 与 ttsRefAudioPath=/tmp/x.wav 应被剥。",
        }),
      },
    });
    assert.equal(result.applied, false);
    assert.equal(result.source, "llm");
    assert.ok(result.designPrompt.length >= 12);
    assert.ok(!/\/Users\//.test(result.designPrompt));
    assert.ok(!/ttsRefAudioPath/.test(result.designPrompt));
    assert.ok(Array.isArray(result.tags));
  });

  it("llm 抛错时 rule_fallback 仍返回候选", async () => {
    const result = await rewriteCharacterVoiceDesign({
      novelId: "novel-1",
      characterId: "char-1",
      loadCharacter: async () => SAMPLE_CHAR,
      llm: {
        invoke: async () => {
          throw new Error("upstream down");
        },
      },
    });
    assert.equal(result.applied, false);
    assert.equal(result.source, "rule_fallback");
    assert.ok(result.designPrompt.length >= 8);
  });

  it("角色不存在 → 404；空 id → 400", async () => {
    await assert.rejects(
      () =>
        rewriteCharacterVoiceDesign({
          novelId: "n",
          characterId: "missing",
          loadCharacter: async () => null,
          llm: { invoke: async () => "x" },
        }),
      /不存在/,
    );
    await assert.rejects(
      () =>
        rewriteCharacterVoiceDesign({
          novelId: "",
          characterId: "",
          llm: { invoke: async () => "x" },
        }),
      /必填/,
    );
  });

  it("非法 provider → 400；fallback 带 fallbackReason", async () => {
    await assert.rejects(
      () =>
        rewriteCharacterVoiceDesign({
          novelId: "novel-1",
          characterId: "char-1",
          body: { provider: "not-a-real-provider" },
          loadCharacter: async () => SAMPLE_CHAR,
        }),
      /provider/,
    );

    const result = await rewriteCharacterVoiceDesign({
      novelId: "novel-1",
      characterId: "char-1",
      loadCharacter: async () => SAMPLE_CHAR,
      llm: {
        invoke: async () => {
          throw new Error("upstream timeout");
        },
      },
    });
    assert.equal(result.source, "rule_fallback");
    assert.ok(result.fallbackReason);
    assert.match(String(result.fallbackReason), /timeout|upstream/i);
  });
});
