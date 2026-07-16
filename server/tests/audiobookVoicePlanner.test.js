const test = require("node:test");
const assert = require("node:assert/strict");

const {
  planCharacterVoices,
  inferGenderBucket,
  inferAgeBucket,
  scoreImportance,
  isCharacterVoiceConfigured,
  inferVoiceSlot,
  allocateVoiceSlot,
  buildDesignPrompt,
  slotKey,
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
  assert.equal(maleVoices.size >= 2, true);
});

test("auto promotes design for important characters with voiceTexture (no 70/80 dead zone)", () => {
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
  // protagonist 80 + texture → design；antagonist 70+texture+8=至少 70+ → design
  const designItems = items.filter((i) => i.ttsMode === "design");
  assert.equal(designItems.length >= 1, true);
  for (const item of designItems) {
    assert.equal(Boolean(item.ttsDesignPrompt && item.ttsDesignPrompt.length > 8), true);
    assert.match(item.ttsDesignPrompt, /【声线】/);
    assert.match(item.ttsDesignPrompt, /【互斥】/);
  }
});

test("auto still uses preset for low-importance without texture", () => {
  const { items } = planCharacterVoices({
    onlyMissing: true,
    strategy: "auto",
    characters: [
      {
        characterId: "s1",
        characterName: "路人甲",
        gender: "male",
        role: "路人",
      },
      {
        characterId: "s2",
        characterName: "路人乙",
        gender: "female",
        role: "路人",
      },
    ],
  });
  assert.equal(items.every((item) => item.ttsMode === "preset"), true);
});

test("prefer_design strategy forces design prompts with structure and mutex", () => {
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
  for (const item of items) {
    assert.ok(item.ttsDesignPrompt.length <= 480);
    assert.match(item.ttsDesignPrompt, /【声线】/);
    assert.match(item.ttsDesignPrompt, /【互斥】/);
  }
});

test("prefer_design allocates distinct slots for same-gender cast when possible", () => {
  const { items } = planCharacterVoices({
    onlyMissing: false,
    strategy: "prefer_design",
    characters: [
      {
        characterId: "m1",
        characterName: "男一",
        gender: "male",
        castRole: "protagonist",
        voiceTexture: "沉稳沙哑低沉",
        personality: "冷硬",
      },
      {
        characterId: "m2",
        characterName: "男二",
        gender: "male",
        castRole: "ally",
        voiceTexture: "沉稳沙哑低沉",
        personality: "冷硬",
      },
      {
        characterId: "m3",
        characterName: "男三",
        gender: "male",
        castRole: "antagonist",
        voiceTexture: "沉稳沙哑低沉",
        personality: "冷硬",
      },
      {
        characterId: "m4",
        characterName: "男四",
        gender: "male",
        role: "路人",
        voiceTexture: "沉稳沙哑低沉",
      },
    ],
  });

  assert.equal(items.length, 4);
  assert.equal(items.every((i) => i.ttsMode === "design"), true);
  const keys = items.map((item) => {
    const pitch = item.ttsDesignPrompt.match(/音高([^，\n]+)/)?.[1];
    const texture = item.ttsDesignPrompt.match(/质感([^，\n]+)/)?.[1];
    const energy = item.ttsDesignPrompt.match(/气息([^，\n]+)/)?.[1];
    return `${pitch}|${texture}|${energy}`;
  });
  // 同质输入应通过槽位扰动拉开，至少 2 种组合
  assert.equal(new Set(keys).size >= 2, true);
});

test("buildDesignPrompt keeps texture core and mutex; never bare-returns texture only", () => {
  const longTexture = "青年男性，声线沉稳略沙哑，说话偏慢，带一点鼻音和金属质感。" + "补充描写".repeat(40);
  const prompt = buildDesignPrompt({
    character: {
      characterId: "x",
      characterName: "测试角",
      voiceTexture: longTexture,
      personality: "克制",
      role: "主角",
    },
    gender: "male",
    age: "adult",
    slot: { pitchBand: "low", textureBand: "dark_raspy", energyBand: "heavy" },
  });
  assert.ok(prompt.length <= 480);
  assert.match(prompt, /【声线】/);
  assert.match(prompt, /【互斥】/);
  assert.match(prompt, /沉稳略沙哑/);
  assert.notEqual(prompt.trim(), longTexture.slice(0, 480));
});

test("allocateVoiceSlot perturbs on collision then soft-collides when exhausted", () => {
  const occupied = new Set();
  const preferred = { pitchBand: "mid", textureBand: "neutral", energyBand: "even" };
  const first = allocateVoiceSlot({ gender: "male", preferred, occupied });
  assert.equal(first.softCollision, false);
  occupied.add(first.key);

  const second = allocateVoiceSlot({ gender: "male", preferred, occupied });
  assert.equal(second.softCollision, false);
  assert.notEqual(second.key, first.key);
  occupied.add(second.key);

  // 填满该 gender 下全部 3*4*3=36 槽
  for (const pitch of ["high", "mid", "low"]) {
    for (const texture of ["bright", "neutral", "dark_raspy", "airy"]) {
      for (const energy of ["lively", "even", "heavy"]) {
        occupied.add(slotKey("female", { pitchBand: pitch, textureBand: texture, energyBand: energy }));
      }
    }
  }
  const soft = allocateVoiceSlot({
    gender: "female",
    preferred: { pitchBand: "high", textureBand: "bright", energyBand: "lively" },
    occupied,
  });
  assert.equal(soft.softCollision, true);
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
  assert.equal(items[0].ttsMode, "design");
});

test("inferVoiceSlot reads rough/low cues from texture", () => {
  const slot = inferVoiceSlot({
    characterId: "1",
    characterName: "A",
    voiceTexture: "低沉沙哑威严",
  });
  assert.equal(slot.pitchBand, "low");
  assert.equal(slot.textureBand, "dark_raspy");
});
