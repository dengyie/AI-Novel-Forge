/**
 * M8 golden 单测：buildChunkSynthesisRequest 与冻结旧 buildLegacySynthesisRequest 逐字段等价。
 *
 * 预览路径迁移（docs/plans/audiobook-synthesis-layering-refactor-design.md §7 M8）后，
 * AudiobookVoiceAssetService 两处 preview 站点改走 buildChunkSynthesisRequest + 就地构造最小 segment。
 * 本测验证迁移后的 SynthesisRequest 与旧 legacy bridge 逐字段等价（voiceProfile.* + delivery）。
 *
 * 覆盖矩阵：
 *   {preset, design, clone} × {voice 有/无} × {style 干净, style 含「本句表演」脏标记}
 *   × {designPrompt 干净/脏}
 *
 * 冻结旧实现：buildLegacySynthesisRequest_legacy 从 engine/legacyRequestBridge.ts（M8 删除前）
 * 原封不动拷贝。即使源文件已删，golden 仍可持续跑。
 *
 * 关键差异门（用户确认"默认覆盖"脏输入）：
 *   legacy bridge 不 peel；builder 在 delivery=null 时会 peel base。
 *   - 干净输入 → peel no-op → 逐字段等价
 *   - 脏输入（style 含「本句表演」）→ builder 产出 peel(style)，legacy 透传原样
 *     这是有意差异（preview 脏输入是误用，peel 更安全）；用例显式断言该差异并记录。
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildChunkSynthesisRequest,
} = require("../dist/services/audiobook/frontend/synthesisBuilder.js");

const {
  peelCompiledDeliveryMarks,
} = require("../dist/services/audiobook/deliveryStyle.js");

// ─── 冻结旧实现（逐行拷贝自 engine/legacyRequestBridge.ts M8 删除前）───

function buildLegacySynthesisRequest_legacy(input) {
  const voiceProfile = {
    speakerKey: "legacy",
    mode: input.mode,
    voice: input.voice?.trim() || null,
    refAudioPath: input.refAudioPath?.trim() || null,
    baseStyle: input.style ?? null,
    baseDesignPrompt: input.designPrompt ?? null,
    source: input.mode === "preset" ? "narrator" : "card",
    speakerKind: "character",
    characterId: null,
    speakerLabel: "legacy",
  };
  const engineParams = input.provider
    ? { provider: input.provider }
    : undefined;
  return {
    requestId: input.requestId ?? "legacy-req-id",
    text: input.text,
    voiceProfile,
    delivery: null,
    engineParams,
  };
}

// ─── 预览最小 segment 工厂（对齐 AudiobookVoiceAssetService 站点 1 的构造方式）───

function makePreviewSegment({
  mode,
  voice,
  style,
  designPrompt,
  refAudioPath = null,
  text = "试听一句旁白。",
}) {
  return {
    index: 0,
    speakerKind: mode === "preset" ? "narrator" : "character",
    characterId: null,
    speakerLabel: "preview",
    text,
    ttsMode: mode,
    voice: mode === "preset" ? voice : "",
    refAudioPath,
    baseStyle: style,
    baseDesignPrompt: mode === "design" ? designPrompt : null,
    style,
    designPrompt: mode === "design" ? designPrompt : null,
    delivery: null,
  };
}

// ─── 等价断言辅助 ───

function assertReqEquivalent(name, segment) {
  const req = buildChunkSynthesisRequest({ segment, text: segment.text });
  const legacyInput = {
    text: segment.text,
    mode: segment.ttsMode,
    voice: segment.voice,
    style: segment.style,
    designPrompt: segment.designPrompt,
    refAudioPath: segment.refAudioPath,
  };
  const legacy = buildLegacySynthesisRequest_legacy(legacyInput);

  // delivery 都必须 null（builder 是唯一编译点，preview 无段级 delivery）
  assert.equal(req.delivery, null, `${name}: builder delivery 应为 null`);
  assert.equal(legacy.delivery, null, `${name}: legacy delivery 应为 null`);

  const vp = req.voiceProfile;
  const lvp = legacy.voiceProfile;

  // 关键门：adapter 实际消费的字段必须等价（mode/voice/refAudioPath）。
  // baseStyle/baseDesignPrompt 在干净输入下等价、脏输入下有意差异（见 DIRTY 用例）。
  assert.equal(vp.mode, lvp.mode, `${name}: mode`);
  assert.equal(vp.voice, lvp.voice, `${name}: voice`);
  assert.equal(vp.refAudioPath, lvp.refAudioPath, `${name}: refAudioPath`);
  assert.equal(vp.characterId, lvp.characterId, `${name}: characterId`);

  // 审计元数据字段（source/speakerKind/speakerLabel/speakerKey）：
  // legacy bridge 全部硬编码占位（"legacy"/"character"/"narrator"|"card"），
  // builder 从 segment 推断。preview 路径不进 chunkLayoutFingerprint（preview 用独立
  // buildCharacterVoicePreviewFingerprint），故这些字段差异不影响合成与缓存——记录不强制等价。

  return { req, legacy, vp, lvp };
}

// ─── 干净输入用例：逐字段等价（含 baseStyle/baseDesignPrompt）───

const CLEAN_CASES = [
  {
    name: "preset/clean style — 逐字段等价",
    seg: makePreviewSegment({ mode: "preset", voice: "白桦", style: "干净基线" }),
  },
  {
    name: "preset/no voice — null voice 等价",
    seg: makePreviewSegment({ mode: "preset", voice: "", style: "干净基线" }),
  },
  {
    name: "design/clean designPrompt — 逐字段等价",
    seg: makePreviewSegment({
      mode: "design",
      style: "角色基线",
      designPrompt: "青年女性，标准普通话，音高中等。",
    }),
  },
  {
    name: "design/null designPrompt — baseDesignPrompt null 等价",
    seg: makePreviewSegment({ mode: "design", style: "角色基线", designPrompt: null }),
  },
  {
    name: "clone/clean — 逐字段等价",
    seg: makePreviewSegment({
      mode: "clone",
      style: "克隆基线",
      refAudioPath: "/data/voice/ref.wav",
    }),
  },
  {
    name: "null style — baseStyle null 等价",
    seg: makePreviewSegment({ mode: "preset", voice: "白桦", style: null }),
  },
];

for (const tc of CLEAN_CASES) {
  test(`clean: ${tc.name}`, () => {
    const { vp, lvp } = assertReqEquivalent(tc.name, tc.seg);
    // 干净输入：builder 的 peel 是 no-op，baseStyle/baseDesignPrompt 逐字段等价
    assert.equal(vp.baseStyle ?? null, lvp.baseStyle ?? null, `${tc.name}: baseStyle`);
    assert.equal(
      vp.baseDesignPrompt ?? null,
      lvp.baseDesignPrompt ?? null,
      `${tc.name}: baseDesignPrompt`,
    );
  });
}

// ─── 脏输入用例：显式记录 peel 差异（builder peel，legacy 透传）───
// 用户确认"默认覆盖"：preview 脏输入是误用，builder peel 更安全，差异是有意为之。

const DIRTY_STYLE = "干净基线\n本句表演：旧脏句。\n保持该角色声线与身份一致，吐字清楚。";
const DIRTY_DESIGN =
  "青年女性，标准普通话。\n\n表演指令：旧脏。\n\n保持该角色声线与身份一致，吐字清楚。";

test("dirty: style 含「本句表演」→ builder peel 而 legacy 透传（有意差异）", () => {
  const seg = makePreviewSegment({ mode: "preset", voice: "白桦", style: DIRTY_STYLE });
  const { vp, lvp } = assertReqEquivalent("dirty-style", seg);
  // legacy 透传脏原样
  assert.equal(lvp.baseStyle, DIRTY_STYLE);
  // builder peel 掉「本句表演」段，得到干净基线
  assert.equal(vp.baseStyle, peelCompiledDeliveryMarks(DIRTY_STYLE));
  assert.notEqual(vp.baseStyle, lvp.baseStyle, "脏输入下 builder 应与 legacy 不同（peel 差异）");
  assert.equal(
    (vp.baseStyle || "").includes("本句表演"),
    false,
    "builder 产出的 baseStyle 不应含「本句表演」",
  );
});

test("dirty: designPrompt 含「表演指令」→ builder peel 而 legacy 透传（有意差异）", () => {
  const seg = makePreviewSegment({
    mode: "design",
    style: "角色基线",
    designPrompt: DIRTY_DESIGN,
  });
  const { vp, lvp } = assertReqEquivalent("dirty-design", seg);
  assert.equal(lvp.baseDesignPrompt, DIRTY_DESIGN);
  assert.equal(vp.baseDesignPrompt, peelCompiledDeliveryMarks(DIRTY_DESIGN));
  assert.notEqual(vp.baseDesignPrompt, lvp.baseDesignPrompt);
  assert.equal(
    (vp.baseDesignPrompt || "").includes("表演指令"),
    false,
    "builder 产出的 baseDesignPrompt 不应含「表演指令」",
  );
});

// ─── 预 trim 破坏用例：钉死"等价依赖上游预 trim"的风险敞口 ──
// peelCompiledDeliveryMarks 对**干净**输入也会 .trim()（deliveryStyle.ts:44）；
// legacy bridge 不 trim。M8 等价成立仅因生产 preview 调用都在站点预 trim（ephemeral
// 现场 .trim()、candidate 经 normalizePart）。本用例显式证明：若未 trim 输入流入，
// builder 会 trim 而 legacy 透传——即风险敞口的边界，提醒未来直传未 trim caller 注意。

test("pretrim: 未 trim 的干净 style → builder trim 而 legacy 透传（风险敞口记录）", () => {
  const untrimmed = "   干净基线含首尾空白   ";
  const seg = makePreviewSegment({ mode: "preset", voice: "白桦", style: untrimmed });
  const { vp, lvp } = assertReqEquivalent("pretrim-style", seg);
  // legacy 透传原样（含首尾空白）
  assert.equal(lvp.baseStyle, untrimmed);
  // builder 经 peel 的 .trim() 去掉首尾空白
  assert.equal(vp.baseStyle, peelCompiledDeliveryMarks(untrimmed));
  assert.equal(vp.baseStyle, "干净基线含首尾空白");
  assert.notEqual(vp.baseStyle, lvp.baseStyle, "未 trim 输入下 builder 应与 legacy 不同");
});

test("pretrim: 未 trim 的干净 designPrompt → builder trim 而 legacy 透传", () => {
  const untrimmedDesign = "  青年女性，标准普通话。  ";
  const seg = makePreviewSegment({
    mode: "design",
    style: "角色基线",
    designPrompt: untrimmedDesign,
  });
  const { vp, lvp } = assertReqEquivalent("pretrim-design", seg);
  assert.equal(lvp.baseDesignPrompt, untrimmedDesign);
  assert.equal(vp.baseDesignPrompt, "青年女性，标准普通话。");
  assert.notEqual(vp.baseDesignPrompt, lvp.baseDesignPrompt);
});

// ─── 结构门：delivery 恒 null、requestId 生成、text 透传 ───

test("structural: delivery 恒 null + text 透传 + requestId 自动生成", () => {
  const seg = makePreviewSegment({ mode: "preset", voice: "白桦", style: "基线" });
  const req = buildChunkSynthesisRequest({ segment: seg, text: seg.text });
  assert.equal(req.delivery, null);
  assert.equal(req.text, seg.text);
  assert.equal(typeof req.requestId, "string");
  assert.ok(req.requestId.length > 0, "requestId 应自动生成");
  assert.equal(req.engineParams, undefined, "无 provider 时 engineParams 应 undefined");
});

test("structural: provider 注入 engineParams", () => {
  const seg = makePreviewSegment({ mode: "preset", voice: "白桦", style: "基线" });
  const req = buildChunkSynthesisRequest({
    segment: seg,
    text: seg.text,
    provider: "openai",
  });
  assert.deepEqual(req.engineParams, { provider: "openai" });
});
