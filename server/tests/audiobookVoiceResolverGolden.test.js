/**
 * M5 golden 单测：VoiceResolver.resolveVoiceProfileForSegment 产出冻结 VoiceProfile，
 * 与旧 reconcile/materialize 写入 segment 的绑定字段、以及 M3 builder 内 ad-hoc 推断映射
 * 逐字段等价（绑定优先级在此一处显式定义：narrator / guest / card；library 预留）。
 *
 * 覆盖矩阵：
 *   - narrator（旁白恒 preset；orphan 角色 reconcile 阶段已被强制降级为 narrator）
 *   - character / card（preset / design / clone；speakerUnresolved=false）
 *   - character / guest（speakerUnresolved=true；路人预置音色）
 *   - 各种 ttsMode 边界（null/""/ " design "/garbage → preset）
 *   - clone ref / design designPrompt 透传
 *   - 与 buildChunkSynthesisRequest 端到端：resolver → builder → adapter 等价
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveVoiceProfileForSegment,
  defaultVoiceResolver,
} = require("../dist/services/audiobook/voice/voiceResolver.js");

const { buildChunkSynthesisRequest } = require("../dist/services/audiobook/frontend/synthesisBuilder.js");
const { synthesisRequestToMimoInput } = require("../dist/services/audiobook/engine/mimoTtsEngine.js");

// 绑定源映射契约（guest 有名优先；nameless orphan 虽 unresolved 但声=旁白 → narrator）：
//   - named guest（speakerUnresolved + 有效角色名）→ "guest"
//   - narrator kind / nameless quote orphan → "narrator"
//   - 其它 unresolved 脏态 → "guest"（保守）
//   - else → "card"
// 与 resolveVoiceProfileSource / namedGuestSpeakerName 对齐（非 M5 前旧字节冻结）。
function isNarratorLikeLabel(raw) {
  const t = (raw ?? "").trim();
  return !t || t === "旁白" || t === "narrator";
}
function namedGuestName(segment) {
  if (!segment.speakerUnresolved) return null;
  const rawName = (segment.unresolvedSpeakerName ?? "").trim();
  if (rawName && !isNarratorLikeLabel(rawName)) return rawName;
  const label = (segment.speakerLabel ?? "").trim();
  if (label && !isNarratorLikeLabel(label)) return label;
  return null;
}
function legacyInferSource(segment) {
  if (namedGuestName(segment)) return "guest";
  if (segment.speakerKind === "narrator") return "narrator";
  // nameless: unresolved + 旁白类 label → narrator（与 isNamelessQuoteOrphan 一致）
  if (segment.speakerUnresolved) {
    const rawName = (segment.unresolvedSpeakerName ?? "").trim();
    const label = (segment.speakerLabel ?? "").trim();
    if (
      (!rawName || isNarratorLikeLabel(rawName))
      && isNarratorLikeLabel(label)
    ) {
      return "narrator";
    }
    return "guest";
  }
  return "card";
}

function legacyNormalizeTtsMode(raw) {
  const trimmed = raw?.trim();
  return trimmed === "design" || trimmed === "clone" ? trimmed : "preset";
}

// 旧 builder 内联拼装 VoiceProfile（除 base* 由 compileDelivery 覆盖外）的冻结拷贝
function legacyBuildVoiceProfile(segment) {
  return {
    speakerKey: require("../dist/services/audiobook/audiobookGap.js").speakerKeyFromSegment(segment),
    mode: legacyNormalizeTtsMode(segment.ttsMode),
    voice: segment.voice?.trim() || null,
    refAudioPath: segment.refAudioPath?.trim() || null,
    // base* 在 legacy 里由 compileDelivery 覆盖；这里填干净 base 做等价对照（resolver 不编 delivery）
    baseStyle: segment.baseStyle ?? null,
    baseDesignPrompt: segment.baseDesignPrompt ?? null,
    source: legacyInferSource(segment),
    speakerKind: segment.speakerKind === "character" ? "character" : "narrator",
    characterId: segment.characterId ?? null,
    speakerLabel: segment.speakerLabel,
  };
}

function seg(overrides) {
  return {
    index: 0,
    speakerKind: "character",
    characterId: "c1",
    speakerLabel: "何屿",
    text: "测试。",
    ttsMode: "preset",
    voice: "白桦",
    style: null,
    designPrompt: null,
    baseStyle: null,
    baseDesignPrompt: null,
    refAudioPath: null,
    delivery: null,
    ...overrides,
  };
}

const CASES = [
  { name: "narrator preset", s: seg({ speakerKind: "narrator", characterId: null, speakerLabel: "旁白", voice: "茉莉", baseStyle: "旁白基线" }) },
  { name: "character card preset", s: seg({ ttsMode: "preset", voice: "白桦", baseStyle: "角色基线" }) },
  { name: "character card design", s: seg({ ttsMode: "design", voice: "", characterId: "c2", speakerLabel: "林婉", baseDesignPrompt: "青年女性" }) },
  { name: "character card clone", s: seg({ ttsMode: "clone", voice: "", refAudioPath: "/audio/ref.wav", baseStyle: "克隆基线" }) },
  { name: "guest unresolved preset", s: seg({ speakerKind: "character", characterId: null, speakerLabel: "远哥", speakerUnresolved: true, voice: "苏打", baseStyle: "路人基线" }) },
  { name: "narrator orphan (forced degrade)", s: seg({ speakerKind: "narrator", characterId: null, speakerLabel: "旁白", voice: "茉莉", baseStyle: "旁白基线" }) },
  // 生产关键场景：未匹配路人以 narrator kind + speakerUnresolved 承载（见 materialize/ruleAssembly）。
  // 旧映射 narrator 优先会误报 "narrator"；修复后必须先判有名 unresolved → "guest"。
  { name: "narrator kind + unresolved name → guest", s: seg({ speakerKind: "narrator", characterId: null, speakerLabel: "苏打", speakerUnresolved: true, unresolvedSpeakerName: "远哥", voice: "苏打", baseStyle: "路人基线" }) },
  // 无名 quote orphan：旁白声 + unresolved 进 cast 分母，source 仍是 narrator（不是 guest）
  { name: "nameless orphan unresolved → narrator source", s: seg({ speakerKind: "narrator", characterId: null, speakerLabel: "旁白", speakerUnresolved: true, unresolvedSpeakerName: null, voice: "茉莉", baseStyle: "旁白基线" }) },
  { name: "ttsMode null → preset", s: seg({ ttsMode: null }) },
  { name: "ttsMode ' design ' → design", s: seg({ ttsMode: " design ", voice: "", baseDesignPrompt: "x" }) },
  { name: "ttsMode 'garbage' → preset", s: seg({ ttsMode: "garbage" }) },
];

for (const { name, s } of CASES) {
  test(`resolveVoiceProfileForSegment: ${name} → 与旧映射逐字段等价（base* 除外）`, () => {
    const vp = resolveVoiceProfileForSegment(s);
    const legacy = legacyBuildVoiceProfile(s);

    assert.equal(vp.speakerKey, legacy.speakerKey);
    assert.equal(vp.mode, legacy.mode);
    assert.equal(vp.voice, legacy.voice);
    assert.equal(vp.refAudioPath, legacy.refAudioPath);
    assert.equal(vp.baseStyle, legacy.baseStyle);
    assert.equal(vp.baseDesignPrompt, legacy.baseDesignPrompt);
    assert.equal(vp.source, legacy.source);
    assert.equal(vp.speakerKind, legacy.speakerKind);
    assert.equal(vp.characterId, legacy.characterId);
    assert.equal(vp.speakerLabel, legacy.speakerLabel);
  });
}

test("resolveVoiceProfileForSegment produces frozen snapshot (read-side, no delivery)", () => {
  const vp = resolveVoiceProfileForSegment(
    seg({ speakerKind: "narrator", characterId: null, speakerLabel: "旁白", baseStyle: "旁白基线" }),
  );
  // 旁白恒 preset、source narrator、characterId null
  assert.equal(vp.mode, "preset");
  assert.equal(vp.source, "narrator");
  assert.equal(vp.characterId, null);
  assert.equal(vp.speakerKind, "narrator");
});

test("guest source derived from speakerUnresolved (not characterId null alone)", () => {
  // characterWithoutUnresolved + characterId null → source card（speakerKey label:）
  const vpCard = resolveVoiceProfileForSegment(
    seg({ speakerKind: "character", characterId: null, speakerLabel: "无名", speakerUnresolved: false }),
  );
  assert.equal(vpCard.source, "card");
  assert.equal(vpCard.speakerKey, "label:无名");

  // speakerUnresolved=true → guest
  const vpGuest = resolveVoiceProfileForSegment(
    seg({ speakerKind: "character", characterId: null, speakerLabel: "远哥", speakerUnresolved: true }),
  );
  assert.equal(vpGuest.source, "guest");
});

test("defaultVoiceResolver.resolve === resolveVoiceProfileForSegment", () => {
  const s = seg({ ttsMode: "design", voice: "", baseDesignPrompt: "青年女性" });
  assert.deepEqual(defaultVoiceResolver.resolve(s), resolveVoiceProfileForSegment(s));
});

test("e2e: resolver → builder → adapter final style/design 不受 source 映射变更影响", () => {
  // 这条断言锁死：M5 收编后，合成链最终注入仍与字段等价（不依赖 builder 内内联推断）
  const s = seg({
    ttsMode: "preset",
    voice: "白桦",
    baseStyle: "角色基线",
    style: "角色基线\n本句表演：旧。",
    delivery: {
      primaryEmotion: "愤怒", intensity: "mid", surfaceTone: "冷", intent: "逼问",
      vocalEffort: "soft", rate: "measured", deliveryLine: "冷冷地逼问。",
    },
  });
  const req = buildChunkSynthesisRequest({ segment: s, text: "你给我说清楚。" });
  const mimo = synthesisRequestToMimoInput(req);

  assert.equal(req.delivery, null);
  assert.equal(req.voiceProfile.source, "card");
  assert.equal(req.voiceProfile.mode, "preset");
  assert.equal(req.voiceProfile.voice, "白桦");
  // 经 adapter 选取后最终注入 = compileDeliveryStyleForSegment 输出
  assert.match(mimo.style || "", /本句表演：/);
  assert.match(mimo.style || "", /角色基线/);
});
