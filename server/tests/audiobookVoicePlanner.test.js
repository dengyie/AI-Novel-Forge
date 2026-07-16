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
  parseSlotFromDesignPrompt,
  slotsEqual,
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

test("auto promotes design for all important characters with voiceTexture (no 70/80 dead zone)", () => {
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
  // protagonist ≥70+texture；antagonist 70+texture → 两者均 design
  assert.equal(items.every((i) => i.ttsMode === "design"), true);
  for (const item of items) {
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
  // 同质输入应通过槽位扰动拉开；4 人池未尽时应 4 种组合
  assert.equal(new Set(keys).size, 4);
});

test("slot override does not put contradictory texture into 声线", () => {
  const { items } = planCharacterVoices({
    onlyMissing: false,
    strategy: "prefer_design",
    characters: [
      {
        characterId: "m1",
        characterName: "一",
        gender: "male",
        voiceTexture: "沉稳沙哑低沉威严",
      },
      {
        characterId: "m2",
        characterName: "二",
        gender: "male",
        voiceTexture: "沉稳沙哑低沉威严",
      },
      {
        characterId: "m3",
        characterName: "三",
        gender: "male",
        voiceTexture: "沉稳沙哑低沉威严",
      },
    ],
  });

  const overridden = items.filter((item) => item.reason.includes("slot:override"));
  assert.equal(overridden.length >= 1, true);

  for (const item of items) {
    const voiceLine = item.ttsDesignPrompt.split("\n").find((line) => line.startsWith("【声线】")) || "";
    // 质感明亮/中性 时，【声线】不得再拼沙哑/低沉整句
    if (/质感明亮清脆|质感中性干净/.test(voiceLine)) {
      assert.equal(/沙哑|低沉威严/.test(voiceLine), false);
    }
  }
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
    preferredSlot: { pitchBand: "low", textureBand: "dark_raspy", energyBand: "heavy" },
  });
  assert.ok(prompt.length <= 480);
  assert.match(prompt, /【声线】/);
  assert.match(prompt, /【互斥】/);
  assert.match(prompt, /沉稳略沙哑/);
  assert.notEqual(prompt.trim(), longTexture.slice(0, 480));
});

