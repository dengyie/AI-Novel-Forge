/**
 * M3 golden 单测：compileDeliveryStyleForSegment 与冻结旧 resolveChunkSynthesizeFields 逐字段等价。
 *
 * 覆盖矩阵：
 *   {preset, design, clone} × {narrator, character} × {no-delivery, with-delivery}
 *   + dirty style (peel) / dirty design (peel)
 *   + speakerUnresolved (guest fallback → narrator voice)
 *   + null/undefined edge cases
 *
 * 冻结旧实现：resolveChunkSynthesizeFields_legacy 是从 HEAD (d91213e 之前)
 * 原封不动拷贝的完整函数体。即使生产代码中薄别名被删除，golden 仍可持续跑。
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  compileDeliveryStyleForSegment,
  buildChunkSynthesisRequest,
} = require("../dist/services/audiobook/frontend/synthesisBuilder.js");

const {
  synthesisRequestToMimoInput,
} = require("../dist/services/audiobook/engine/mimoTtsEngine.js");

const {
  peelCompiledDeliveryMarks,
  applyDeliveryToSegment,
  resolveSynthesizeInput,
} = require("../dist/services/audiobook/deliveryStyle.js");

// ─── 冻结旧实现（逐行拷贝自 HEAD 版 AudiobookPipelineService.ts:464–525）───

function resolveChunkSynthesizeFields_legacy(segment) {
  const styleRaw = typeof segment.style === "string" ? segment.style : "";
  const designRaw = typeof segment.designPrompt === "string" ? segment.designPrompt : "";
  const dirtyStyle = styleRaw.includes("本句表演：")
    || styleRaw.includes("本句叙述：")
    || styleRaw.includes("表演指令：");
  const dirtyDesign = designRaw.includes("表演指令：");

  const baseStyleClean = peelCompiledDeliveryMarks(segment.baseStyle)
    ?? (dirtyStyle
      ? peelCompiledDeliveryMarks(segment.style)
      : (segment.baseStyle ?? segment.style ?? null));
  const baseDesignClean = peelCompiledDeliveryMarks(segment.baseDesignPrompt)
    ?? (dirtyDesign
      ? peelCompiledDeliveryMarks(segment.designPrompt)
      : (segment.baseDesignPrompt ?? segment.designPrompt ?? null));

  if (!segment.delivery) {
    return {
      style: baseStyleClean,
      designPrompt: baseDesignClean,
    };
  }

  if (segment.speakerKind === "narrator") {
    const rebuilt = applyDeliveryToSegment(
      {
        ...segment,
        style: baseStyleClean,
        designPrompt: baseDesignClean,
      },
      segment.delivery,
      {
        deliveryStyleMode: "all",
        baseStyle: baseStyleClean,
        baseDesignPrompt: baseDesignClean,
      },
    );
    return {
      style: rebuilt.style,
      designPrompt: rebuilt.designPrompt,
    };
  }

  return resolveSynthesizeInput({
    ttsMode: segment.ttsMode,
    baseStyle: baseStyleClean,
    baseDesignPrompt: baseDesignClean,
    style: baseStyleClean,
    designPrompt: baseDesignClean,
    delivery: segment.delivery,
    text: segment.text,
  });
}

// ─── 通用 delivery fixture ───

const DELIVERY_MID = {
  primaryEmotion: "压抑愤怒",
  intensity: "mid",
  surfaceTone: "平静公事",
  intent: "逼问",
  vocalEffort: "soft",
  rate: "measured",
  deliveryLine: "平静公事地压着怒，语速沉稳。",
};

const DELIVERY_HIGH = {
  primaryEmotion: "恐惧",
  intensity: "high",
  surfaceTone: "颤抖",
  intent: "求救",
  vocalEffort: "strained",
  rate: "rushed",
  deliveryLine: "颤抖求救，语速急促。",
};

// ─── 基线 segment 工厂 ───

function makeSegment(overrides) {
  return {
    index: 0,
    speakerKind: "character",
    characterId: "c1",
    speakerLabel: "何屿",
    text: "你把责任说清楚。",
    ttsMode: "preset",
    voice: "白桦",
    style: null,
    designPrompt: null,
    baseStyle: null,
    baseDesignPrompt: null,
    delivery: null,
    ...overrides,
  };
}

// ─── 测试用例矩阵 ───

const GOLDEN_CASES = [
  // ── preset × character ──
  {
    name: "preset/character/no-delivery — clean base",
    segment: makeSegment({
      ttsMode: "preset",
      baseStyle: "干净基线",
      style: "干净基线",
    }),
  },
  {
    name: "preset/character/no-delivery — dirty style (peel)",
    segment: makeSegment({
      ttsMode: "preset",
      baseStyle: "干净基线",
      style: "干净基线\n本句表演：旧脏句。\n保持该角色声线与身份一致，吐字清楚。",
    }),
  },
  {
    name: "preset/character/with-delivery — recompile from base",
    segment: makeSegment({
      ttsMode: "preset",
      baseStyle: "角色基线",
      style: "角色基线\n本句表演：旧标记。",
      delivery: DELIVERY_MID,
    }),
  },
  {
    name: "preset/character/with-delivery — dirty base + dirty style",
    segment: makeSegment({
      ttsMode: "preset",
      baseStyle: "身份基线\n本句表演：过时脏句。\n保持该角色声线与身份一致，吐字清楚。",
      style: "身份基线\n本句表演：过时脏句。\n保持该角色声线与身份一致，吐字清楚。",
      delivery: DELIVERY_MID,
    }),
  },

  // ── design × character ──
  {
    name: "design/character/no-delivery — clean base",
    segment: makeSegment({
      ttsMode: "design",
      voice: "",
      baseDesignPrompt: "青年女性，标准普通话",
      designPrompt: "青年女性，标准普通话",
    }),
  },
  {
    name: "design/character/no-delivery — dirty designPrompt (peel)",
    segment: makeSegment({
      ttsMode: "design",
      voice: "",
      baseDesignPrompt: "青年女性，标准普通话",
      designPrompt: "青年女性，标准普通话\n\n表演指令：旧脏。\n\n保持该角色声线与身份一致。",
    }),
  },
  {
    name: "design/character/with-delivery — recompile designPrompt",
    segment: makeSegment({
      ttsMode: "design",
      voice: "",
      characterId: "c2",
      speakerLabel: "林婉",
      baseDesignPrompt: "青年女性，标准普通话\n\n保持该角色声线与身份一致。",
      designPrompt: "青年女性，标准普通话\n\n表演指令：旧脏。\n\n保持该角色声线与身份一致。",
      delivery: DELIVERY_HIGH,
    }),
  },

  // ── clone × character ──
  {
    name: "clone/character/no-delivery — ref audio",
    segment: makeSegment({
      ttsMode: "clone",
      voice: "",
      refAudioPath: "/audio/ref.wav",
      baseStyle: "克隆基线",
      style: "克隆基线",
    }),
  },
  {
    name: "clone/character/with-delivery — ref audio + delivery",
    segment: makeSegment({
      ttsMode: "clone",
      voice: "",
      refAudioPath: "/audio/ref.wav",
      baseStyle: "克隆基线",
      style: "克隆基线\n本句表演：旧。",
      delivery: DELIVERY_MID,
    }),
  },

  // ── narrator ──
  {
    name: "preset/narrator/no-delivery — clean base",
    segment: makeSegment({
      speakerKind: "narrator",
      characterId: null,
      speakerLabel: "旁白",
      ttsMode: "preset",
      voice: "茉莉",
      baseStyle: "旁白基线",
      style: "旁白基线",
      text: "他沉默了片刻。",
    }),
  },
  {
    name: "preset/narrator/with-delivery — recompile style",
    segment: makeSegment({
      speakerKind: "narrator",
      characterId: null,
      speakerLabel: "旁白",
      ttsMode: "preset",
      voice: "茉莉",
      baseStyle: "旁白基线",
      style: "旁白基线\n本句叙述：旧脏。",
      delivery: DELIVERY_MID,
      text: "他沉默了片刻。",
    }),
  },
  {
    name: "preset/narrator/with-delivery — dirty base peel",
    segment: makeSegment({
      speakerKind: "narrator",
      characterId: null,
      speakerLabel: "旁白",
      ttsMode: "preset",
      voice: "茉莉",
      baseStyle: "旁白基线\n本句叙述：过时。\n保持该角色声线与身份一致。",
      style: "旁白基线\n本句叙述：过时。\n保持该角色声线与身份一致。",
      delivery: DELIVERY_HIGH,
      text: "她猛然回头。",
    }),
  },

  // ── speakerUnresolved (guest fallback) ──
  {
    name: "preset/character-unresolved/with-delivery — guest voice",
    segment: makeSegment({
      speakerKind: "character",
      characterId: null,
      speakerLabel: "远哥",
      speakerUnresolved: true,
      unresolvedSpeakerName: "远哥",
      ttsMode: "preset",
      voice: "茉莉",
      baseStyle: "旁白基线",
      style: "旁白基线",
      delivery: DELIVERY_MID,
      text: "你走吧。",
    }),
  },

  // ── edge: null/undefined style fields ──
  {
    name: "preset/character/no-delivery — all style fields null",
    segment: makeSegment({
      ttsMode: "preset",
      baseStyle: null,
      style: null,
      baseDesignPrompt: null,
      designPrompt: null,
    }),
  },
  {
    name: "preset/character/no-delivery — style undefined (missing key)",
    segment: (() => {
      const seg = makeSegment({ ttsMode: "preset", baseStyle: null });
      delete seg.style;
      delete seg.designPrompt;
      delete seg.baseDesignPrompt;
      return seg;
    })(),
  },
];

// ─── golden 等价测试 ───

for (const tc of GOLDEN_CASES) {
  test(`golden: ${tc.name} → style/designPrompt 字段等价`, () => {
    const compiled = compileDeliveryStyleForSegment(tc.segment);
    const legacy = resolveChunkSynthesizeFields_legacy(tc.segment);

    // 核心 golden 门：style 与 designPrompt 等价
    assert.equal(
      compiled.style ?? null,
      legacy.style ?? null,
      `style mismatch in "${tc.name}"`,
    );
    assert.equal(
      compiled.designPrompt ?? null,
      legacy.designPrompt ?? null,
      `designPrompt mismatch in "${tc.name}"`,
    );
  });
}

// ─── builder → adapter 端到端等价 ───

for (const tc of GOLDEN_CASES) {
  test(`e2e: ${tc.name} → adapter 产出与 legacy 等价`, () => {
    const legacy = resolveChunkSynthesizeFields_legacy(tc.segment);
    const req = buildChunkSynthesisRequest({
      segment: tc.segment,
      text: tc.segment.text,
    });

    // delivery 已消融进 base
    assert.equal(req.delivery, null, `delivery should be null after builder compile`);

    // 经 adapter 机械选取后的最终 style/designPrompt 应与 legacy 等价
    const mimoInput = synthesisRequestToMimoInput(req);
    assert.equal(
      mimoInput.style ?? null,
      legacy.style ?? null,
      `adapter style mismatch in "${tc.name}"`,
    );
    assert.equal(
      mimoInput.designPrompt ?? null,
      legacy.designPrompt ?? null,
      `adapter designPrompt mismatch in "${tc.name}"`,
    );
  });
}

// ─── builder 结构断言 ───

test("buildChunkSynthesisRequest populates voiceProfile fields correctly", () => {
  const segment = makeSegment({
    ttsMode: "preset",
    voice: "白桦",
    refAudioPath: "/audio/ref.wav",
    baseStyle: "基线",
    characterId: "c1",
    speakerLabel: "何屿",
    speakerKind: "character",
  });
  const req = buildChunkSynthesisRequest({
    segment,
    text: "测试文本。",
    provider: "openai",
  });

  assert.equal(req.text, "测试文本。");
  assert.equal(req.delivery, null);
  assert.equal(req.voiceProfile.mode, "preset");
  assert.equal(req.voiceProfile.voice, "白桦");
  assert.equal(req.voiceProfile.refAudioPath, "/audio/ref.wav");
  assert.equal(req.voiceProfile.speakerKey, "character:c1");
  assert.equal(req.voiceProfile.speakerKind, "character");
  assert.equal(req.voiceProfile.characterId, "c1");
  assert.equal(req.voiceProfile.speakerLabel, "何屿");
  assert.equal(req.voiceProfile.source, "card");
  assert.equal(req.engineParams.provider, "openai");
  assert.ok(req.requestId, "requestId should be populated");
});

test("buildChunkSynthesisRequest narrator → source narrator, speakerKey narrator", () => {
  const segment = makeSegment({
    speakerKind: "narrator",
    characterId: null,
    speakerLabel: "旁白",
    ttsMode: "preset",
    voice: "茉莉",
    baseStyle: "旁白基线",
    text: "叙述。",
  });
  const req = buildChunkSynthesisRequest({ segment, text: "叙述。" });

  assert.equal(req.voiceProfile.speakerKey, "narrator");
  assert.equal(req.voiceProfile.source, "narrator");
  assert.equal(req.voiceProfile.speakerKind, "narrator");
  assert.equal(req.voiceProfile.characterId, null);
});

test("buildChunkSynthesisRequest speakerUnresolved → source guest", () => {
  const segment = makeSegment({
    speakerKind: "character",
    characterId: null,
    speakerLabel: "远哥",
    speakerUnresolved: true,
    ttsMode: "preset",
    voice: "茉莉",
    baseStyle: "旁白基线",
    text: "你走吧。",
  });
  const req = buildChunkSynthesisRequest({ segment, text: "你走吧。" });

  assert.equal(req.voiceProfile.source, "guest");
  assert.equal(req.voiceProfile.speakerKey, "label:远哥");
});

test("buildChunkSynthesisRequest normalizes ttsMode edge cases", () => {
  // null → preset
  let req = buildChunkSynthesisRequest({
    segment: makeSegment({ ttsMode: null }),
    text: "t",
  });
  assert.equal(req.voiceProfile.mode, "preset");

  // " design " → design
  req = buildChunkSynthesisRequest({
    segment: makeSegment({ ttsMode: " design " }),
    text: "t",
  });
  assert.equal(req.voiceProfile.mode, "design");

  // "clone" → clone
  req = buildChunkSynthesisRequest({
    segment: makeSegment({ ttsMode: "clone" }),
    text: "t",
  });
  assert.equal(req.voiceProfile.mode, "clone");

  // garbage → preset
  req = buildChunkSynthesisRequest({
    segment: makeSegment({ ttsMode: "garbage" }),
    text: "t",
  });
  assert.equal(req.voiceProfile.mode, "preset");
});

test("buildChunkSynthesisRequest no provider → engineParams undefined", () => {
  const req = buildChunkSynthesisRequest({
    segment: makeSegment({}),
    text: "t",
  });
  assert.equal(req.engineParams, undefined);
});

test("buildChunkSynthesisRequest custom requestId", () => {
  const req = buildChunkSynthesisRequest({
    segment: makeSegment({}),
    text: "t",
    requestId: "custom-id-123",
  });
  assert.equal(req.requestId, "custom-id-123");
});
