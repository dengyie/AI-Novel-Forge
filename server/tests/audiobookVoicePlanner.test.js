const test = require("node:test");
const assert = require("node:assert/strict");

const {
  planCharacterVoices,
  inferGenderBucket,
  inferAgeBucket,
  scoreImportance,
  isCharacterVoiceConfigured,
} = require("../dist/services/audiobook/audiobookVoicePlanner.js");

test("inferGenderBucket uses explicit gender and text hints", () => {
  assert.equal(inferGenderBucket({ characterId: "1", characterName: "A", gender: "female" }), "female");
  assert.equal(inferGenderBucket({ characterId: "2", characterName: "B", gender: "male" }), "male");
  assert.equal(
    inferGenderBucket({ characterId: "3", characterName: "林婉儿", personality: "温柔少女" }),
    "female",
  );
  assert.equal(
    inferGenderBucket({ characterId: "4", characterName: "赵铁柱", role: "将军" }),
    "male",
  );
});

test("inferAgeBucket detects youth and elder cues", () => {
  assert.equal(
    inferAgeBucket({ characterId: "1", characterName: "小明", appearance: "少年模样" }),
    "youth",
  );
  assert.equal(
    inferAgeBucket({ characterId: "2", characterName: "老陈", personality: "苍老沉稳" }),
    "elder",
  );
});

test("scoreImportance ranks protagonist higher than side", () => {
  const pro = scoreImportance({
    characterId: "1",
    characterName: "主角",
    castRole: "protagonist",
  });
  const side = scoreImportance({
    characterId: "2",
    characterName: "路人",
    role: "路人甲",
  });
  assert.equal(pro > side, true);
  assert.equal(pro >= 70, true);
});

test("isCharacterVoiceConfigured respects mode fields", () => {
  assert.equal(isCharacterVoiceConfigured({ ttsMode: "preset", ttsVoice: "白桦" }), true);
  assert.equal(isCharacterVoiceConfigured({ ttsMode: "preset", ttsVoice: "" }), false);
  assert.equal(isCharacterVoiceConfigured({ ttsMode: "design", ttsDesignPrompt: "低沉男声" }), true);
  assert.equal(isCharacterVoiceConfigured({ ttsMode: "clone", ttsRefAudioPath: "/tmp/a.wav" }), true);
});

test("planCharacterVoices differentiates male/female presets and balances load", () => {
  const { items, skipped } = planCharacterVoices({
    onlyMissing: true,
    strategy: "preset_only",
    characters: [
      {
        characterId: "f1",
        characterName: "女主",
        gender: "female",
        castRole: "protagonist",
        personality: "冷静理智",
      },
      {
        characterId: "m1",
        characterName: "男主",
        gender: "male",
        castRole: "protagonist",
        personality: "沉稳",
      },
      {
        characterId: "m2",
        characterName: "男配A",
        gender: "male",
        castRole: "ally",
      },
      {
        characterId: "m3",
        characterName: "男配B",
        gender: "male",
        castRole: "ally",
      },
      {
        characterId: "bound",
        characterName: "已绑定",
        gender: "female",
        ttsMode: "preset",
        ttsVoice: "冰糖",
      },
    ],
  });

  assert.equal(skipped.some((item) => item.characterId === "bound"), true);
  assert.equal(items.length, 4);

  const female = items.find((item) => item.characterId === "f1");
  const males = items.filter((item) => item.characterId.startsWith("m"));
  assert.ok(female);
  assert.equal(female.ttsMode, "preset");
  assert.ok(["冰糖", "茉莉"].includes(female.ttsVoice));

  for (const male of males) {
    assert.equal(male.ttsMode, "preset");
    assert.ok(["苏打", "白桦"].includes(male.ttsVoice));
  }

  const maleVoices = new Set(males.map((item) => item.ttsVoice));
  // 3 男角色、2 预置：应至少用到两种，避免全员同一声
  assert.equal(maleVoices.size >= 2, true);
});

test("planCharacterVoices promotes design when important preset collides", () => {
  const { items } = planCharacterVoices({
    onlyMissing: true,
    strategy: "auto",
    maxImportantPerPreset: 1,
    characters: [
      {
        characterId: "a",
        characterName: "何屿",
        gender: "male",
        castRole: "protagonist",
        voiceTexture: "青年男性，声线沉稳略沙哑",
        personality: "冷硬克制",
      },
      {
        characterId: "b",
        characterName: "赵明远",
        gender: "male",
        castRole: "antagonist",
        voiceTexture: "中年男性，威严低沉",
        personality: "强势",
      },
    ],
  });

  assert.equal(items.length, 2);
  const modes = items.map((item) => item.ttsMode);
  // 至少有一个 design，或两个不同 preset；auto+高重要+voiceTexture 更倾向 design
  assert.equal(
    modes.includes("design") || new Set(items.map((i) => i.ttsVoice)).size === 2,
    true,
  );
  for (const item of items.filter((i) => i.ttsMode === "design")) {
    assert.equal(Boolean(item.ttsDesignPrompt && item.ttsDesignPrompt.length > 8), true);
  }
});

test("prefer_design strategy forces design prompts", () => {
  const { items } = planCharacterVoices({
    onlyMissing: false,
    strategy: "prefer_design",
    characters: [
      { characterId: "1", characterName: "甲", gender: "female", role: "路人" },
      { characterId: "2", characterName: "乙", gender: "male", role: "路人" },
    ],
  });
  assert.equal(items.every((item) => item.ttsMode === "design"), true);
  assert.equal(items.every((item) => Boolean(item.ttsDesignPrompt)), true);
});

test("onlyMissing seeds usage from already-bound presets to avoid collisions", () => {
  const { items, skipped } = planCharacterVoices({
    onlyMissing: true,
    strategy: "preset_only",
    characters: [
      {
        characterId: "bound-male",
        characterName: "已绑定男",
        gender: "male",
        castRole: "protagonist",
        ttsMode: "preset",
        ttsVoice: "白桦",
      },
      {
        characterId: "new-male",
        characterName: "新男角",
        gender: "male",
        castRole: "ally",
      },
    ],
  });

  assert.equal(skipped.some((item) => item.characterId === "bound-male"), true);
  assert.equal(items.length, 1);
  assert.equal(items[0].characterId, "new-male");
  assert.equal(items[0].ttsMode, "preset");
  // 已占用「白桦」时，新男角应落到另一预置
  assert.equal(items[0].ttsVoice, "苏打");
});

test("planCharacterVoices never rewrites configured clone bindings even when onlyMissing=false", () => {
  const { items, skipped } = planCharacterVoices({
    onlyMissing: false,
    strategy: "prefer_design",
    characters: [
      {
        characterId: "clone-1",
        characterName: "克隆角",
        gender: "female",
        castRole: "protagonist",
        ttsMode: "clone",
        ttsRefAudioPath: "/data/voices/clone-1.wav",
      },
      {
        characterId: "open-1",
        characterName: "开放角",
        gender: "male",
        castRole: "ally",
      },
    ],
  });

  assert.equal(skipped.some((item) => item.characterId === "clone-1"), true);
  assert.equal(items.some((item) => item.characterId === "clone-1"), false);
  assert.equal(items.length, 1);
  assert.equal(items[0].characterId, "open-1");
});
