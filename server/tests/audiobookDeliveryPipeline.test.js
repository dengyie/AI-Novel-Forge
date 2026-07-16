const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyDeliveryToSegment,
  deliveryMergeKey,
  normalizeDelivery,
  resolveSynthesizeInput,
} = require("../dist/services/audiobook/deliveryStyle.js");
const {
  coalesceSegmentsBySpeaker,
  expandSegmentsToChunkJobs,
} = require("../dist/services/audiobook/audiobookChunk.js");
const { chunkLayoutFingerprint } = require("../dist/services/audiobook/AudiobookPipelineService.js");
const {
  buildCharacterRosterLine,
  buildNarratorOnlyAnnotation,
} = require("../dist/services/audiobook/AudiobookAnnotationService.js");

const GOOD = {
  primaryEmotion: "压抑愤怒",
  intensity: "mid",
  surfaceTone: "平静公事",
  intent: "逼对方把责任说清楚",
  vocalEffort: "soft",
  rate: "measured",
  maskOrLeak: "强装镇定",
  deliveryLine:
    "平静公事地压着怒，强装镇定却牙关发紧；对上级逼问责任；压低音量、语速沉稳。",
};

const TENDER = {
  primaryEmotion: "温柔关切",
  intensity: "low",
  surfaceTone: "轻声安抚",
  intent: "让对方把心放下",
  vocalEffort: "soft",
  rate: "slow",
  deliveryLine:
    "轻声安抚地藏着关切，语速放慢、压低音量；对亲近之人低声劝稳。",
};

test("roster line includes voice/style/personality summary", () => {
  const line = buildCharacterRosterLine({
    characterId: "c1",
    characterName: "何屿",
    speakerAliases: ["小何"],
    voiceTexture: "内敛偏低、吐字清",
    ttsStyle: "克制",
    personality: "敏感要强",
  });
  assert.match(line, /何屿/);
  assert.match(line, /别名:小何/);
  assert.match(line, /声线:内敛偏低/);
  assert.match(line, /风格:克制/);
  assert.match(line, /性格:敏感要强/);
});

test("roster falls back to 未设定 when voice fields missing", () => {
  const line = buildCharacterRosterLine({
    characterId: "c2",
    characterName: "林远",
  });
  assert.match(line, /声线:未设定/);
  assert.match(line, /风格:未设定/);
  assert.match(line, /性格:未设定/);
});

test("bad delivery peels performance but keeps multi-character speakers", () => {
  // 模拟标注后映射：两角色 + 一条坏 delivery 的角色段
  const baseA = {
    index: 0,
    speakerKind: "character",
    characterId: "c1",
    speakerLabel: "何屿",
    text: "你把责任说清楚。",
    ttsMode: "preset",
    voice: "白桦",
    style: "基线A",
  };
  const baseB = {
    index: 1,
    speakerKind: "character",
    characterId: "c2",
    speakerLabel: "林远",
    text: "别急。",
    ttsMode: "preset",
    voice: "苏打",
    style: "基线B",
  };
  const segA = applyDeliveryToSegment(baseA, { intensity: "high" }, {
    deliveryStyleMode: "characters",
    baseStyle: "基线A",
  });
  const segB = applyDeliveryToSegment(baseB, GOOD, {
    deliveryStyleMode: "characters",
    baseStyle: "基线B",
  });
  assert.equal(segA.speakerKind, "character");
  assert.equal(segA.characterId, "c1");
  assert.equal(segA.delivery, null);
  assert.equal(segA.style, "基线A");
  assert.equal(segB.delivery != null, true);
  assert.equal(segB.style.includes("本句表演"), true);
  // 不得变成整章旁白
  assert.equal(segA.speakerKind === "narrator" && segB.speakerKind === "narrator", false);
});

test("design resolve puts performance into designPrompt user channel", () => {
  const seg = applyDeliveryToSegment(
    {
      index: 0,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "何屿",
      text: "你把责任说清楚。",
      ttsMode: "design",
      voice: "",
      style: null,
      designPrompt: "青年男性，声线偏低。",
    },
    GOOD,
    {
      deliveryStyleMode: "characters",
      baseStyle: null,
      baseDesignPrompt: "青年男性，声线偏低。",
    },
  );
  assert.ok(seg.designPrompt);
  assert.match(seg.designPrompt, /青年男性/);
  assert.match(seg.designPrompt, /表演指令：/);
  const resolved = resolveSynthesizeInput(seg);
  assert.match(resolved.designPrompt || "", /表演指令：/);
});

