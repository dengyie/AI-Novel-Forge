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
  buildDesignPromptDetailed,
  parseSlotFromDesignPrompt,
  inferVoiceSlot,
  allocateVoiceSlot,
  extractCompatibleTextureSnippet,
  DESIGN_PROMPT_MAX,
  DESIGN_PROMPT_TARGET_MIN,
  DESIGN_PROMPT_TARGET_MAX,
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


test("personality 冷静 does not force dark_raspy when texture is 清亮", () => {
  const slot = inferVoiceSlot({
    characterId: "st",
    characterName: "沈棠",
    gender: "female",
    castRole: "protagonist",
    role: "女主",
    personality: "冷静锋利",
    voiceTexture: "清亮稳、不甜腻",
  });
  assert.equal(slot.textureBand, "bright");
  assert.notEqual(slot.textureBand, "dark_raspy");
});

test("plan keeps card bright texture for cold-personality female lead", () => {
  const { items } = planCharacterVoices({
    onlyMissing: false,
    strategy: "prefer_design",
    characters: [
      {
        characterId: "2",
        characterName: "沈棠",
        gender: "female",
        castRole: "protagonist",
        role: "女主",
        personality: "冷静锋利",
        voiceTexture: "清亮稳、不甜腻",
      },
    ],
  });
  assert.equal(items.length, 1);
  const p = items[0].ttsDesignPrompt;
  assert.match(p, /质感明亮清脆/);
  assert.match(p, /清亮|不甜腻/);
  assert.doesNotMatch(p, /质感偏低略沙哑/);
  assert.match(items[0].reason, /texture:card-kept|texture:locked/);
  assert.ok(p.length >= 40, `len ${p.length}`);
  assert.ok(p.length <= DESIGN_PROMPT_MAX);
  assert.ok(parseSlotFromDesignPrompt(p));
});

test("preserveTexture prefers pitch/energy override over texture", () => {
  const preferred = { pitchBand: "mid", textureBand: "bright", energyBand: "heavy" };
  const occupied = new Set(["female|mid|bright|heavy"]);
  const map = new Map([["female|mid|bright|heavy", preferred]]);
  const a = allocateVoiceSlot({
    gender: "female",
    preferred,
    occupied,
    occupiedSlotByKey: map,
    minSeparation: 2,
    preserveTexture: true,
  });
  assert.equal(a.slot.textureBand, "bright");
  assert.notEqual(
    `${a.slot.pitchBand}|${a.slot.textureBand}|${a.slot.energyBand}`,
    "mid|bright|heavy",
  );
});

test("extractCompatibleTextureSnippet keeps non-conflicting tokens", () => {
  const s = extractCompatibleTextureSnippet("清亮稳、不甜腻", "dark_raspy", 28);
  // 清亮/甜 conflict with dark; residual should not reintroduce 清亮
  if (s) {
    assert.doesNotMatch(s, /清亮|甜腻|明亮/);
  }
  const bright = extractCompatibleTextureSnippet("清亮稳、不甜腻", "bright", 28);
  assert.ok(bright);
  assert.match(bright, /清亮|不甜腻|稳/);
});

test("slot override still keeps partial card texture when possible", () => {
  // Force many males with same preferred so override happens; one has distinct sweet texture
  const characters = [];
  for (let i = 0; i < 4; i++) {
    characters.push({
      characterId: `m${i}`,
      characterName: `男${i}`,
      gender: "male",
      castRole: "ally",
      personality: "普通",
      voiceTexture: "中性干净",
    });
  }
  characters.push({
    characterId: "sf",
    characterName: "师父",
    gender: "male",
    castRole: "mentor",
    role: "师父",
    personality: "沉稳",
    voiceTexture: "清亮甜脆",
  });
  const { items } = planCharacterVoices({
    onlyMissing: false,
    strategy: "prefer_design",
    characters,
  });
  const sf = items.find((i) => i.characterId === "sf");
  assert.ok(sf);
  // either texture locked bright with some card flavor, or partial/drop flagged in reason
  assert.ok(sf.ttsDesignPrompt);
  assert.ok(parseSlotFromDesignPrompt(sf.ttsDesignPrompt));
  if (sf.reason.includes("slot:override") && sf.ttsDesignPrompt.includes("质感明亮清脆")) {
    // best: preserveTexture kept bright
    assert.match(sf.reason, /texture:locked/);
  } else if (sf.reason.includes("texture:card-partial") || sf.reason.includes("texture:card-kept")) {
    assert.ok(true);
  } else {
    // last resort: must not be silent about drop
    assert.match(sf.reason, /texture:card-dropped|texture:locked|slot:override/);
  }
});

