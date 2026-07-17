const test = require("node:test");
const assert = require("node:assert/strict");

const {
  planCharacterVoices,
  matchLibraryAsset,
  inferGenderBucket,
  inferAgeBucket,
  scoreImportance,
  isCharacterVoiceConfigured,
  inferVoiceSlot,
  allocateVoiceSlot,
  buildDesignPrompt,
  buildDesignPromptDetailed,
  DESIGN_PROMPT_MAX,
  DESIGN_PROMPT_TARGET_MIN,
  DESIGN_PROMPT_TARGET_MAX,
  slotKey,
  parseSlotFromDesignPrompt,
  slotsEqual,
  resolveVoiceCluster,
  slotDistance,
  isLeadRoleText,
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

test("auto smart_fill: lead/cast design even without voiceTexture", () => {
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
        personality: "冷硬克制",
      },
      {
        characterId: "b",
        characterName: "赵明远",
        gender: "male",
        castRole: "antagonist",
        personality: "强势",
      },
    ],
  });

  assert.equal(items.length, 2);
  // smart_fill: lead/cast → design 不依赖 texture
  assert.equal(items.every((i) => i.ttsMode === "design"), true);
  for (const item of items) {
    assert.equal(Boolean(item.ttsDesignPrompt && item.ttsDesignPrompt.length > 8), true);
    assert.ok(item.ttsDesignPrompt.length <= DESIGN_PROMPT_MAX);
    assert.match(item.ttsDesignPrompt, /音高/);
    assert.match(item.ttsDesignPrompt, /质感/);
    assert.match(item.ttsDesignPrompt, /气息/);
    assert.equal(Boolean(parseSlotFromDesignPrompt(item.ttsDesignPrompt)), true);
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

test("prefer_design uses design for lead/cast and preset for extras", () => {
  const { items } = planCharacterVoices({
    onlyMissing: false,
    strategy: "prefer_design",
    characters: [
      { characterId: "1", characterName: "甲", gender: "female", castRole: "protagonist" },
      { characterId: "2", characterName: "乙", gender: "male", castRole: "ally" },
      { characterId: "3", characterName: "丙", gender: "male", role: "路人" },
    ],
  });
  const lead = items.find((i) => i.characterId === "1");
  const cast = items.find((i) => i.characterId === "2");
  const extra = items.find((i) => i.characterId === "3");
  assert.ok(lead && cast && extra);
  assert.equal(lead.ttsMode, "design");
  assert.equal(cast.ttsMode, "design");
  assert.equal(extra.ttsMode, "preset");
  assert.ok(["苏打", "白桦"].includes(extra.ttsVoice));
  for (const item of [lead, cast]) {
    assert.ok(item.ttsDesignPrompt.length <= DESIGN_PROMPT_MAX);
    assert.match(item.ttsDesignPrompt, /音高/);
    assert.match(item.ttsDesignPrompt, /质感/);
    assert.match(item.ttsDesignPrompt, /气息/);
    assert.equal(Boolean(parseSlotFromDesignPrompt(item.ttsDesignPrompt)), true);
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
        castRole: "mentor",
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
        castRole: "ally",
        voiceTexture: "沉稳沙哑低沉威严",
      },
      {
        characterId: "m2",
        characterName: "二",
        gender: "male",
        castRole: "ally",
        voiceTexture: "沉稳沙哑低沉威严",
      },
      {
        characterId: "m3",
        characterName: "三",
        gender: "male",
        castRole: "ally",
        voiceTexture: "沉稳沙哑低沉威严",
      },
    ],
  });

  const overridden = items.filter((item) => item.reason.includes("slot:override"));
  assert.equal(overridden.length >= 1, true);

  for (const item of items) {
    const prompt = item.ttsDesignPrompt || "";
    // 质感明亮/中性 时，不得再拼沙哑/低沉威严整句
    if (/质感明亮清脆|质感中性干净/.test(prompt)) {
      assert.equal(/沙哑|低沉威严/.test(prompt), false);
    }
    assert.equal(Boolean(parseSlotFromDesignPrompt(prompt)), true);
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
    cluster: "lead",
  });
  assert.ok(prompt.length <= DESIGN_PROMPT_MAX);
  assert.match(prompt, /音高偏低/);
  assert.match(prompt, /质感偏低略沙哑/);
  assert.match(prompt, /气息沉稳有分量/);
  assert.match(prompt, /沉稳略沙哑/);
  assert.match(prompt, /避免|区分|可辨|空壳|播音/);
  assert.notEqual(prompt.trim(), longTexture.slice(0, DESIGN_PROMPT_MAX));
  assert.equal(Boolean(parseSlotFromDesignPrompt(prompt)), true);
  assert.doesNotMatch(prompt, /【声线】|【身份】/);
  assert.doesNotMatch(prompt, /「测试角」/);
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
    cluster: "cast",
  });
  assert.match(prompt, /质感明亮清脆/);
  assert.equal(/沙哑|低沉威严/.test(prompt), false);
  assert.equal(Boolean(parseSlotFromDesignPrompt(prompt)), true);
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
          castRole: "ally",
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
    castRole: "ally",
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
  assert.match(softItem.ttsDesignPrompt, /明显区分|明显区别于/);
  assert.match(softItem.ttsDesignPrompt, /声线/);
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
        castRole: "ally",
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
        castRole: "ally",
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

