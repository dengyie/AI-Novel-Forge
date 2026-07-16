const test = require("node:test");
const assert = require("node:assert/strict");

const {
  STABILITY_GUARD,
  MIMO_USER_MAX,
  BASE_STYLE_PREFER_MAX,
  normalizeDelivery,
  validateDeliveryLine,
  compileDeliveryLine,
  compileNarratorDeliveryLine,
  deliveryMergeKey,
  emotionFamily,
  resolveDeliveryLine,
  resolveSynthesizeInput,
  resolveDeliveryStyleMode,
  shouldApplyDelivery,
  applyDeliveryToSegment,
  fingerprintStyleParts,
  fillContinuityFrom,
  computeDeliveryChapterStats,
} = require("../dist/services/audiobook/deliveryStyle.js");

const GOOD_CORE = {
  primaryEmotion: "压抑愤怒",
  intensity: "mid",
  surfaceTone: "平静公事",
  intent: "逼对方把责任说清楚",
  vocalEffort: "soft",
  rate: "measured",
  maskOrLeak: "强装镇定，牙关发紧",
  subtext: "表面问流程，其实拒再背锅",
  sceneSpace: "狭小出租屋夜谈",
  scenePressure: "一对一逼问",
  addresseeRelation: "对甩锅上级",
  continuityFrom: "承接对方冷笑，怒意未消",
  rawFactors: ["被甩锅", "领导冷笑", "夜"],
  deliveryLine:
    "平静公事地压着怒，强装镇定却牙关发紧；对上级逼问责任；压低音量、语速沉稳、句中短暂停再接。",
};

// ── normalize ──────────────────────────────────────────────

test("normalizeDelivery returns null for empty/invalid", () => {
  assert.equal(normalizeDelivery(null), null);
  assert.equal(normalizeDelivery(undefined), null);
  assert.equal(normalizeDelivery("x"), null);
  assert.equal(normalizeDelivery({}), null);
  assert.equal(normalizeDelivery({ intensity: "mid" }), null);
});

test("normalizeDelivery fills Core defaults from partial good input", () => {
  const d = normalizeDelivery({
    primaryEmotion: "压抑愤怒",
    surfaceTone: "平静公事",
  });
  assert.ok(d);
  assert.equal(d.primaryEmotion, "压抑愤怒");
  assert.equal(d.surfaceTone, "平静公事");
  assert.equal(d.intensity, "mid");
  assert.equal(d.vocalEffort, "normal");
  assert.equal(d.rate, "normal");
  assert.equal(d.intent, "把话说清楚");
});

test("normalizeDelivery clips and keeps Extended fields", () => {
  const d = normalizeDelivery(GOOD_CORE);
  assert.ok(d);
  assert.equal(d.maskOrLeak, "强装镇定，牙关发紧");
  assert.equal(d.sceneSpace, "狭小出租屋夜谈");
  assert.equal(d.addresseeRelation, "对甩锅上级");
  assert.ok(d.deliveryLine.includes("压着怒"));
  assert.equal(d.rawFactors.length, 3);
});

test("normalizeDelivery drops secondaryTraits colliding with emotion", () => {
  const d = normalizeDelivery({
    primaryEmotion: "愤怒",
    surfaceTone: "冷",
    secondaryTraits: ["愤怒", "克制"],
  });
  assert.ok(d);
  assert.deepEqual(d.secondaryTraits, ["克制"]);
});

// ── validate / compile ─────────────────────────────────────

test("validateDeliveryLine accepts gold-standard line", () => {
  const d = normalizeDelivery(GOOD_CORE);
  assert.ok(d);
  assert.equal(validateDeliveryLine(d, "你把责任说清楚。"), true);
});

test("validateDeliveryLine rejects empty talk", () => {
  const d = normalizeDelivery({
    ...GOOD_CORE,
    deliveryLine: "请有感情地朗读这一段，要生动自然情绪到位。",
  });
  assert.ok(d);
  assert.equal(validateDeliveryLine(d, "你把责任说清楚。"), false);
});

