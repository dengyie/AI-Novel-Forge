const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeDeliveryChapterStats,
} = require("../dist/services/audiobook/deliveryStyle.js");
const {
  peelCompiledDeliveryMarks,
} = require("../dist/services/audiobook/AudiobookPipelineService.js");
const { compileDeliveryStyleForSegment } = require(
  "../dist/services/audiobook/frontend/synthesisBuilder.js",
);
// M9: resolveChunkSynthesizeFields（薄别名）已删，SoT 现为 compileDeliveryStyleForSegment。
const resolveChunkSynthesizeFields = compileDeliveryStyleForSegment;
const {
  splitTextForTts,
} = require("../dist/services/audiobook/audiobookChunk.js");

test("computeDeliveryChapterStats counts unresolved speakers", () => {
  const stats = computeDeliveryChapterStats([
    {
      index: 0,
      speakerKind: "narrator",
      speakerLabel: "远哥",
      text: "别急。",
      voice: "茉莉",
      speakerUnresolved: true,
      unresolvedSpeakerName: "远哥",
    },
    {
      index: 1,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "何屿",
      text: "嗯。",
      voice: "白桦",
      delivery: {
        primaryEmotion: "平静",
        intensity: "mid",
        surfaceTone: "稳",
        intent: "应",
        vocalEffort: "soft",
        rate: "normal",
      },
    },
    {
      index: 2,
      speakerKind: "narrator",
      speakerLabel: "远哥",
      text: "再等等。",
      voice: "茉莉",
      speakerUnresolved: true,
      unresolvedSpeakerName: "远哥",
    },
  ]);
  assert.equal(stats.unresolvedSpeakerCount, 2);
  assert.deepEqual(stats.unresolvedSpeakerNames, ["远哥"]);
  assert.equal(stats.characterSegmentCount, 1);
  assert.equal(stats.characterDeliveryApplied, 1);
});

test("resolveChunkSynthesizeFields without delivery peels dirty marks to base", () => {
  const synth = resolveChunkSynthesizeFields({
    index: 0,
    speakerKind: "character",
    characterId: "c1",
    speakerLabel: "何屿",
    text: "说清楚。",
    ttsMode: "preset",
    voice: "白桦",
    baseStyle: "干净基线",
    style: "干净基线\n本句表演：旧脏句。\n保持该角色声线与身份一致，吐字清楚。",
    delivery: null,
  });
  assert.equal(synth.style, "干净基线");
  assert.equal((synth.style || "").includes("本句表演"), false);
});

test("resolveChunkSynthesizeFields with delivery always recompiles from base", () => {
  const delivery = {
    primaryEmotion: "压抑愤怒",
    intensity: "mid",
    surfaceTone: "平静公事",
    intent: "逼问",
    vocalEffort: "soft",
    rate: "measured",
    deliveryLine: "平静公事地压着怒，语速沉稳。",
  };
  const synth = resolveChunkSynthesizeFields({
    index: 0,
    speakerKind: "character",
    characterId: "c1",
    speakerLabel: "何屿",
    text: "你把责任说清楚。",
    ttsMode: "preset",
    voice: "白桦",
    baseStyle: "新基线",
    style: "旧基线\n本句表演：过时。",
    delivery,
  });
  assert.match(synth.style || "", /新基线/);
  assert.match(synth.style || "", /本句表演：/);
  assert.equal((synth.style || "").includes("旧基线"), false);
  const matches = (synth.style || "").match(/本句表演：/g) || [];
  assert.equal(matches.length, 1);
});

test("splitTextForTts prefers hard punctuation over early commas", () => {
  // 窗口 80：前半多逗号，句号落在窗口内；后句再拉长保证会切块
  const head = "甲说，乙听，丙看，丁想，戊走，";
  const pad = "字".repeat(50);
  const tail = "然后继续第二句，还要再拉长一些，确保总长超过窗口。".repeat(3);
  const text = `${head}${pad}。${tail}`;
  assert.ok(text.length > 80);
  const chunks = splitTextForTts(text, 80);
  assert.ok(chunks.length > 1, `expected multi-chunk, got ${chunks.length}: ${JSON.stringify(chunks)}`);
  // 第一刀应落在句号后（硬断），而非第一个逗号
  assert.ok(chunks[0].endsWith("。"), `expected hard break ending first chunk, got: ${chunks[0]}`);
  assert.equal(chunks[0].includes("然后继续"), false);
  assert.equal(chunks.join(""), text);
});

test("peelCompiledDeliveryMarks still strips marks", () => {
  assert.equal(
    peelCompiledDeliveryMarks("基线\n本句表演：x\n保持该角色声线与身份一致，吐字清楚。"),
    "基线",
  );
});

const {
  chunkLayoutFingerprint,
  reconcileAnnotationSegmentsWithVoices,
} = require("../dist/services/audiobook/AudiobookPipelineService.js");