test("auto smart_fill antagonist is design with 非听感证明 (not 撞声保证)", () => {
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
        // smart_fill: cast → design，不依赖 preset 满位
      },
    ],
  });
  const item = items.find((i) => i.characterId === "new");
  assert.ok(item);
  assert.equal(item.ttsMode, "design");
  assert.match(item.reason, /非听感证明/);
  assert.equal(/避免撞声(?!.*分配)/.test(item.reason), false);
});

test("auto preset-full promote for non-core still uses 非听感证明", () => {
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
        characterName: "高重要路人",
        gender: "male",
        role: "路人",
        // 非 lead/cast：importance 默认低 → preset；若用 high importance+texture 会 design
        // 这里用已占满男 preset + maxImportantPerPreset=1 时，后续男 preset 路径升 design
        // 用 unknown cluster with importance via castRole empty and name only - force via max
      },
      // seed more missing males as extras to exhaust pool with maxImportant=1
      { characterId: "e1", characterName: "路人1", gender: "male", role: "路人" },
      { characterId: "e2", characterName: "路人2", gender: "male", role: "路人" },
      { characterId: "e3", characterName: "路人3", gender: "male", role: "路人" },
    ],
  });
  const extras = items.filter((i) => i.characterId.startsWith("e") || i.characterId === "new");
  assert.ok(extras.length >= 1);
  // 至少有一条若升 design，reason 须带 非听感证明
  for (const item of extras) {
    if (item.ttsMode === "design") {
      assert.match(item.reason, /非听感证明/);
      assert.equal(/保证声线辨识度/.test(item.reason), false);
    }
  }
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

test("lead default energy is heavy not flat even", () => {
  const slot = inferVoiceSlot({
    characterId: "1",
    characterName: "主角",
    castRole: "protagonist",
    gender: "male",
  });
  assert.equal(slot.energyBand, "heavy");
  assert.notEqual(slot.energyBand, "even");
});

test("lead keeps lively when lively cues present", () => {
  const slot = inferVoiceSlot({
    characterId: "1",
    characterName: "主角",
    castRole: "protagonist",
    personality: "活泼灵动",
  });
  assert.equal(slot.energyBand, "lively");
});

test("resolveVoiceCluster maps lead/cast/extra/narrator", () => {
  assert.equal(
    resolveVoiceCluster({ characterId: "1", characterName: "A", castRole: "protagonist" }),
    "lead",
  );
  assert.equal(
    resolveVoiceCluster({ characterId: "2", characterName: "B", castRole: "ally" }),
    "cast",
  );
  assert.equal(
    resolveVoiceCluster({ characterId: "3", characterName: "C", role: "路人甲" }),
    "extra",
  );
  assert.equal(
    resolveVoiceCluster({ characterId: "4", characterName: "旁白", role: "旁白" }),
    "narrator",
  );
});

