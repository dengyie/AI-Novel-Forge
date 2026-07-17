const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SPEECH_QUIRK_SEEDS,
  isSpeechQuirkCompatible,
  pickSpeechQuirk,
  speechQuirkCandidates,
  containsBannedDesignPromptSubstring,
  extractAcousticIdentityTokens,
  jaccardIndex,
  DESIGN_PROMPT_BANNED_SUBSTRINGS,
} = require("../dist/services/audiobook/designPromptQuirks.js");
const {
  buildDesignPrompt,
  buildDesignPromptDetailed,
  planCharacterVoices,
  parseSlotFromDesignPrompt,
  speechHabitCandidates,
  DESIGN_PROMPT_MAX,
} = require("../dist/services/audiobook/audiobookVoicePlanner.js");

test("SPEECH_QUIRK_SEEDS has no celebrity / product meta", () => {
  assert.ok(SPEECH_QUIRK_SEEDS.length >= 8);
  const joined = SPEECH_QUIRK_SEEDS.map((s) => s.phrase + s.id).join(" ");
  assert.doesNotMatch(joined, /周杰伦|邓紫棋|请听|合适|吐字清楚/);
});

test("isSpeechQuirkCompatible rejects texture-conflict quirks", () => {
  const slot = { pitchBand: "mid", textureBand: "bright", energyBand: "even" };
  const dark = SPEECH_QUIRK_SEEDS.find((s) => s.id === "dark-rear-res");
  assert.ok(dark);
  assert.equal(isSpeechQuirkCompatible(dark, slot, "cast"), false);

  const bright = SPEECH_QUIRK_SEEDS.find((s) => s.id === "bright-bite");
  assert.ok(bright);
  assert.equal(isSpeechQuirkCompatible(bright, slot, "cast"), true);
});

test("speechHabitCandidates returns at most one quirk", () => {
  const list = speechHabitCandidates(
    { pitchBand: "low", textureBand: "dark_raspy", energyBand: "heavy" },
    "lead",
    "char-a",
  );
  assert.ok(list.length <= 1);
  const list2 = speechQuirkCandidates(
    { pitchBand: "high", textureBand: "bright", energyBand: "lively" },
    "cast",
    "char-b",
  );
  assert.ok(list2.length <= 1);
});

test("pickSpeechQuirk stable for same characterId", () => {
  const slot = { pitchBand: "mid", textureBand: "neutral", energyBand: "even" };
  const a = pickSpeechQuirk({ slot, cluster: "cast", characterId: "stable-1" });
  const b = pickSpeechQuirk({ slot, cluster: "cast", characterId: "stable-1" });
  assert.equal(a, b);
});

test("buildDesignPrompt hard-keeps mutex primary and stays under max", () => {
  const prompt = buildDesignPrompt({
    character: {
      characterId: "x",
      characterName: "甲",
      castRole: "ally",
      personality: "abcdefghij".repeat(4),
      voiceTexture: "明亮清脆又带一点金属感并且很长很长很长",
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

test("weak cards do not flood padding synonyms", () => {
  const prompt = buildDesignPrompt({
    character: {
      characterId: "weak-1",
      characterName: "无名",
      gender: "male",
      castRole: "protagonist",
      personality: "倔",
    },
    gender: "male",
    age: "adult",
    slot: { pitchBand: "mid", textureBand: "neutral", energyBand: "heavy" },
    cluster: "lead",
    archetypeTexturePhrase: "中性干净带一点金属感",
  });
  assert.ok(prompt.length <= DESIGN_PROMPT_MAX);
  assert.doesNotMatch(prompt, /气质克制坚定/);
  // 不得同时出现 ≥2 条 SPEECH_QUIRK 灌水
  const hits = SPEECH_QUIRK_SEEDS.filter((s) => prompt.includes(s.phrase));
  assert.ok(hits.length <= 1, hits.map((h) => h.id).join(","));
  assert.equal(containsBannedDesignPromptSubstring(prompt), null);
});

test("two leads same soft card still get non-identical acoustic token sets", () => {
  const { items } = planCharacterVoices({
    onlyMissing: false,
    strategy: "prefer_design",
    characters: [
      {
        characterId: "lead-a",
        characterName: "甲",
        gender: "male",
        castRole: "protagonist",
        role: "男主",
        personality: "沉稳",
      },
      {
        characterId: "lead-b",
        characterName: "乙",
        gender: "male",
        castRole: "protagonist",
        role: "男主",
        personality: "沉稳",
        voiceTexture: "偏低略沙",
      },
    ],
  });
  assert.equal(items.length, 2);
  const t0 = extractAcousticIdentityTokens(items[0].ttsDesignPrompt);
  const t1 = extractAcousticIdentityTokens(items[1].ttsDesignPrompt);
  const j = jaccardIndex(t0, t1);
  assert.ok(j < 1, `Jaccard should be <1, got ${j}`);
  for (const item of items) {
    assert.ok(item.ttsDesignPrompt.length <= DESIGN_PROMPT_MAX);
    assert.ok(parseSlotFromDesignPrompt(item.ttsDesignPrompt));
    assert.equal(containsBannedDesignPromptSubstring(item.ttsDesignPrompt), null);
  }
});

test("banned substring list covers product meta", () => {
  assert.ok(DESIGN_PROMPT_BANNED_SUBSTRINGS.includes("请听"));
  assert.ok(containsBannedDesignPromptSubstring("请听听我的声音是否合适") !== null);
});

test("truncation prefers card texture over vibe when over budget", () => {
  const { prompt, textureFlavor } = buildDesignPromptDetailed({
    character: {
      characterId: "long",
      characterName: "甲",
      voiceTexture: "清亮稳、不甜腻",
      personality: "冷静锋利果决有手段且措辞极长".repeat(3),
    },
    gender: "female",
    age: "adult",
    slot: { pitchBand: "high", textureBand: "bright", energyBand: "heavy" },
    preferredSlot: { pitchBand: "high", textureBand: "bright", energyBand: "heavy" },
    softCollision: true,
    neighborSlotLabel: "偏低略沙哑沉稳声线很长标签",
    cluster: "lead",
  });
  assert.ok(prompt.length <= DESIGN_PROMPT_MAX);
  assert.equal(textureFlavor, "card-full");
  assert.match(prompt, /清亮|不甜腻/);
  assert.match(prompt, /与「/);
  assert.equal(Boolean(parseSlotFromDesignPrompt(prompt)), true);
});