test("buildDesignPrompt drops conflicting texture when slot diverged", () => {
  const prompt = buildDesignPrompt({
    character: {
      characterId: "x",
      characterName: "测试角",
      voiceTexture: "沉稳沙哑低沉威严",
      role: "配角",
    },
    gender: "male",
    age: "adult",
    slot: { pitchBand: "low", textureBand: "bright", energyBand: "heavy" },
    preferredSlot: { pitchBand: "low", textureBand: "dark_raspy", energyBand: "heavy" },
  });
  const voiceLine = prompt.split("\n").find((line) => line.startsWith("【声线】")) || "";
  assert.match(voiceLine, /质感明亮清脆/);
  assert.equal(/沙哑|低沉威严/.test(voiceLine), false);
  assert.match(prompt, /【气质】/);
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

test("onlyMissing seeds occupied design slots so new design avoids bound key", () => {
  const boundPrompt = [
    "【身份】青壮年男性，叙事身份：主角「旧」",
    "【声线】音高偏低，质感偏低略沙哑，气息沉稳有分量",
    "【互斥】与同书其他角色在音高/质感上可辨",
  ].join("\n");

  const parsed = parseSlotFromDesignPrompt(boundPrompt);
  assert.ok(parsed);
  assert.equal(parsed.pitchBand, "low");
  assert.equal(parsed.textureBand, "dark_raspy");
  assert.equal(parsed.energyBand, "heavy");

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
        voiceTexture: "沉稳沙哑低沉",
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
  assert.equal(items[0].ttsMode, "design");
  // 新角不得再占与 bound 相同的音高/质感/气息组合
  const pitch = items[0].ttsDesignPrompt.match(/音高([^，\n]+)/)?.[1];
  const texture = items[0].ttsDesignPrompt.match(/质感([^，\n]+)/)?.[1];
  const energy = items[0].ttsDesignPrompt.match(/气息([^，\n]+)/)?.[1];
  const newKey = `${pitch}|${texture}|${energy}`;
  assert.notEqual(newKey, "偏低|偏低略沙哑|沉稳有分量");
  assert.equal(items[0].reason.includes("slot:override") || newKey !== "偏低|偏低略沙哑|沉稳有分量", true);
});

test("soft collision mutex cites occupied neighbor slot not last writer", () => {
  // 填满 female 全部槽，再规划一个 female → soft；邻居应来自占用表中 preferred key
  const characters = [];
  let i = 0;
  for (const pitch of ["high", "mid", "low"]) {
    for (const texture of ["bright", "neutral", "dark_raspy", "airy"]) {
      for (const energy of ["lively", "even", "heavy"]) {
        characters.push({
          characterId: `f${i}`,
          characterName: `女${i}`,
          gender: "female",
          // 无 texture，preferred 落 mid|neutral|even；先用不同 personality 避免 sort 干扰
          personality: `p${i}`,
        });
        i += 1;
      }
    }
  }
  // 第 37 个：同 preferred mid|neutral|even → soft
  characters.push({
    characterId: "soft-one",
    characterName: "软撞",
    gender: "female",
    personality: "最终",
  });

  const { items } = planCharacterVoices({
    onlyMissing: false,
    strategy: "prefer_design",
    characters,
  });

  const softItem = items.find((item) => item.characterId === "soft-one");
  assert.ok(softItem);
  assert.match(softItem.reason, /collision:soft/);
  // 邻居标签应是某档音高+质感「声线」
  assert.match(softItem.ttsDesignPrompt, /明显区别于.+声线/);
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

test("half-clone without ref is re-planned (only clone+ref is permanent skip)", () => {
  const { items, skipped } = planCharacterVoices({
    onlyMissing: false,
    strategy: "prefer_design",
    characters: [
      {
        characterId: "half-clone",
        characterName: "半克隆",
        gender: "male",
        ttsMode: "clone",
        ttsRefAudioPath: "",
      },
    ],
  });
  assert.equal(skipped.length, 0);
  assert.equal(items.length, 1);
  assert.equal(items[0].characterId, "half-clone");
  assert.equal(items[0].ttsMode, "design");
  assert.equal(items[0].wouldOverwrite, false);
});

test("legacy design prompt without labels seeds as seed:inferred", () => {
  const { items, skipped } = planCharacterVoices({
    onlyMissing: true,
    strategy: "prefer_design",
    characters: [
      {
        characterId: "legacy",
        characterName: "旧稿",
        gender: "male",
        ttsMode: "design",
        ttsDesignPrompt: "青年男声，沉稳沙哑",
        voiceTexture: "沉稳沙哑低沉",
      },
      {
        characterId: "new",
        characterName: "新角",
        gender: "male",
        voiceTexture: "沉稳沙哑低沉",
      },
    ],
  });
  assert.equal(skipped.some((s) => s.characterId === "legacy" && s.reason.includes("seed:inferred")), true);
  assert.equal(items.length, 1);
  assert.equal(items[0].characterId, "new");
  assert.equal(items[0].ttsMode, "design");
});

test("auto design reason does not claim 听感保证", () => {
  const { items } = planCharacterVoices({
    onlyMissing: true,
    strategy: "auto",
    characters: [
      {
        characterId: "a",
        characterName: "主",
        gender: "male",
        castRole: "protagonist",
        voiceTexture: "沉稳沙哑",
      },
    ],
  });
  assert.equal(items[0].ttsMode, "design");
  assert.match(items[0].reason, /非听感证明/);
  assert.equal(/保证声线辨识度/.test(items[0].reason), false);
});

test("auto preset-full promote reason uses 非听感证明 not 撞声保证", () => {
  const { items } = planCharacterVoices({
    onlyMissing: true,
    strategy: "auto",
    maxImportantPerPreset: 1,
    characters: [
      {
        characterId: "bound",
        characterName: "已绑男主",
        gender: "male",
        castRole: "protagonist",
        ttsMode: "preset",
        ttsVoice: "白桦",
      },
      {
        characterId: "bound2",
        characterName: "已绑男配",
        gender: "male",
        castRole: "ally",
        ttsMode: "preset",
        ttsVoice: "苏打",
      },
      {
        characterId: "new",
        characterName: "新男重要",
        gender: "male",
        castRole: "antagonist",
        // 无 texture：走 preset 池；重要位被 seed 占满后应升 design
      },
    ],
  });
  const item = items.find((i) => i.characterId === "new");
  assert.ok(item);
  assert.equal(item.ttsMode, "design");
  assert.match(item.reason, /非听感证明/);
  assert.equal(/避免撞声(?!.*分配)/.test(item.reason), false);
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

test("slotsEqual and parseSlotFromDesignPrompt round-trip labels", () => {
  const slot = { pitchBand: "high", textureBand: "airy", energyBand: "lively" };
  assert.equal(slotsEqual(slot, { ...slot }), true);
  assert.equal(slotsEqual(slot, { ...slot, pitchBand: "low" }), false);
  const prompt = "【声线】音高偏高，质感偏气声轻柔，气息活泼有弹性";
  const parsed = parseSlotFromDesignPrompt(prompt);
  assert.deepEqual(parsed, slot);
});