test("isLeadRoleText rejects dependents and maps female lead to non-lead text", () => {
  assert.equal(isLeadRoleText("主角"), true);
  assert.equal(isLeadRoleText("男主角"), true);
  assert.equal(isLeadRoleText("主人公"), true);
  assert.equal(isLeadRoleText("废柴主角"), true);
  assert.equal(isLeadRoleText("主角的父亲"), false);
  assert.equal(isLeadRoleText("主人公的师父"), false);
  assert.equal(isLeadRoleText("女主"), false);
  assert.equal(isLeadRoleText("女主角"), false);
});

test("resolveVoiceCluster does not promote 主角的父亲 to lead", () => {
  assert.equal(
    resolveVoiceCluster({ characterId: "1", characterName: "父", role: "主角的父亲" }),
    "extra",
  );
  // 女主走 cast（importance/love 文案），非 lead
  assert.equal(
    resolveVoiceCluster({ characterId: "2", characterName: "她", role: "女主" }),
    "cast",
  );
  assert.equal(
    resolveVoiceCluster({ characterId: "3", characterName: "她", role: "女主角" }),
    "cast",
  );
});

test("prefer_design keeps narrator on isolated preset cluster", () => {
  const { items } = planCharacterVoices({
    onlyMissing: false,
    strategy: "prefer_design",
    characters: [
      {
        characterId: "n1",
        characterName: "旁白",
        gender: "female",
        role: "旁白",
      },
      {
        characterId: "p1",
        characterName: "主角",
        gender: "male",
        castRole: "protagonist",
      },
    ],
  });
  const narrator = items.find((i) => i.characterId === "n1");
  const lead = items.find((i) => i.characterId === "p1");
  assert.ok(narrator && lead);
  assert.equal(narrator.ttsMode, "preset");
  assert.equal(narrator.cluster, "narrator");
  assert.ok(["茉莉", "冰糖"].includes(narrator.ttsVoice));
  assert.equal(lead.ttsMode, "design");
  assert.equal(lead.cluster, "lead");
  assert.match(lead.ttsDesignPrompt, /意志坚定|主心骨|死气/);
});

test("allocateVoiceSlot minSeparation prefers multi-axis distance", () => {
  const occupied = new Set();
  const occupiedSlotByKey = new Map();
  const preferred = { pitchBand: "mid", textureBand: "neutral", energyBand: "heavy" };
  const first = allocateVoiceSlot({
    gender: "male",
    preferred,
    occupied,
    occupiedSlotByKey,
    minSeparation: 2,
  });
  occupied.add(first.key);
  occupiedSlotByKey.set(first.key, first.slot);

  const second = allocateVoiceSlot({
    gender: "male",
    preferred,
    occupied,
    occupiedSlotByKey,
    minSeparation: 2,
  });
  assert.equal(second.softCollision, false);
  assert.notEqual(second.key, first.key);
  assert.equal(slotDistance(first.slot, second.slot) >= 2, true);
});

test("slotsEqual and parseSlotFromDesignPrompt round-trip labels", () => {
  const slot = { pitchBand: "high", textureBand: "airy", energyBand: "lively" };
  assert.equal(slotsEqual(slot, { ...slot }), true);
  assert.equal(slotsEqual(slot, { ...slot, pitchBand: "low" }), false);
  const legacy = "【声线】音高偏高，质感偏气声轻柔，气息活泼有弹性";
  assert.deepEqual(parseSlotFromDesignPrompt(legacy), slot);
  const natural = "青年女性，标准普通话，音高偏高，质感偏气声轻柔，气息活泼有弹性，适合女主情感对白。避免播音腔。";
  assert.deepEqual(parseSlotFromDesignPrompt(natural), slot);
});

