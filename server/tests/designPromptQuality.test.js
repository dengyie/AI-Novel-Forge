const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DESIGN_PROMPT_ARCHETYPES,
  pickDesignPromptArchetype,
  scoreDesignPromptArchetype,
} = require("../dist/services/audiobook/designPromptArchetypes.js");
const {
  planCharacterVoices,
  buildDesignPrompt,
  parseSlotFromDesignPrompt,
  DESIGN_PROMPT_MAX,
} = require("../dist/services/audiobook/audiobookVoicePlanner.js");

test("archetype table has at least 24 seeds and no celebrity names", () => {
  assert.ok(DESIGN_PROMPT_ARCHETYPES.length >= 24);
  assert.ok(DESIGN_PROMPT_ARCHETYPES.length <= 40);
  const joined = DESIGN_PROMPT_ARCHETYPES.map((a) => a.texturePhrase + a.id).join(" ");
  assert.doesNotMatch(joined, /周杰伦|邓紫棋|易烊千玺|明星|配音员张/);
});

test("pickDesignPromptArchetype only fills weak cards and is stable", () => {
  const weak = {
    characterId: "w1",
    characterName: "路人丙",
    gender: "male",
    role: "路人",
  };
  const a = pickDesignPromptArchetype({
    character: weak,
    gender: "male",
    age: "adult",
    cluster: "extra",
  });
  const b = pickDesignPromptArchetype({
    character: weak,
    gender: "male",
    age: "adult",
    cluster: "extra",
  });
  assert.ok(a);
  assert.equal(a.id, b.id);

  const strong = pickDesignPromptArchetype({
    character: {
      characterId: "s1",
      characterName: "强卡",
      voiceTexture: "沉稳沙哑",
      personality: "阴狠果决有手段",
    },
    gender: "male",
    age: "adult",
    cluster: "cast",
  });
  assert.equal(strong, null);
});

test("prefer_design weak lead hits archetype and stays parseable", () => {
  const { items } = planCharacterVoices({
    onlyMissing: false,
    strategy: "prefer_design",
    characters: [
      {
        characterId: "lead-weak",
        characterName: "无名主角",
        gender: "male",
        castRole: "protagonist",
        // no voiceTexture, short personality → weak
        personality: "倔",
      },
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].ttsMode, "design");
  assert.match(items[0].reason, /archetype:/);
  assert.ok(items[0].ttsDesignPrompt.length <= DESIGN_PROMPT_MAX);
  assert.equal(Boolean(parseSlotFromDesignPrompt(items[0].ttsDesignPrompt)), true);
});

test("buildDesignPrompt accepts archetype phrase without covering slot labels", () => {
  const prompt = buildDesignPrompt({
    character: {
      characterId: "x",
      characterName: "甲",
      role: "配角",
    },
    gender: "female",
    age: "adult",
    slot: { pitchBand: "high", textureBand: "airy", energyBand: "lively" },
    cluster: "cast",
    archetypeTexturePhrase: "轻快清脆",
    archetypeUseCase: "主角团对白",
  });
  assert.match(prompt, /音高偏高/);
  assert.match(prompt, /质感偏气声轻柔/);
  assert.match(prompt, /气息活泼有弹性/);
  assert.match(prompt, /轻快清脆/);
  assert.match(prompt, /主角团对白/);
  assert.deepEqual(parseSlotFromDesignPrompt(prompt), {
    pitchBand: "high",
    textureBand: "airy",
    energyBand: "lively",
  });
});

test("scoreDesignPromptArchetype prefers matching gender/role", () => {
  const ant = DESIGN_PROMPT_ARCHETYPES.find((a) => a.id === "cast-antagonist-male");
  assert.ok(ant);
  const high = scoreDesignPromptArchetype(ant, {
    gender: "male",
    age: "adult",
    cluster: "cast",
    character: { characterId: "1", characterName: "赵", role: "反派", castRole: "antagonist" },
  });
  const low = scoreDesignPromptArchetype(ant, {
    gender: "female",
    age: "youth",
    cluster: "extra",
    character: { characterId: "2", characterName: "李", role: "路人" },
  });
  assert.ok(high > low);
});