test("validateDeliveryLine rejects spoken-text recitation", () => {
  const spoken = "别回头跟我走现在立刻";
  const d = normalizeDelivery({
    ...GOOD_CORE,
    deliveryLine: "平静地说别回头跟我走现在立刻然后压低音量。",
  });
  assert.ok(d);
  assert.equal(validateDeliveryLine(d, spoken), false);
});

test("validateDeliveryLine rejects too-short line", () => {
  const d = normalizeDelivery({
    ...GOOD_CORE,
    deliveryLine: "压怒。",
  });
  assert.ok(d);
  assert.equal(validateDeliveryLine(d, "你把责任说清楚。"), false);
});

test("compileDeliveryLine produces executable Chinese with vocal cues", () => {
  const d = normalizeDelivery({
    primaryEmotion: "压抑愤怒",
    intensity: "mid",
    surfaceTone: "平静公事",
    intent: "逼对方承认甩锅",
    vocalEffort: "soft",
    rate: "measured",
    maskOrLeak: "强装镇定",
    sceneSpace: "出租屋",
  });
  assert.ok(d);
  const line = compileDeliveryLine(d);
  assert.ok(line.length >= 12);
  assert.ok(line.length <= 120);
  assert.ok(line.includes("平静公事"));
  assert.ok(line.includes("压抑愤怒") || line.includes("愤怒"));
  assert.ok(line.includes("压低音量") || line.includes("语速"));
  assert.equal(EMPTY_SAFE(line), true);
});

function EMPTY_SAFE(line) {
  return !/有感情|请朗读|生动自然/.test(line);
}

test("compileDeliveryLine strips overact words when intensity is not high", () => {
  const d = normalizeDelivery({
    primaryEmotion: "悲伤",
    intensity: "mid",
    surfaceTone: "压抑",
    intent: "忍住不哭",
    vocalEffort: "soft",
    rate: "slow",
    pauseBreath: "嘶吼后停顿",
  });
  assert.ok(d);
  const line = compileDeliveryLine(d);
  assert.equal(/嘶吼|哭喊|崩溃/.test(line), false);
});

test("resolveDeliveryLine falls back to compile when model line is bad", () => {
  const d = normalizeDelivery({
    ...GOOD_CORE,
    deliveryLine: "请有感情地朗读。",
  });
  assert.ok(d);
  const line = resolveDeliveryLine(d, "你把责任说清楚。");
  assert.ok(line.length >= 12);
  assert.equal(/请有感情/.test(line), false);
  assert.ok(line.includes("平静公事") || line.includes("压抑愤怒"));
});

// ── mergeKey ───────────────────────────────────────────────

test("deliveryMergeKey buckets same emotion family together", () => {
  const a = normalizeDelivery({
    primaryEmotion: "压抑愤怒",
    intensity: "mid",
    surfaceTone: "冷",
    intent: "质问",
    vocalEffort: "soft",
    rate: "measured",
  });
  const b = normalizeDelivery({
    primaryEmotion: "怒火",
    intensity: "mid",
    surfaceTone: "硬",
    intent: "威胁",
    vocalEffort: "soft",
    rate: "measured",
  });
  assert.ok(a && b);
  assert.equal(emotionFamily(a.primaryEmotion), "anger");
  assert.equal(emotionFamily(b.primaryEmotion), "anger");
  assert.equal(deliveryMergeKey(a), deliveryMergeKey(b));
});

test("deliveryMergeKey differs across intensity or effort", () => {
  const a = normalizeDelivery({
    primaryEmotion: "惧",
    intensity: "low",
    surfaceTone: "轻",
    intent: "试探",
    vocalEffort: "soft",
    rate: "measured",
  });
  const b = normalizeDelivery({
    primaryEmotion: "惧",
    intensity: "high",
    surfaceTone: "紧",
    intent: "求饶",
    vocalEffort: "soft",
    rate: "measured",
  });
  const c = normalizeDelivery({
    primaryEmotion: "惧",
    intensity: "low",
    surfaceTone: "轻",
    intent: "试探",
    vocalEffort: "raised",
    rate: "measured",
  });
  assert.ok(a && b && c);
  assert.notEqual(deliveryMergeKey(a), deliveryMergeKey(b));
  assert.notEqual(deliveryMergeKey(a), deliveryMergeKey(c));
});

