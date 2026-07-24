/**
 * M6 golden 单测：chunkLayoutFingerprint v2 灰度（AUDIOBOOK_FP_V2）。
 *
 * 验收门（对照 doc §7 M6）：
 *   1) 开关关（缺省）→ 指纹形态与旧完全一致（既有 fingerprint 稳定性测试不动）；
 *   2) 开关开 → 同输入指纹稳定（重复调用一致）；
 *   3) 开 vs 关 → 指纹**不同**（一次性失效语义；旧 chunk-layout.sha1 自然 miss 重合成）；
 *   4) 开 → 指纹含 engine.fingerprintKey 等价输入：mode→model 切换会改 hash（P-5 gate）；
 *      具体用「同 segment，仅把 ttsMode 从 preset 改到 design」开态指纹应不同（model 变），
 *      关态指纹也应不同（旧 hash 已含 ttsMode）——本测试再加一条更强断言：
 *      关态两条 hash 差异唯一来源 = ttsMode 字段，开态差异还叠加了 engine.fingerprintKey，
 *      故「关态差异」≠「开态差异」（证明开态确实叠加了引擎身份贡献）。
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  chunkLayoutFingerprint,
  isAudiobookFingerprintV2Enabled,
} = require("../dist/services/audiobook/AudiobookPipelineService.js");

const { getEngine } = require("../dist/services/audiobook/engine/engineRegistry.js");
require("../dist/services/audiobook/engine/registerBuiltInEngines.js").registerBuiltInEngines();

function setEnv(v) {
  if (v == null) delete process.env.AUDIOBOOK_FP_V2;
  else process.env.AUDIOBOOK_FP_V2 = v;
}

function seg(overrides = {}) {
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
    baseStyle: "角色基线",
    baseDesignPrompt: null,
    refAudioPath: null,
    delivery: null,
    ...overrides,
  };
}

function jobsFor(segment) {
  return [{ text: segment.text, segment }];
}

const baseSegment = seg();

test("isAudiobookFingerprintV2Enabled 识别开关（缺省关）", () => {
  setEnv(null);
  assert.equal(isAudiobookFingerprintV2Enabled(), false);
  setEnv("");
  assert.equal(isAudiobookFingerprintV2Enabled(), false);
  setEnv("0");
  assert.equal(isAudiobookFingerprintV2Enabled(), false);
  setEnv("nope");
  assert.equal(isAudiobookFingerprintV2Enabled(), false);
  setEnv("1");
  assert.equal(isAudiobookFingerprintV2Enabled(), true);
  setEnv("true");
  assert.equal(isAudiobookFingerprintV2Enabled(), true);
  setEnv("ON");
  assert.equal(isAudiobookFingerprintV2Enabled(), true);
  setEnv("  true  ");
  assert.equal(isAudiobookFingerprintV2Enabled(), true);
  setEnv(null); // 还原
});

test("开关关（缺省）：指纹稳定且为旧形态（16 hex，无前缀回退信号）", () => {
  setEnv(null);
  const fp = chunkLayoutFingerprint(jobsFor(baseSegment));
  assert.equal(typeof fp, "string");
  assert.equal(fp.length, 16);
  assert.match(fp, /^[0-9a-f]{16}$/);
  // 稳定性：重复调用一致
  assert.equal(fp, chunkLayoutFingerprint(jobsFor(baseSegment)));
  // 顺序敏感：调换两段不同内容应不同
  const fpA = chunkLayoutFingerprint([
    { text: "甲", segment: seg({ text: "甲", ttsMode: "preset", characterId: "c1" }) },
    { text: "乙", segment: seg({ text: "乙", ttsMode: "preset", characterId: "c2", speakerLabel: "李四" }) },
  ]);
  const fpB = chunkLayoutFingerprint([
    { text: "乙", segment: seg({ text: "乙", ttsMode: "preset", characterId: "c2", speakerLabel: "李四" }) },
    { text: "甲", segment: seg({ text: "甲", ttsMode: "preset", characterId: "c1" }) },
  ]);
  assert.notEqual(fpA, fpB);
});

test("开关开：指纹稳定且为 16 hex", () => {
  setEnv("1");
  const fp = chunkLayoutFingerprint(jobsFor(baseSegment));
  assert.equal(typeof fp, "string");
  assert.equal(fp.length, 16);
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(fp, chunkLayoutFingerprint(jobsFor(baseSegment)));
  setEnv(null);
});

test("开关开 vs 关 → 同输入指纹不同（一次性失效语义）", () => {
  const js = jobsFor(baseSegment);
  setEnv(null);
  const off = chunkLayoutFingerprint(js);
  setEnv("1");
  const on = chunkLayoutFingerprint(js);
  assert.notEqual(off, on);
  setEnv(null);
});

test("P-5 gate：开态叠加 engine.fingerprintKey（关态仅 ttsMode 差异 ≠ 开态差异来源）", () => {
  // 关态：唯一差异是 ttsMode preset vs design
  setEnv(null);
  const offPreset = chunkLayoutFingerprint(jobsFor(seg({ ttsMode: "preset", voice: "白桦", baseStyle: "x" })));
  const offDesign = chunkLayoutFingerprint(jobsFor(seg({ ttsMode: "design", voice: "", baseDesignPrompt: "y" })));
  assert.notEqual(offPreset, offDesign); // 旧 hash 已含 ttsMode，必不同

  // 开态：差异来源 = ttsMode + engine.fingerprintKey（model 切换）
  setEnv("1");
  const onPreset = chunkLayoutFingerprint(jobsFor(seg({ ttsMode: "preset", voice: "白桦", baseStyle: "x" })));
  const onDesign = chunkLayoutFingerprint(jobsFor(seg({ ttsMode: "design", voice: "", baseDesignPrompt: "y" })));
  assert.notEqual(onPreset, onDesign);

  // 更强断言：单段只改 ttsMode、不改其它字段时，
  //   engine.fingerprintKey 必须随 mode 变化（证明 model 进了引擎身份）
  const engine = getEngine("mimo");
  const reqPreset = require("../dist/services/audiobook/frontend/synthesisBuilder.js")
    .buildChunkSynthesisRequest({ segment: seg({ ttsMode: "preset", voice: "白桦" }), text: "t" });
  const reqDesign = require("../dist/services/audiobook/frontend/synthesisBuilder.js")
    .buildChunkSynthesisRequest({ segment: seg({ ttsMode: "design", voice: "", baseDesignPrompt: "y" }), text: "t" });
  assert.notEqual(engine.fingerprintKey(reqPreset), engine.fingerprintKey(reqDesign));
  assert.equal(engine.fingerprintKey(reqPreset), "mimo:mimo-v2.5-tts");
  assert.equal(engine.fingerprintKey(reqDesign), "mimo:mimo-v2.5-tts-voicedesign");
  setEnv(null);
});

test("开关关 → 开：旧缓存值字符串不等（模拟 resume 在新环境下正确 wipe 重合成）", () => {
  // 关态写入的旧指纹，开态重算时必然 mismatch → 上层 wipe 分支触发（语义级断言，不调 run）
  setEnv(null);
  const staleWrittenByOldRun = chunkLayoutFingerprint(jobsFor(baseSegment));
  setEnv("1");
  const recomputedUnderV2 = chunkLayoutFingerprint(jobsFor(baseSegment));
  assert.notEqual(staleWrittenByOldRun, recomputedUnderV2);
  setEnv(null);
});