test("lead same-gender energy spreads across two leads", () => {
  const { items } = planCharacterVoices({
    onlyMissing: false,
    strategy: "prefer_design",
    characters: [
      {
        characterId: "l1",
        characterName: "甲",
        gender: "male",
        castRole: "protagonist",
        role: "男主",
        personality: "沉稳",
        voiceTexture: "中性干净",
      },
      {
        characterId: "l2",
        characterName: "乙",
        gender: "male",
        castRole: "protagonist",
        role: "男主",
        personality: "沉稳",
        voiceTexture: "中性干净略厚",
      },
    ],
  });
  assert.equal(items.length, 2);
  const e1 = parseSlotFromDesignPrompt(items[0].ttsDesignPrompt).energyBand;
  const e2 = parseSlotFromDesignPrompt(items[1].ttsDesignPrompt).energyBand;
  // prefer different energy when possible
  assert.notEqual(e1, e2);
});

test("phase-2 acoustic: no habit padding flood; core parseable; ≤1 quirk", () => {
  const prompt = buildDesignPrompt({
    character: {
      characterId: "1",
      characterName: "林澈",
      gender: "male",
      castRole: "protagonist",
      role: "男主",
      personality: "沉稳内敛",
      voiceTexture: "清亮偏薄略干",
    },
    gender: "male",
    age: "youth",
    slot: { pitchBand: "mid", textureBand: "airy", energyBand: "heavy" },
    cluster: "lead",
  });
  assert.ok(prompt.length <= DESIGN_PROMPT_MAX);
  // v1.1：宁短而尖；禁止为凑 TARGET_MIN 堆同义灌水
  assert.ok(prompt.length >= 40, `too short: ${prompt.length}`);
  assert.match(prompt, /音高中等/);
  assert.match(prompt, /质感偏气声轻柔/);
  assert.match(prompt, /气息沉稳有分量/);
  // 至多一条「气声收住」类 airy 癖好，不得同时塞 heavy+lead 多条 habit 灌水
  const habitHits = [
    "气声收住、不虚飘",
    "日常语速偏稳，激动也不尖",
    "对白有角色重心，不演旁白",
    "语速中等，收尾干净",
    "语速可略快，句尾轻扬",
  ].filter((h) => prompt.includes(h));
  assert.ok(habitHits.length <= 1, `expected ≤1 quirk, got ${habitHits.join("|")}`);
  assert.doesNotMatch(prompt, /气质克制坚定/);
});

test("buildDesignPromptDetailed reports card-full for aligned texture", () => {
  const { prompt, textureFlavor } = buildDesignPromptDetailed({
    character: {
      characterId: "1",
      characterName: "A",
      voiceTexture: "清亮稳、不甜腻",
      personality: "冷静锋利",
    },
    gender: "female",
    age: "adult",
    slot: { pitchBand: "high", textureBand: "bright", energyBand: "heavy" },
    preferredSlot: { pitchBand: "high", textureBand: "bright", energyBand: "heavy" },
    cluster: "lead",
  });
  assert.equal(textureFlavor, "card-full");
  assert.match(prompt, /清亮|不甜腻/);
});