test("deliveryMergeKey null → none", () => {
  assert.equal(deliveryMergeKey(null), "none");
  assert.equal(deliveryMergeKey(undefined), "none");
});

// ── resolveSynthesizeInput ─────────────────────────────────

test("resolveSynthesizeInput off/null delivery keeps static base (preset)", () => {
  const r = resolveSynthesizeInput(
    {
      ttsMode: "preset",
      baseStyle: "声线偏低，吐字清楚。",
      delivery: null,
    },
    { deliveryStyleMode: "characters" },
  );
  assert.equal(r.style, "声线偏低，吐字清楚。");
  assert.ok(!r.style.includes("本句表演"));
});

test("resolveSynthesizeInput preset injects performance + guard", () => {
  const d = normalizeDelivery(GOOD_CORE);
  const r = resolveSynthesizeInput({
    ttsMode: "preset",
    baseStyle: "声线偏低略收，吐字清楚，语速中等，内敛敏感，不夸张。",
    delivery: d,
    text: "你把责任说清楚。",
  });
  assert.ok(r.style);
  assert.ok(r.style.includes("本句表演："));
  assert.ok(r.style.includes(STABILITY_GUARD));
  assert.ok(r.style.includes("声线偏低"));
  assert.ok(r.style.length <= MIMO_USER_MAX);
});

test("resolveSynthesizeInput design merges into designPrompt not style channel only", () => {
  const d = normalizeDelivery(GOOD_CORE);
  const r = resolveSynthesizeInput({
    ttsMode: "design",
    baseStyle: "审计用基线",
    baseDesignPrompt: "青年男性，声线偏低略收，吐字干净。",
    delivery: d,
    text: "你把责任说清楚。",
  });
  assert.ok(r.designPrompt);
  assert.ok(r.designPrompt.includes("青年男性"));
  assert.ok(r.designPrompt.includes("表演指令："));
  assert.ok(r.designPrompt.includes(STABILITY_GUARD));
  assert.ok(r.designPrompt.length <= MIMO_USER_MAX);
  // style 可保留 base 审计
  assert.equal(r.style, "审计用基线");
});

test("resolveSynthesizeInput prefers base when truncating to 280", () => {
  const longBase = "基线声线描述。" + "稳。".repeat(80);
  const d = normalizeDelivery(GOOD_CORE);
  const r = resolveSynthesizeInput({
    ttsMode: "preset",
    baseStyle: longBase,
    delivery: d,
    text: "你把责任说清楚。",
  });
  assert.ok(r.style);
  assert.ok(r.style.length <= MIMO_USER_MAX);
  assert.ok(r.style.startsWith("基线") || r.style.includes("基线声线"));
  assert.ok(r.style.includes(STABILITY_GUARD));
  assert.ok(r.style.includes("本句表演"));
  // base 优先保留至 ~120
  const basePart = r.style.split("\n")[0];
  assert.ok(basePart.length <= BASE_STYLE_PREFER_MAX + 5);
});

test("resolveSynthesizeInput clone path uses style like preset", () => {
  const d = normalizeDelivery(GOOD_CORE);
  const r = resolveSynthesizeInput({
    ttsMode: "clone",
    baseStyle: "克隆基线，吐字清楚。",
    delivery: d,
    text: "跟我走。",
  });
  assert.ok(r.style.includes("本句表演："));
  assert.ok(r.style.includes(STABILITY_GUARD));
});

// ── mode helpers ───────────────────────────────────────────

