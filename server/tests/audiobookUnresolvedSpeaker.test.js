const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeDeliveryChapterStats,
} = require("../dist/services/audiobook/deliveryStyle.js");
const {
  resolveChunkSynthesizeFields,
  peelCompiledDeliveryMarks,
} = require("../dist/services/audiobook/AudiobookPipelineService.js");

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

test("peelCompiledDeliveryMarks still strips marks", () => {
  assert.equal(
    peelCompiledDeliveryMarks("基线\n本句表演：x\n保持该角色声线与身份一致，吐字清楚。"),
    "基线",
  );
});