test("chunkLayoutFingerprint matches resolveChunkSynthesizeFields SoT (peel dirty base)", () => {
  const dirtyBase =
    "身份基线\n本句表演：过时脏句。\n保持该角色声线与身份一致，吐字清楚，不要模仿旁白腔，不要唱歌，不要串戏到其他角色。";
  const delivery = {
    primaryEmotion: "压抑愤怒",
    intensity: "mid",
    surfaceTone: "平静公事",
    intent: "逼问",
    vocalEffort: "soft",
    rate: "measured",
    deliveryLine: "平静公事地压着怒，语速沉稳。",
  };
  const segment = {
    index: 0,
    speakerKind: "character",
    characterId: "c1",
    speakerLabel: "何屿",
    text: "你把责任说清楚。",
    ttsMode: "preset",
    voice: "白桦",
    baseStyle: dirtyBase,
    style: dirtyBase,
    delivery,
  };
  const synth = resolveChunkSynthesizeFields(segment);
  assert.equal((synth.style || "").includes("过时脏句"), false);
  assert.match(synth.style || "", /身份基线/);
  assert.match(synth.style || "", /本句表演：/);

  // 若指纹仍吃未 peel 的 segment.style，会与 synth 漂移；此处断言指纹稳定且依赖 peel 结果
  const fpA = chunkLayoutFingerprint([{ text: segment.text, segment }]);
  const cleaned = {
    ...segment,
    baseStyle: peelCompiledDeliveryMarks(segment.baseStyle),
    style: peelCompiledDeliveryMarks(segment.style),
  };
  const synthB = resolveChunkSynthesizeFields(cleaned);
  assert.equal(synthB.style, synth.style);
  const fpB = chunkLayoutFingerprint([{ text: cleaned.text, segment: cleaned }]);
  assert.equal(fpA, fpB);

  // 故意污染 style 缓存但保留 baseStyle/delivery：SoT 仍应相同 → 指纹相同
  const polluted = {
    ...segment,
    style: `${dirtyBase}\n额外脏缓存`,
  };
  const synthC = resolveChunkSynthesizeFields(polluted);
  assert.equal(synthC.style, synth.style);
  const fpC = chunkLayoutFingerprint([{ text: polluted.text, segment: polluted }]);
  assert.equal(fpA, fpC);
});

test("resolveChunkSynthesizeFields design mode recompiles from clean baseDesign", () => {
  const dirtyDesign =
    "青年女性，标准普通话，音高中等，质感中性干净，气息平稳克制。\n\n表演指令：旧脏。\n\n保持该角色声线与身份一致，吐字清楚，不要模仿旁白腔，不要唱歌，不要串戏到其他角色。";
  const delivery = {
    primaryEmotion: "紧张",
    intensity: "mid",
    surfaceTone: "压低",
    intent: "试探",
    vocalEffort: "soft",
    rate: "measured",
    deliveryLine: "压低试探，语速沉稳。",
  };
  const synth = resolveChunkSynthesizeFields({
    index: 0,
    speakerKind: "character",
    characterId: "c2",
    speakerLabel: "林婉",
    text: "你从哪来？",
    ttsMode: "design",
    voice: "",
    baseDesignPrompt: dirtyDesign,
    designPrompt: dirtyDesign,
    delivery,
  });
  assert.equal((synth.designPrompt || "").includes("旧脏"), false);
  assert.match(synth.designPrompt || "", /青年女性/);
  assert.match(synth.designPrompt || "", /表演指令：/);
  const matches = (synth.designPrompt || "").match(/表演指令：/g) || [];
  assert.equal(matches.length, 1);
});

test("reconcile peels dirty card style and clears speakerUnresolved on match", () => {
  const dirtyCard =
    "卡面基线\n本句表演：不该出现在卡上。\n保持该角色声线与身份一致，吐字清楚。";
  const delivery = {
    primaryEmotion: "平静",
    intensity: "low",
    surfaceTone: "淡",
    intent: "陈述",
    vocalEffort: "normal",
    rate: "normal",
    deliveryLine: "淡淡陈述，语速中等。",
  };
  const result = reconcileAnnotationSegmentsWithVoices(
    [
      {
        index: 0,
        speakerKind: "character",
        characterId: "c1",
        speakerLabel: "旧名",
        text: "一句。",
        ttsMode: "preset",
        voice: "旧声",
        baseStyle: dirtyCard,
        style: dirtyCard,
        delivery,
        speakerUnresolved: true,
        unresolvedSpeakerName: "远哥",
      },
    ],
    {
      characterVoices: [
        {
          characterId: "c1",
          characterName: "何屿",
          ttsMode: "preset",
          ttsVoice: "白桦",
          ttsStyle: dirtyCard,
        },
      ],
      narrator: { voice: "茉莉", style: "旁白基线" },
      deliveryStyleMode: "characters",
    },
  );
  const seg = result.segments[0];
  assert.equal(seg.speakerUnresolved, false);
  assert.equal(seg.unresolvedSpeakerName, null);
  assert.equal(seg.voice, "白桦");
  assert.equal(seg.speakerLabel, "何屿");
  assert.equal((seg.baseStyle || "").includes("本句表演"), false);
  assert.equal(seg.baseStyle, "卡面基线");

  const synth = resolveChunkSynthesizeFields(seg);
  assert.equal((synth.style || "").includes("不该出现在卡上"), false);
  assert.match(synth.style || "", /卡面基线/);
  // 指纹应基于 synth，与脏卡面无关
  const fp = chunkLayoutFingerprint([{ text: seg.text, segment: seg }]);
  assert.equal(typeof fp, "string");
  assert.equal(fp.length, 16);
});