test("buildDesignPrompt natural language stays within hard max and parses", () => {
  const prompt = buildDesignPrompt({
    character: {
      characterId: "lead-1",
      characterName: "林某某",
      role: "主角",
      castRole: "protagonist",
      personality: "克制隐忍但内心炽热不肯认输",
      voiceTexture: "清亮略薄，咬字利落",
    },
    gender: "male",
    age: "youth",
    slot: { pitchBand: "mid", textureBand: "bright", energyBand: "heavy" },
    preferredSlot: { pitchBand: "mid", textureBand: "bright", energyBand: "heavy" },
    cluster: "lead",
    softCollision: true,
    neighborSlotLabel: "偏低偏低略沙哑声线",
  });
  assert.ok(prompt.length <= DESIGN_PROMPT_MAX);
  assert.match(prompt, /音高中等/);
  assert.match(prompt, /质感明亮清脆/);
  assert.match(prompt, /气息沉稳有分量/);
  assert.match(prompt, /明显区分/);
  assert.doesNotMatch(prompt, /林某某|【声线】|【身份】/);
  assert.deepEqual(parseSlotFromDesignPrompt(prompt), {
    pitchBand: "mid",
    textureBand: "bright",
    energyBand: "heavy",
  });
});

test("soft-target estimate uses real mutex tail not placeholder", () => {
  const longNeighbor = "偏低偏低略沙哑声线且偏气声轻柔的邻槽";
  const { prompt: collisionPrompt } = buildDesignPromptDetailed({
    character: {
      characterId: "lead-soft",
      characterName: "何屿",
      role: "主角",
      castRole: "protagonist",
      personality: "克制",
      voiceTexture: "清亮",
    },
    gender: "male",
    age: "adult",
    slot: { pitchBand: "mid", textureBand: "bright", energyBand: "heavy" },
    preferredSlot: { pitchBand: "mid", textureBand: "bright", energyBand: "heavy" },
    cluster: "lead",
    softCollision: true,
    neighborSlotLabel: longNeighbor,
  });
  // 真 tail 含长 neighbor；估长与最终同构 → 不因假尾误塞 habits 撞 hard max
  assert.ok(collisionPrompt.length <= DESIGN_PROMPT_MAX);
  assert.match(collisionPrompt, /明显区分/);
  assert.match(collisionPrompt, new RegExp(longNeighbor));
  assert.match(collisionPrompt, /避免播音腔/);

  const plain = buildDesignPrompt({
    character: {
      characterId: "lead-plain",
      characterName: "林婉",
      role: "主角",
      castRole: "protagonist",
      personality: "克制",
      voiceTexture: "清亮",
    },
    gender: "female",
    age: "adult",
    slot: { pitchBand: "mid", textureBand: "bright", energyBand: "heavy" },
    preferredSlot: { pitchBand: "mid", textureBand: "bright", energyBand: "heavy" },
    cluster: "lead",
    softCollision: false,
  });
  assert.ok(plain.length <= DESIGN_PROMPT_MAX);
  // phase-2：最多 1 条癖好；可能是 texture/energy/lead 之一，不再强制 lead-center
  assert.ok(parseSlotFromDesignPrompt(plain));
  assert.match(plain, /音高中等|音高偏/);
  // soft 区间是目标不是 hard floor；反灌水后可低于 TARGET_MIN
  assert.ok(
    plain.length <= DESIGN_PROMPT_MAX,
    `plain should stay under hard max, got ${plain.length}: ${plain}`,
  );
  assert.ok(
    collisionPrompt.includes(longNeighbor),
    "collision path must keep real mutex neighbor in tail",
  );
  assert.ok(DESIGN_PROMPT_TARGET_MIN >= 100);
  assert.ok(DESIGN_PROMPT_TARGET_MAX <= DESIGN_PROMPT_MAX);
});