test("resolveDeliveryStyleMode defaults to off", () => {
  assert.equal(resolveDeliveryStyleMode(null, null), "off");
  assert.equal(resolveDeliveryStyleMode("bogus", null), "off");
  assert.equal(resolveDeliveryStyleMode("characters", null), "characters");
  assert.equal(resolveDeliveryStyleMode(null, "all"), "all");
  assert.equal(resolveDeliveryStyleMode("off", "characters"), "off");
});

test("shouldApplyDelivery respects mode and speakerKind", () => {
  assert.equal(shouldApplyDelivery("off", "character"), false);
  assert.equal(shouldApplyDelivery("characters", "character"), true);
  assert.equal(shouldApplyDelivery("characters", "narrator"), false);
  assert.equal(shouldApplyDelivery("all", "narrator"), true);
});

// ── applyDeliveryToSegment + fingerprint ───────────────────

test("applyDeliveryToSegment wires mergeKey and resolved style", () => {
  const seg = applyDeliveryToSegment(
    {
      index: 0,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "何屿",
      text: "你把责任说清楚。",
      ttsMode: "preset",
      voice: "白桦",
      style: "声线偏低，吐字清楚。",
    },
    GOOD_CORE,
    {
      deliveryStyleMode: "characters",
      baseStyle: "声线偏低，吐字清楚。",
    },
  );
  assert.ok(seg.delivery);
  assert.equal(seg.deliveryMergeKey, deliveryMergeKey(seg.delivery));
  assert.ok(seg.style.includes("本句表演："));
  assert.equal(seg.baseStyle, "声线偏低，吐字清楚。");
});

test("applyDeliveryToSegment peels bad delivery without dropping speaker fields", () => {
  const seg = applyDeliveryToSegment(
    {
      index: 1,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "何屿",
      text: "别回头。",
      ttsMode: "preset",
      voice: "白桦",
      style: "基线。",
    },
    { intensity: "high" }, // 无 emotion/tone → null
    {
      deliveryStyleMode: "characters",
      baseStyle: "基线。",
    },
  );
  assert.equal(seg.delivery, null);
  assert.equal(seg.deliveryMergeKey, "none");
  assert.equal(seg.speakerKind, "character");
  assert.equal(seg.characterId, "c1");
  assert.equal(seg.voice, "白桦");
  assert.equal(seg.style, "基线。");
});

test("applyDeliveryToSegment mode=off ignores raw delivery", () => {
  const seg = applyDeliveryToSegment(
    {
      index: 0,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "何屿",
      text: "你把责任说清楚。",
      ttsMode: "preset",
      voice: "白桦",
      style: "基线。",
    },
    GOOD_CORE,
    { deliveryStyleMode: "off", baseStyle: "基线。" },
  );
  assert.equal(seg.delivery, null);
  assert.equal(seg.style, "基线。");
  assert.equal(seg.style.includes("本句表演"), false);
});

test("fingerprintStyleParts includes style and designPrompt", () => {
  const parts = fingerprintStyleParts({
    style: "a\n本句表演：x",
    designPrompt: "design+表演指令",
  });
  assert.equal(parts.style, "a\n本句表演：x");
  assert.equal(parts.designPrompt, "design+表演指令");
  const empty = fingerprintStyleParts({});
  assert.equal(empty.style, "");
  assert.equal(empty.designPrompt, "");
});

// ── 金标准样例集（源世界风格）────────────────────────────

