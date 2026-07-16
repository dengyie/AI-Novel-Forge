const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeDeliveryChapterStats,
} = require("../dist/services/audiobook/deliveryStyle.js");
const {
  resolveChunkSynthesizeFields,
  peelCompiledDeliveryMarks,
} = require("../dist/services/audiobook/AudiobookPipelineService.js");
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