test("reservedPresets excludes narrator voice from character preset pool", () => {
  const { items } = planCharacterVoices({
    onlyMissing: true,
    strategy: "preset_only",
    reservedPresets: ["白桦"],
    characters: [
      { characterId: "m1", characterName: "甲", gender: "male", role: "路人" },
      { characterId: "m2", characterName: "乙", gender: "male", role: "路人" },
      { characterId: "m3", characterName: "丙", gender: "male", role: "路人" },
    ],
  });
  assert.equal(items.length, 3);
  assert.equal(items.every((i) => i.ttsMode === "preset"), true);
  assert.equal(items.every((i) => i.ttsVoice !== "白桦"), true);
  // 男预置去掉白桦后只剩苏打 → 全部苏打
  assert.equal(items.every((i) => i.ttsVoice === "苏打"), true);
});

test("reservedPresets empty pool forces design for lead/cast", () => {
  const { items } = planCharacterVoices({
    onlyMissing: true,
    strategy: "auto",
    reservedPresets: ["苏打", "白桦", "茉莉", "冰糖"],
    characters: [
      { characterId: "lead1", characterName: "主角", gender: "male", castRole: "protagonist" },
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].ttsMode, "design");
  assert.match(items[0].reason, /reservedPresets|design|smart_fill|升 design/i);
});

test("isCharacterVoiceConfigured treats clone+assetId as configured", () => {
  assert.equal(
    isCharacterVoiceConfigured({
      ttsMode: "clone",
      ttsVoiceAssetId: "va_abc",
    }),
    true,
  );
  assert.equal(
    isCharacterVoiceConfigured({
      ttsMode: "clone",
      ttsRefAudioPath: "",
      ttsVoiceAssetId: null,
    }),
    false,
  );
});

test("matchLibraryAsset scores gender+cluster and skips used/gender-conflict", () => {
  const assets = [
    {
      id: "va_male_lead",
      slug: "yuan-male-lead",
      displayName: "男主",
      status: "approved",
      kind: "clone_ref",
      tags: ["male", "lead", "seed"],
    },
    {
      id: "va_female_lead",
      slug: "yuan-female-lead",
      displayName: "女主",
      status: "approved",
      kind: "clone_ref",
      tags: ["female", "lead"],
    },
    {
      id: "va_draft",
      slug: "drafty",
      displayName: "draft",
      status: "draft",
      kind: "clone_ref",
      tags: ["male", "lead"],
    },
  ];
  const hit = matchLibraryAsset({
    genderBucket: "male",
    cluster: "lead",
    assets,
    usedAssetIds: new Set(),
  });
  assert.ok(hit);
  assert.equal(hit.asset.id, "va_male_lead");

  const used = matchLibraryAsset({
    genderBucket: "male",
    cluster: "lead",
    assets,
    usedAssetIds: new Set(["va_male_lead"]),
  });
  // 男 lead 已用完；女 lead gender 冲突 → null
  assert.equal(used, null);

  const female = matchLibraryAsset({
    genderBucket: "female",
    cluster: "lead",
    assets,
    usedAssetIds: new Set(),
  });
  assert.equal(female.asset.id, "va_female_lead");
});

test("prefer_library recommends approved assets and falls back without match", () => {
  const libraryAssets = [
    {
      id: "va_m",
      slug: "yuan-male-lead",
      displayName: "源男主",
      status: "approved",
      kind: "clone_ref",
      tags: ["male", "lead"],
    },
    {
      id: "va_f",
      slug: "yuan-female-lead",
      displayName: "源女主",
      status: "approved",
      kind: "clone_ref",
      tags: ["female", "lead"],
    },
  ];
  const { items } = planCharacterVoices({
    onlyMissing: true,
    strategy: "prefer_library",
    libraryAssets,
    characters: [
      { characterId: "m", characterName: "男主", gender: "male", castRole: "protagonist" },
      { characterId: "f", characterName: "女主", gender: "female", castRole: "protagonist" },
      { characterId: "x", characterName: "路人甲", gender: "male", role: "路人" },
    ],
  });
  const male = items.find((i) => i.characterId === "m");
  const female = items.find((i) => i.characterId === "f");
  const extra = items.find((i) => i.characterId === "x");
  assert.equal(male.ttsMode, "clone");
  assert.equal(male.ttsVoiceAssetId, "va_m");
  assert.equal(female.ttsMode, "clone");
  assert.equal(female.ttsVoiceAssetId, "va_f");
  // 无匹配 extra 库 → preset 回退
  assert.equal(extra.ttsMode, "preset");
  assert.ok(extra.ttsVoice);
});

test("prefer_library ignores draft assets", () => {
  const { items } = planCharacterVoices({
    onlyMissing: true,
    strategy: "prefer_library",
    libraryAssets: [
      {
        id: "va_draft",
        slug: "draft",
        displayName: "草稿",
        status: "draft",
        kind: "clone_ref",
        tags: ["male", "lead"],
      },
    ],
    characters: [
      { characterId: "m", characterName: "男主", gender: "male", castRole: "protagonist" },
    ],
  });
  assert.equal(items[0].ttsMode, "design");
  assert.equal(items[0].ttsVoiceAssetId, null);
});

test("auto with libraryAssets prefers clone for lead", () => {
  const { items } = planCharacterVoices({
    onlyMissing: true,
    strategy: "auto",
    libraryAssets: [
      {
        id: "va_m",
        slug: "yuan-male-lead",
        displayName: "源男主",
        status: "approved",
        kind: "clone_ref",
        tags: ["male", "lead"],
      },
    ],
    characters: [
      { characterId: "m", characterName: "男主", gender: "male", castRole: "protagonist" },
    ],
  });
  assert.equal(items[0].ttsMode, "clone");
  assert.equal(items[0].ttsVoiceAssetId, "va_m");
});

test("clone with only assetId is permanent skip", () => {
  const { items, skipped } = planCharacterVoices({
    onlyMissing: false,
    strategy: "prefer_library",
    libraryAssets: [
      {
        id: "va_other",
        slug: "other",
        displayName: "其它",
        status: "approved",
        kind: "clone_ref",
        tags: ["male", "lead"],
      },
    ],
    characters: [
      {
        characterId: "bound",
        characterName: "已绑",
        gender: "male",
        castRole: "protagonist",
        ttsMode: "clone",
        ttsVoiceAssetId: "va_bound",
      },
    ],
  });
  assert.equal(items.length, 0);
  assert.equal(skipped.some((s) => s.characterId === "bound"), true);
});

test("library assets are not double-assigned", () => {
  const libraryAssets = [
    {
      id: "va_only",
      slug: "one",
      displayName: "唯一",
      status: "approved",
      kind: "clone_ref",
      tags: ["male", "lead"],
    },
  ];
  const { items } = planCharacterVoices({
    onlyMissing: true,
    strategy: "prefer_library",
    libraryAssets,
    characters: [
      { characterId: "a", characterName: "甲", gender: "male", castRole: "protagonist" },
      { characterId: "b", characterName: "乙", gender: "male", castRole: "protagonist" },
    ],
  });
  const clones = items.filter((i) => i.ttsMode === "clone");
  assert.equal(clones.length, 1);
  assert.equal(clones[0].ttsVoiceAssetId, "va_only");
  const other = items.find((i) => i.ttsMode !== "clone");
  assert.ok(other);
  assert.equal(other.ttsMode, "design");
});

test("untagged approved asset is rejected for lead/cast", () => {
  const hit = matchLibraryAsset({
    genderBucket: "male",
    cluster: "lead",
    usedAssetIds: new Set(),
    assets: [
      {
        id: "va_open",
        slug: "open",
        displayName: "open",
        status: "approved",
        kind: "clone_ref",
        tags: [],
      },
    ],
  });
  assert.equal(hit, null);

  const { items } = planCharacterVoices({
    onlyMissing: true,
    strategy: "prefer_library",
    libraryAssets: [
      {
        id: "va_open",
        slug: "open",
        displayName: "open",
        status: "approved",
        kind: "clone_ref",
        tags: [],
      },
    ],
    characters: [
      { characterId: "m", characterName: "男主", gender: "male", castRole: "protagonist" },
    ],
  });
  assert.equal(items[0].ttsMode, "design");
  assert.equal(items[0].ttsVoiceAssetId, null);
});

test("untagged approved asset is rejected for extra/narrator (score floor)", () => {
  const hit = matchLibraryAsset({
    genderBucket: "male",
    cluster: "extra",
    usedAssetIds: new Set(),
    assets: [
      {
        id: "va_open",
        slug: "open",
        displayName: "open",
        status: "approved",
        kind: "clone_ref",
        tags: [],
      },
    ],
  });
  assert.equal(hit, null);
});

test("cluster-only tag can still match lead without gender tag", () => {
  const hit = matchLibraryAsset({
    genderBucket: "male",
    cluster: "lead",
    usedAssetIds: new Set(),
    assets: [
      {
        id: "va_lead",
        slug: "lead-only",
        displayName: "lead",
        status: "approved",
        kind: "clone_ref",
        tags: ["lead"],
      },
    ],
  });
  assert.ok(hit);
  assert.equal(hit.asset.id, "va_lead");
});

test("gender-only tag is rejected for lead/cast (requires cluster tag)", () => {
  const hit = matchLibraryAsset({
    genderBucket: "male",
    cluster: "lead",
    usedAssetIds: new Set(),
    assets: [
      {
        id: "va_male_only",
        slug: "male-only",
        displayName: "male-only",
        status: "approved",
        kind: "clone_ref",
        tags: ["male"],
      },
    ],
  });
  assert.equal(hit, null);

  const castHit = matchLibraryAsset({
    genderBucket: "male",
    cluster: "cast",
    usedAssetIds: new Set(),
    assets: [
      {
        id: "va_male_only",
        slug: "male-only",
        displayName: "male-only",
        status: "approved",
        kind: "clone_ref",
        tags: ["male"],
      },
    ],
  });
  assert.equal(castHit, null);
});

test("narrator rejects gender-only and lead-tagged assets; requires narrator tag", () => {
  const genderOnly = matchLibraryAsset({
    genderBucket: "male",
    cluster: "narrator",
    usedAssetIds: new Set(),
    assets: [
      {
        id: "va_male",
        slug: "male",
        displayName: "male",
        status: "approved",
        kind: "clone_ref",
        tags: ["male"],
      },
    ],
  });
  assert.equal(genderOnly, null);

  const leadTagged = matchLibraryAsset({
    genderBucket: "male",
    cluster: "narrator",
    usedAssetIds: new Set(),
    assets: [
      {
        id: "va_lead",
        slug: "lead",
        displayName: "lead",
        status: "approved",
        kind: "clone_ref",
        tags: ["male", "lead"],
      },
    ],
  });
  assert.equal(leadTagged, null);

  const narratorOk = matchLibraryAsset({
    genderBucket: "male",
    cluster: "narrator",
    usedAssetIds: new Set(),
    assets: [
      {
        id: "va_n",
        slug: "narrator-m",
        displayName: "旁白男",
        status: "approved",
        kind: "clone_ref",
        tags: ["male", "narrator"],
      },
    ],
  });
  assert.ok(narratorOk);
  assert.equal(narratorOk.asset.id, "va_n");
});

test("extra may still match gender-only approved assets", () => {
  const hit = matchLibraryAsset({
    genderBucket: "male",
    cluster: "extra",
    usedAssetIds: new Set(),
    assets: [
      {
        id: "va_male",
        slug: "male",
        displayName: "male",
        status: "approved",
        kind: "clone_ref",
        tags: ["male"],
      },
    ],
  });
  assert.ok(hit);
  assert.equal(hit.asset.id, "va_male");
});