const GOLDEN = [
  {
    name: "对峙压抑怒",
    delivery: GOOD_CORE,
    spoken: "你把责任说清楚。",
    expectPass: true,
  },
  {
    name: "软化安抚",
    delivery: {
      primaryEmotion: "温柔关切",
      intensity: "low",
      surfaceTone: "轻声安抚",
      intent: "让对方把心放下",
      vocalEffort: "soft",
      rate: "slow",
      sceneSpace: "病房床边",
      deliveryLine:
        "轻声安抚地藏着关切，语速放慢、压低音量，像怕惊醒伤口；对亲近之人低声劝稳。",
    },
    spoken: "先歇一会儿，别急着起来。",
    expectPass: true,
  },
  {
    name: "惧怕试探",
    delivery: {
      primaryEmotion: "恐惧",
      intensity: "mid",
      surfaceTone: "发紧试探",
      intent: "确认门外是否还有人",
      vocalEffort: "whisper",
      rate: "measured",
      pitchMove: "lifted",
      deliveryLine:
        "发紧试探地压着恐惧，气声耳语、语速沉稳、音高微抬；密闭走廊，确认门外动静。",
    },
    spoken: "外面……还有人吗？",
    expectPass: true,
  },
  {
    name: "冷嘲",
    delivery: {
      primaryEmotion: "轻蔑",
      intensity: "mid",
      surfaceTone: "冷笑淡讲",
      intent: "刺对方一句",
      vocalEffort: "normal",
      rate: "measured",
      nonverbalCue: "轻哼",
      deliveryLine:
        "冷笑淡讲地带着轻蔑，正常音量、语速沉稳；对冤家轻哼一句刺过去。",
    },
    spoken: "呵，你也会怕？",
    expectPass: true,
  },
  {
    name: "坏例-空话",
    delivery: {
      primaryEmotion: "悲伤",
      intensity: "mid",
      surfaceTone: "低落",
      intent: "诉苦",
      vocalEffort: "soft",
      rate: "slow",
      deliveryLine: "请有感情地生动自然地朗读。",
    },
    spoken: "我真的撑不住了。",
    expectPass: false,
  },
  {
    name: "坏例-复述台词",
    delivery: {
      primaryEmotion: "焦急",
      intensity: "high",
      surfaceTone: "急促",
      intent: "催促",
      vocalEffort: "raised",
      rate: "rushed",
      deliveryLine: "急促地说快点走这里不安全不要回头看。",
    },
    spoken: "快点走，这里不安全，不要回头看。",
    expectPass: false,
  },
  {
    name: "坏例-过短",
    delivery: {
      primaryEmotion: "怒",
      intensity: "high",
      surfaceTone: "厉",
      intent: "骂",
      vocalEffort: "raised",
      rate: "fast",
      deliveryLine: "很生气。",
    },
    spoken: "滚。",
    expectPass: false,
  },
  {
    name: "坏例-与情绪无关空壳",
    delivery: {
      primaryEmotion: "压抑愤怒",
      intensity: "mid",
      surfaceTone: "平静公事",
      intent: "质问",
      vocalEffort: "soft",
      rate: "measured",
      deliveryLine: "用普通的日常说话方式把句子念出来就好。",
    },
    spoken: "你把责任说清楚。",
    expectPass: false,
  },
];

for (const sample of GOLDEN) {
  test(`golden:${sample.name}`, () => {
    const d = normalizeDelivery(sample.delivery);
    assert.ok(d, `${sample.name}: should normalize`);
    const ok = validateDeliveryLine(d, sample.spoken);
    assert.equal(ok, sample.expectPass, `${sample.name}: validate=${ok}`);
    const line = resolveDeliveryLine(d, sample.spoken);
    assert.ok(line.length >= 12, `${sample.name}: line too short`);
    assert.ok(line.length <= 120, `${sample.name}: line too long`);
    assert.equal(/请有感情|生动自然/.test(line), false, `${sample.name}: empty talk leaked`);
    if (!sample.expectPass) {
      // 坏模型句必须被 compile 替换
      assert.notEqual(line, (sample.delivery.deliveryLine || "").trim());
    }
  });
}

// ── Phase2: continuity / narrator all / stats ────────────────

