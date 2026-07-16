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
  assert.ok(DESIGN_PROMPT_ARCHETYPES.some((a) => a.id === "cast-ally-female-adult"));
  assert.ok(DESIGN_PROMPT_ARCHETYPES.some((a) => a.id === "cast-generic-female-adult"));
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

  const strongTexture = pickDesignPromptArchetype({
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
  assert.equal(strongTexture, null);

  // personality ≥4 且无 texture 也不再走 archetype
  const strongPersonality = pickDesignPromptArchetype({
    character: {
      characterId: "s2",
      characterName: "气质卡",
      personality: "克制坚定",
    },
    gender: "male",
    age: "adult",
    cluster: "cast",
  });
  assert.equal(strongPersonality, null);
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
        personality: "倔",
      },
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].ttsMode, "design");
  assert.match(items[0].reason, /archetype:/);
  assert.ok(items[0].ttsDesignPrompt.length <= DESIGN_PROMPT_MAX);
  assert.equal(Boolean(parseSlotFromDesignPrompt(items[0].ttsDesignPrompt)), true);
  assert.match(items[0].ttsDesignPrompt, /男主对白/);
});

test("female protagonist lead uses 女主对白 not 男主对白", () => {
  const { items } = planCharacterVoices({
    onlyMissing: false,
    strategy: "prefer_design",
    characters: [
      {
        characterId: "f-lead",
        characterName: "林婉",
        gender: "female",
        castRole: "protagonist",
        personality: "冷静",
      },
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].ttsMode, "design");
  assert.match(items[0].ttsDesignPrompt, /女主对白/);
  assert.doesNotMatch(items[0].ttsDesignPrompt, /男主对白/);
});

test("weak adult female ally does not land antagonist archetype", () => {
  const picked = pickDesignPromptArchetype({
    character: {
      characterId: "ally-f",
      characterName: "丙",
      gender: "female",
      castRole: "ally",
      personality: "乖",
    },
    gender: "female",
    age: "adult",
    cluster: "cast",
  });
  assert.ok(picked);
  assert.equal(picked.id, "cast-ally-female-adult");
  assert.doesNotMatch(picked.id, /antagonist|foil|pressure/);

  const { items } = planCharacterVoices({
    onlyMissing: false,
    strategy: "prefer_design",
    characters: [
      {
        characterId: "ally-f",
        characterName: "丙",
        gender: "female",
        castRole: "ally",
        personality: "乖",
      },
    ],
  });
  assert.equal(items[0].ttsMode, "design");
  assert.match(items[0].reason, /archetype:cast-ally-female-adult/);
  assert.match(items[0].ttsDesignPrompt, /主角团对白/);
  assert.doesNotMatch(items[0].ttsDesignPrompt, /权谋反派对白/);
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
    archetypeUseCase: "权谋反派对白",
  });
  assert.match(prompt, /音高偏高/);
  assert.match(prompt, /质感偏气声轻柔/);
  assert.match(prompt, /气息活泼有弹性/);
  assert.match(prompt, /轻快清脆/);
  // 有 role 信号时不让 archetype useCase 覆盖
  assert.match(prompt, /主角团对白/);
  assert.doesNotMatch(prompt, /权谋反派对白/);
  assert.deepEqual(parseSlotFromDesignPrompt(prompt), {
    pitchBand: "high",
    textureBand: "airy",
    energyBand: "lively",
  });
});

test("buildDesignPrompt soft mutex hard-keeps under long personality", () => {
  const prompt = buildDesignPrompt({
    character: {
      characterId: "x",
      characterName: "甲",
      castRole: "ally",
      personality: "abcdefghij".repeat(8),
      voiceTexture: "明亮清脆又带一点金属感并且很长很长很长很长很长",
    },
    gender: "female",
    age: "youth",
    slot: { pitchBand: "high", textureBand: "bright", energyBand: "lively" },
    softCollision: true,
    neighborSlotLabel: "中等中性干净声线",
    cluster: "cast",
  });
  assert.ok(prompt.length <= DESIGN_PROMPT_MAX);
  assert.match(prompt, /与「中等中性干净声线」明显区分/);
  assert.equal(Boolean(parseSlotFromDesignPrompt(prompt)), true);
});

test("onlyMissing seeds occupied slots from natural-language design prompt", () => {
  const boundPrompt =
    "青壮年男性，标准普通话，音高偏低，质感偏低略沙哑，气息沉稳有分量，吐字沉稳，适合男主对白。避免播音腔、空壳标准声与死气平板播读。";
  assert.deepEqual(parseSlotFromDesignPrompt(boundPrompt), {
    pitchBand: "low",
    textureBand: "dark_raspy",
    energyBand: "heavy",
  });

  const { items, skipped } = planCharacterVoices({
    onlyMissing: true,
    strategy: "prefer_design",
    characters: [
      {
        characterId: "old",
        characterName: "旧",
        gender: "male",
        castRole: "protagonist",
        ttsMode: "design",
        ttsDesignPrompt: boundPrompt,
      },
      {
        characterId: "new",
        characterName: "新",
        gender: "male",
        castRole: "ally",
        voiceTexture: "沉稳沙哑低沉",
      },
    ],
  });

  assert.equal(skipped.some((item) => item.characterId === "old"), true);
  assert.equal(items.length, 1);
  assert.equal(items[0].characterId, "new");
  const pitch = items[0].ttsDesignPrompt.match(/音高([^，。\n]+)/)?.[1];
  const texture = items[0].ttsDesignPrompt.match(/质感([^，。\n]+)/)?.[1];
  const energy = items[0].ttsDesignPrompt.match(/气息([^，。\n]+)/)?.[1];
  assert.notEqual(`${pitch}|${texture}|${energy}`, "偏低|偏低略沙哑|沉稳有分量");
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

  const allyArch = DESIGN_PROMPT_ARCHETYPES.find((a) => a.id === "cast-ally-female-adult");
  assert.ok(allyArch);
  const allyScore = scoreDesignPromptArchetype(allyArch, {
    gender: "female",
    age: "adult",
    cluster: "cast",
    character: { characterId: "3", characterName: "丙", castRole: "ally" },
  });
  const antF = DESIGN_PROMPT_ARCHETYPES.find((a) => a.id === "cast-antagonist-female");
  const antScore = scoreDesignPromptArchetype(antF, {
    gender: "female",
    age: "adult",
    cluster: "cast",
    character: { characterId: "3", characterName: "丙", castRole: "ally" },
  });
  assert.ok(allyScore > antScore);
});
