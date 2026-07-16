const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeDeliveryChapterStats,
} = require("../dist/services/audiobook/deliveryStyle.js");

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