test("fillContinuityFrom fills empty continuity for same character", () => {
  const a = applyDeliveryToSegment(
    {
      index: 0,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "何屿",
      text: "你把责任说清楚。",
      ttsMode: "preset",
      voice: "白桦",
      style: "基线",
    },
    { ...GOOD_CORE, continuityFrom: null, deliveryLine: null },
    { deliveryStyleMode: "characters", baseStyle: "基线" },
  );
  const b = applyDeliveryToSegment(
    {
      index: 1,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "何屿",
      text: "别再甩锅。",
      ttsMode: "preset",
      voice: "白桦",
      style: "基线",
    },
    {
      primaryEmotion: "压抑愤怒",
      intensity: "mid",
      surfaceTone: "平静公事",
      intent: "再压一句",
      vocalEffort: "soft",
      rate: "measured",
      deliveryLine: null,
    },
    { deliveryStyleMode: "characters", baseStyle: "基线" },
  );
  assert.equal(b.delivery?.continuityFrom ?? null, null);
  const filled = fillContinuityFrom([a, b], { deliveryStyleMode: "characters" });
  assert.equal(filled[0].delivery?.continuityFrom ?? null, null);
  assert.match(filled[1].delivery?.continuityFrom || "", /承接上句/);
  assert.match(filled[1].delivery?.continuityFrom || "", /压抑愤怒|怒/);
});

test("fillContinuityFrom does not overwrite model continuityFrom", () => {
  const a = applyDeliveryToSegment(
    {
      index: 0,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "何屿",
      text: "先说。",
      ttsMode: "preset",
      voice: "白桦",
      style: "基线",
    },
    GOOD_CORE,
    { deliveryStyleMode: "characters", baseStyle: "基线" },
  );
  const b = applyDeliveryToSegment(
    {
      index: 1,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "何屿",
      text: "再说。",
      ttsMode: "preset",
      voice: "白桦",
      style: "基线",
    },
    {
      ...GOOD_CORE,
      continuityFrom: "模型已写承接",
      deliveryLine: null,
    },
    { deliveryStyleMode: "characters", baseStyle: "基线" },
  );
  const filled = fillContinuityFrom([a, b], { deliveryStyleMode: "characters" });
  assert.equal(filled[1].delivery?.continuityFrom, "模型已写承接");
});

test("mode=all narrator uses 本句叙述 not 本句表演", () => {
  const seg = applyDeliveryToSegment(
    {
      index: 0,
      speakerKind: "narrator",
      characterId: null,
      speakerLabel: "旁白",
      text: "夜色渐深，长街只剩脚步声。",
      ttsMode: "preset",
      voice: "茉莉",
      style: "知性旁白",
    },
    {
      primaryEmotion: "沉静",
      intensity: "low",
      surfaceTone: "低缓",
      intent: "铺陈夜景",
      vocalEffort: "soft",
      rate: "slow",
      deliveryLine: null,
    },
    { deliveryStyleMode: "all", baseStyle: "知性旁白" },
  );
  assert.ok(seg.delivery);
  assert.match(seg.style || "", /本句叙述：/);
  assert.equal((seg.style || "").includes("本句表演"), false);
  assert.match(seg.style || "", /不抢角色/);
  const line = compileNarratorDeliveryLine(seg.delivery);
  assert.match(line, /像有声书旁白/);
});

test("computeDeliveryChapterStats tracks peel and apply rate", () => {
  const good = applyDeliveryToSegment(
    {
      index: 0,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "何屿",
      text: "你把责任说清楚。",
      ttsMode: "preset",
      voice: "白桦",
      style: "基线",
    },
    GOOD_CORE,
    { deliveryStyleMode: "characters", baseStyle: "基线" },
  );
  const peeled = applyDeliveryToSegment(
    {
      index: 1,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "何屿",
      text: "别急。",
      ttsMode: "preset",
      voice: "白桦",
      style: "基线",
    },
    { intensity: "high" },
    { deliveryStyleMode: "characters", baseStyle: "基线" },
  );
  const stats = computeDeliveryChapterStats([good, peeled], {
    peeledCount: 1,
    chunkJobCount: 2,
  });
  assert.equal(stats.segmentCount, 2);
  assert.equal(stats.characterSegmentCount, 2);
  assert.equal(stats.deliveryApplied, 1);
  assert.equal(stats.deliveryPeeled, 1);
  assert.equal(stats.deliveryApplyRate, 0.5);
  assert.equal(stats.mergeChunkMultiplier, 1);
  assert.ok(stats.avgResolvedUserLen > 0);
});