test("fingerprint changes when style/designPrompt change", () => {
  const jobsA = [
    {
      text: "你把责任说清楚。",
      segment: {
        index: 0,
        speakerKind: "character",
        characterId: "c1",
        speakerLabel: "何屿",
        text: "你把责任说清楚。",
        ttsMode: "preset",
        voice: "白桦",
        style: "基线",
      },
    },
  ];
  const jobsB = [
    {
      text: "你把责任说清楚。",
      segment: {
        ...jobsA[0].segment,
        style: "基线\n本句表演：平静公事地压着怒。",
      },
    },
  ];
  const fpA = chunkLayoutFingerprint(jobsA);
  const fpB = chunkLayoutFingerprint(jobsB);
  assert.equal(typeof fpA, "string");
  assert.equal(fpA.length, 16);
  assert.notEqual(fpA, fpB);
});

test("fingerprint stable when only unrelated fields change", () => {
  const base = {
    text: "别回头。",
    segment: {
      index: 0,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "何屿",
      text: "别回头。",
      ttsMode: "preset",
      voice: "白桦",
      style: "基线\n本句表演：x",
      designPrompt: null,
      delivery: normalizeDelivery(GOOD),
    },
  };
  const fp1 = chunkLayoutFingerprint([base]);
  const fp2 = chunkLayoutFingerprint([
    {
      ...base,
      segment: {
        ...base.segment,
        delivery: normalizeDelivery(TENDER), // delivery 对象本身不进指纹；style 未变
      },
    },
  ]);
  assert.equal(fp1, fp2);
});

test("expand chunk jobs respect mergeKey buckets", () => {
  const angerKey = deliveryMergeKey(normalizeDelivery(GOOD));
  const tenderKey = deliveryMergeKey(normalizeDelivery(TENDER));
  assert.notEqual(angerKey, tenderKey);

  const segments = [
    applyDeliveryToSegment(
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
      GOOD,
      { deliveryStyleMode: "characters", baseStyle: "基线" },
    ),
    applyDeliveryToSegment(
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
      GOOD,
      { deliveryStyleMode: "characters", baseStyle: "基线" },
    ),
    applyDeliveryToSegment(
      {
        index: 2,
        speakerKind: "character",
        characterId: "c1",
        speakerLabel: "何屿",
        text: "先歇一会儿。",
        ttsMode: "preset",
        voice: "白桦",
        style: "基线",
      },
      TENDER,
      { deliveryStyleMode: "characters", baseStyle: "基线" },
    ),
  ];
  const coalesced = coalesceSegmentsBySpeaker(segments);
  assert.equal(coalesced.length, 2);
  assert.equal(coalesced[0].text.includes("别再甩锅"), true);
  assert.equal(coalesced[1].text.includes("先歇"), true);

  const jobs = expandSegmentsToChunkJobs(segments);
  assert.ok(jobs.length >= 2);
  const fp = chunkLayoutFingerprint(jobs);
  assert.equal(fp.length, 16);
});

test("buildNarratorOnlyAnnotation is only for total annotate failure path", () => {
  const ann = buildNarratorOnlyAnnotation({
    chapterId: "ch1",
    chapterOrder: 1,
    chapterTitle: "夜谈",
    chapterContent: "甲说：「走。」乙说：「好。」",
    narrator: { voice: "茉莉", style: "知性旁白" },
    error: "structured failed",
  });
  assert.equal(ann.segments.length, 1);
  assert.equal(ann.segments[0].speakerKind, "narrator");
  assert.equal(ann.segments[0].deliveryMergeKey, "none");
  assert.match(ann.error || "", /structured failed/);
});

test("mode=off path style has no 本句表演", () => {
  const seg = applyDeliveryToSegment(
    {
      index: 0,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "何屿",
      text: "你把责任说清楚。",
      ttsMode: "preset",
      voice: "白桦",
      style: "角色基线 style",
    },
    GOOD,
    { deliveryStyleMode: "off", baseStyle: "角色基线 style" },
  );
  assert.equal(seg.delivery, null);
  assert.equal(seg.style, "角色基线 style");
  assert.equal((seg.style || "").includes("本句表演"), false);
});
