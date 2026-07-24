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

// SoT 校准（2ced268「close SoT fingerprint gap」之后口径变更，与 authoritative
// audiobookSynthSotFingerprint.test.js 对齐）：
//  - chunkLayoutFingerprint 走 resolveChunkSynthesizeFields：编译标记 `本句表演：` 在无 delivery
//    时被 peel，因此往 style 追加 compiled marker 不改变语义 → 指纹不变。
//  - 真正改变语义基线文本（survives peel）才改变指纹。
// 旧版本断言「compiled marker 改变指纹」与 SoT 冲突，已在本轮校正。
test("fingerprint changes when semantic base style changes (compiled marker without delivery is peeled)", () => {
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
  // 往相同基线追加 compiled `本句表演：` 标记：无 delivery → 被 peel → 语义未变 → 指纹不变
  const jobsMarkerOnly = [
    {
      text: "你把责任说清楚。",
      segment: {
        ...jobsA[0].segment,
        style: "基线\n本句表演：平静公事地压着怒。",
      },
    },
  ];
  // 改变基线正文（survives peel）→ 语义变化 → 指纹变化
  const jobsDifferentBase = [
    {
      text: "你把责任说清楚。",
      segment: {
        ...jobsA[0].segment,
        style: "另一条完全不同的声线基线",
      },
    },
  ];
  const fpA = chunkLayoutFingerprint(jobsA);
  const fpMarker = chunkLayoutFingerprint(jobsMarkerOnly);
  const fpDiffBase = chunkLayoutFingerprint(jobsDifferentBase);
  assert.equal(typeof fpA, "string");
  assert.equal(fpA.length, 16);
  // compiled marker 无 delivery 被 peel → 语义不变 → 指纹稳定
  assert.equal(fpA, fpMarker);
  // 语义基线正文改变 → 指纹改变
  assert.notEqual(fpA, fpDiffBase);
});

// SoT 校准（同上）：delivery 在 resolveChunkSynthesizeFields 内会经 applyDeliveryToSegment /
// resolveSynthesizeInput 重新编译进 style 的 `本句表演：` 行，因此 delivery 内容 DOES 进指纹
// （2ced268「fingerprint/reconcile/synth SoT align」明确把不同 delivery 视为会改变合成结果，
// 需 invalidate 缓存）。
// 故「unrelated 字段」需选用真正不进指纹的字段。speakerLabel / index 不进 hash，改它们应稳定。
test("fingerprint stable when only unrelated fields change (delivery now DOES enter fingerprint)", () => {
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
  // 换真正不进指纹的字段：speakerLabel + index 不在 chunkLayoutFingerprint hash 输入中
  const fp1 = chunkLayoutFingerprint([base]);
  const fp2 = chunkLayoutFingerprint([
    {
      ...base,
      segment: {
        ...base.segment,
        speakerLabel: "小何",
        index: 99,
      },
    },
  ]);
  assert.equal(fp1, fp2);

  // 防回归旁证：delivery 内容变化会通过重编 `本句表演：` 行进指纹 → 不同（SoT 明确语义）
  const fpGood = chunkLayoutFingerprint([
    {
      ...base,
      segment: { ...base.segment, style: "基线", delivery: normalizeDelivery(GOOD) },
    },
  ]);
  const fpTender = chunkLayoutFingerprint([
    {
      ...base,
      segment: { ...base.segment, style: "基线", delivery: normalizeDelivery(TENDER) },
    },
  ]);
  assert.notEqual(fpGood, fpTender);
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


const { compileDeliveryStyleForSegment } = require(
  "../dist/services/audiobook/frontend/synthesisBuilder.js",
);
// M9: resolveChunkSynthesizeFields（薄别名）已删，SoT 现为 compileDeliveryStyleForSegment。
const resolveChunkSynthesizeFields = compileDeliveryStyleForSegment;

test("resolveChunkSynthesizeFields keeps narrator 本句叙述 SoT", () => {
  const narratorSeg = applyDeliveryToSegment(
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
    GOOD,
    { deliveryStyleMode: "all", baseStyle: "知性旁白" },
  );
  assert.match(narratorSeg.style || "", /本句叙述：/);
  assert.equal((narratorSeg.style || "").includes("本句表演"), false);

  const synth = resolveChunkSynthesizeFields(narratorSeg);
  assert.equal(synth.style, narratorSeg.style);
  assert.match(synth.style || "", /本句叙述：/);
  assert.equal((synth.style || "").includes("本句表演"), false);
});

test("resolveChunkSynthesizeFields rebuilds narrator without resolved style", () => {
  const delivery = normalizeDelivery(GOOD);
  const bare = {
    index: 0,
    speakerKind: "narrator",
    characterId: null,
    speakerLabel: "旁白",
    text: "夜色渐深。",
    ttsMode: "preset",
    voice: "茉莉",
    style: "知性旁白",
    baseStyle: "知性旁白",
    delivery,
    deliveryMergeKey: deliveryMergeKey(delivery),
  };
  const synth = resolveChunkSynthesizeFields(bare);
  assert.match(synth.style || "", /本句叙述：/);
  assert.equal((synth.style || "").includes("本句表演"), false);
});

test("resolveChunkSynthesizeFields rebuilds dirty narrator 本句表演 on resynthesize", () => {
  const delivery = normalizeDelivery(GOOD);
  const dirty = {
    index: 0,
    speakerKind: "narrator",
    characterId: null,
    speakerLabel: "旁白",
    text: "夜色渐深，长街只剩脚步声。",
    ttsMode: "preset",
    voice: "茉莉",
    style: "知性旁白\n本句表演：平静公事地压着怒，强装镇定。",
    baseStyle: "知性旁白",
    delivery,
    deliveryMergeKey: deliveryMergeKey(delivery),
  };
  const synth = resolveChunkSynthesizeFields(dirty);
  assert.match(synth.style || "", /本句叙述：/);
  assert.equal((synth.style || "").includes("本句表演"), false);
});

test("resolveChunkSynthesizeFields peels dirty narrator without delivery", () => {
  const dirty = {
    index: 0,
    speakerKind: "narrator",
    characterId: null,
    speakerLabel: "旁白",
    text: "天色将明。",
    ttsMode: "preset",
    voice: "茉莉",
    style: "知性旁白\n本句表演：嘶吼崩溃。",
    baseStyle: "知性旁白",
    delivery: null,
  };
  const synth = resolveChunkSynthesizeFields(dirty);
  assert.equal(synth.style, "知性旁白");
  assert.equal((synth.style || "").includes("本句表演"), false);
});

test("fingerprint changes when refAudioPath changes", () => {
  const baseSeg = {
    index: 0,
    speakerKind: "character",
    characterId: "c1",
    speakerLabel: "何屿",
    text: "你听我说。",
    ttsMode: "clone",
    voice: "",
    style: "基线",
    refAudioPath: "/data/storage/voice-refs/n1/c1/ref.wav",
  };
  const fpA = chunkLayoutFingerprint([{ text: baseSeg.text, segment: baseSeg }]);
  const fpB = chunkLayoutFingerprint([{
    text: baseSeg.text,
    segment: { ...baseSeg, refAudioPath: "/data/storage/voice-refs/n1/c1/ref2.wav" },
  }]);
  assert.notEqual(fpA, fpB);
});

test("fingerprint changes when mid-text changes (same prefix+length)", () => {
  // 前 64 字相同但中部不同时旧实现会撞指纹；现用全文 hash
  const prefix = "甲".repeat(64);
  const textA = `${prefix}${"乙".repeat(20)}`;
  const textB = `${prefix}${"丙".repeat(20)}`;
  assert.equal(textA.length, textB.length);
  assert.equal(textA.slice(0, 64), textB.slice(0, 64));
  const seg = {
    index: 0,
    speakerKind: "narrator",
    characterId: null,
    speakerLabel: "旁白",
    text: textA,
    ttsMode: "preset",
    voice: "茉莉",
    style: "旁白",
  };
  const fpA = chunkLayoutFingerprint([{ text: textA, segment: { ...seg, text: textA } }]);
  const fpB = chunkLayoutFingerprint([{ text: textB, segment: { ...seg, text: textB } }]);
  assert.notEqual(fpA, fpB);
});

test("asymmetric mergeKey falls back to style equality (no false merge)", () => {
  const key = deliveryMergeKey(normalizeDelivery(GOOD));
  const a = {
    index: 0,
    speakerKind: "character",
    characterId: "c1",
    speakerLabel: "何屿",
    text: "第一句。",
    ttsMode: "preset",
    voice: "白桦",
    style: "风格A",
    deliveryMergeKey: key,
  };
  const b = {
    index: 1,
    speakerKind: "character",
    characterId: "c1",
    speakerLabel: "何屿",
    text: "第二句。",
    ttsMode: "preset",
    voice: "白桦",
    style: "风格B",
    // 缺 mergeKey：不得用 none 与 a 误合并
  };
  const coalesced = coalesceSegmentsBySpeaker([a, b]);
  assert.equal(coalesced.length, 2);
});

const {
  shouldInvalidateCachedAnnotation,
} = require("../dist/services/audiobook/AudiobookPipelineService.js");
const {
  hashAudiobookChapterContent,
} = require("../dist/services/audiobook/AudiobookAnnotationService.js");

test("hashAudiobookChapterContent normalizes CRLF and is stable", () => {
  const a = hashAudiobookChapterContent("甲\r\n乙\n");
  const b = hashAudiobookChapterContent("甲\n乙");
  assert.equal(a, b);
  assert.equal(a.length, 16);
  assert.notEqual(hashAudiobookChapterContent("甲\n乙"), hashAudiobookChapterContent("甲\n丙"));
});

test("buildNarratorOnlyAnnotation stamps contentSha1", () => {
  const body = "甲说：「走。」";
  const ann = buildNarratorOnlyAnnotation({
    chapterId: "ch1",
    chapterOrder: 1,
    chapterTitle: "夜",
    chapterContent: body,
    narrator: { voice: "茉莉", style: "旁白" },
  });
  assert.equal(ann.contentSha1, hashAudiobookChapterContent(body));
  assert.equal(ann.deliveryStyleMode, "off");
});

test("shouldInvalidateCachedAnnotation on content drift", () => {
  const body = "原文第一版。";
  const sha = hashAudiobookChapterContent(body);
  const ann = {
    chapterId: "ch1",
    chapterOrder: 1,
    chapterTitle: "夜",
    deliveryStyleMode: "off",
    contentSha1: sha,
    segments: [{
      index: 0,
      speakerKind: "narrator",
      speakerLabel: "旁白",
      text: body,
      voice: "茉莉",
    }],
  };
  assert.equal(shouldInvalidateCachedAnnotation({
    annotation: ann,
    deliveryStyleMode: "off",
    chapterContent: body,
  }), false);
  assert.equal(shouldInvalidateCachedAnnotation({
    annotation: ann,
    deliveryStyleMode: "off",
    chapterContent: "改稿后第二版。",
  }), true);
});

test("shouldInvalidateCachedAnnotation when contentSha1 missing", () => {
  const ann = {
    chapterId: "ch1",
    chapterOrder: 1,
    chapterTitle: "夜",
    deliveryStyleMode: "off",
    segments: [{
      index: 0,
      speakerKind: "narrator",
      speakerLabel: "旁白",
      text: "旧缓存无 hash。",
      voice: "茉莉",
    }],
  };
  assert.equal(shouldInvalidateCachedAnnotation({
    annotation: ann,
    deliveryStyleMode: "off",
    chapterContent: "旧缓存无 hash。",
  }), true);
});

test("shouldInvalidateCachedAnnotation on mode mismatch", () => {
  const body = "对白。";
  const ann = {
    chapterId: "ch1",
    chapterOrder: 1,
    chapterTitle: "夜",
    deliveryStyleMode: "characters",
    contentSha1: hashAudiobookChapterContent(body),
    segments: [{
      index: 0,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "何屿",
      text: body,
      voice: "白桦",
    }],
  };
  assert.equal(shouldInvalidateCachedAnnotation({
    annotation: ann,
    deliveryStyleMode: "off",
    chapterContent: body,
  }), true);
});

test("shouldInvalidateCachedAnnotation null mode + off + dirty delivery", () => {
  const body = "你听我说。";
  const ann = {
    chapterId: "ch1",
    chapterOrder: 1,
    chapterTitle: "夜",
    // 无 deliveryStyleMode 戳
    contentSha1: hashAudiobookChapterContent(body),
    segments: [{
      index: 0,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "何屿",
      text: body,
      voice: "白桦",
      delivery: normalizeDelivery(GOOD),
    }],
  };
  assert.equal(shouldInvalidateCachedAnnotation({
    annotation: ann,
    deliveryStyleMode: "off",
    chapterContent: body,
  }), true);
  // characters 模式允许保留 delivery（仅 mode 戳缺失不单独失效，只要 sha 对）
  assert.equal(shouldInvalidateCachedAnnotation({
    annotation: ann,
    deliveryStyleMode: "characters",
    chapterContent: body,
  }), false);
});

const {
  reconcileAnnotationSegmentsWithVoices,
} = require("../dist/services/audiobook/AudiobookPipelineService.js");

test("reconcileAnnotationSegmentsWithVoices overlays current character binding", () => {
  const delivery = normalizeDelivery(GOOD);
  const segments = [{
    index: 0,
    speakerKind: "character",
    characterId: "c1",
    speakerLabel: "何屿",
    text: "你把责任说清楚。",
    ttsMode: "preset",
    voice: "白桦",
    style: "旧基线\n本句表演：旧句。",
    baseStyle: "旧基线",
    delivery,
    deliveryMergeKey: deliveryMergeKey(delivery),
  }];
  const reconciled = reconcileAnnotationSegmentsWithVoices(segments, {
    characterVoices: [{
      characterId: "c1",
      characterName: "何屿",
      ttsMode: "preset",
      ttsVoice: "苏打",
      ttsStyle: "新基线",
    }],
    narrator: { voice: "茉莉", style: "旁白" },
    deliveryStyleMode: "characters",
  });
  assert.equal(reconciled.segments.length, 1);
  assert.equal(reconciled.orphanCharacterIds.length, 0);
  assert.equal(reconciled.segments[0].voice, "苏打");
  assert.equal(reconciled.segments[0].baseStyle, "新基线");
  assert.match(reconciled.segments[0].style || "", /本句表演：/);
  assert.equal((reconciled.segments[0].style || "").includes("旧基线"), false);
  assert.equal(reconciled.segments[0].text, "你把责任说清楚。");
  assert.ok(reconciled.segments[0].delivery);
});

test("resolveChunkSynthesizeFields rebuilds character delivery from baseStyle", () => {
  const delivery = normalizeDelivery(GOOD);
  const dirty = {
    index: 0,
    speakerKind: "character",
    characterId: "c1",
    speakerLabel: "何屿",
    text: "你把责任说清楚。",
    ttsMode: "preset",
    voice: "苏打",
    style: "旧基线\n本句表演：过时句。",
    baseStyle: "新基线",
    delivery,
  };
  const synth = resolveChunkSynthesizeFields(dirty);
  assert.match(synth.style || "", /本句表演：/);
  assert.match(synth.style || "", /新基线/);
  assert.equal((synth.style || "").includes("旧基线"), false);
  assert.equal((synth.style || "").includes("过时句"), false);
});

test("reconcile then expand is the estimate source of truth for chunk count", () => {
  // 两段同角色、同 delivery → coalesce 后可能合并；estimate 必须走 reconcile 后 expand
  const delivery = normalizeDelivery(GOOD);
  const segments = [
    {
      index: 0,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "何屿",
      text: "你把责任说清楚。",
      ttsMode: "preset",
      voice: "白桦",
      style: "旧",
      baseStyle: "旧",
      delivery,
      deliveryMergeKey: deliveryMergeKey(delivery),
    },
    {
      index: 1,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "何屿",
      text: "别再甩锅。",
      ttsMode: "preset",
      voice: "白桦",
      style: "旧",
      baseStyle: "旧",
      delivery,
      deliveryMergeKey: deliveryMergeKey(delivery),
    },
  ];
  const reconciled = reconcileAnnotationSegmentsWithVoices(segments, {
    characterVoices: [{
      characterId: "c1",
      characterName: "何屿",
      ttsMode: "preset",
      ttsVoice: "苏打",
      ttsStyle: "新基线",
    }],
    narrator: { voice: "茉莉", style: "旁白" },
    deliveryStyleMode: "characters",
  });
  const rawJobs = expandSegmentsToChunkJobs(segments);
  const reconciledJobs = expandSegmentsToChunkJobs(reconciled.segments);
  // 合成侧用 reconciled；标注侧 estimate 必须对齐
  assert.equal(reconciledJobs.length, expandSegmentsToChunkJobs(reconciled.segments).length);
  assert.ok(reconciledJobs.length >= 1);
  // 指纹依赖 voice/style，reconcile 后应与 raw 不同（换声线）
  assert.notEqual(
    chunkLayoutFingerprint(rawJobs),
    chunkLayoutFingerprint(reconciledJobs),
  );
});

const {
  peelCompiledDeliveryMarks,
} = require("../dist/services/audiobook/AudiobookPipelineService.js");

test("peelCompiledDeliveryMarks strips performance lines", () => {
  assert.equal(peelCompiledDeliveryMarks("新基线"), "新基线");
  assert.equal(
    peelCompiledDeliveryMarks("新基线\n本句表演：平静公事地压着怒。\n保持该角色声线与身份一致，吐字清楚。"),
    "新基线",
  );
  assert.equal(peelCompiledDeliveryMarks("本句表演：只有表演"), null);
});

test("reconcile orphan character forces narrator fallback", () => {
  const delivery = normalizeDelivery(GOOD);
  const segments = [{
    index: 0,
    speakerKind: "character",
    characterId: "deleted-c9",
    speakerLabel: "已删角色",
    text: "你还在吗。",
    ttsMode: "clone",
    voice: "",
    style: "旧\n本句表演：x",
    baseStyle: "旧",
    refAudioPath: "/data/storage/voice-refs/n1/deleted/ref.wav",
    delivery,
    deliveryMergeKey: deliveryMergeKey(delivery),
  }];
  const reconciled = reconcileAnnotationSegmentsWithVoices(segments, {
    characterVoices: [], // 当前卡无此角色
    narrator: { voice: "茉莉", style: "知性旁白" },
    deliveryStyleMode: "characters",
  });
  assert.equal(reconciled.orphanCharacterIds.includes("deleted-c9"), true);
  assert.equal(reconciled.segments.length, 1);
  assert.equal(reconciled.segments[0].speakerKind, "narrator");
  assert.equal(reconciled.segments[0].characterId, null);
  assert.equal(reconciled.segments[0].voice, "茉莉");
  assert.equal(reconciled.segments[0].refAudioPath, null);
  assert.equal(reconciled.segments[0].delivery, null);
  assert.equal((reconciled.segments[0].style || "").includes("本句表演"), false);
});

test("resolveChunkSynthesizeFields peels dirty character style without baseStyle", () => {
  const delivery = normalizeDelivery(GOOD);
  const dirty = {
    index: 0,
    speakerKind: "character",
    characterId: "c1",
    speakerLabel: "何屿",
    text: "你把责任说清楚。",
    ttsMode: "preset",
    voice: "苏打",
    // 历史脏缓存：style 已含表演，且缺 baseStyle
    style: "角色基线\n本句表演：过时旧句。\n保持该角色声线与身份一致，吐字清楚。",
    baseStyle: null,
    delivery,
  };
  const synth = resolveChunkSynthesizeFields(dirty);
  assert.match(synth.style || "", /本句表演：/);
  assert.match(synth.style || "", /角色基线/);
  // 不得叠两层「本句表演」
  const matches = (synth.style || "").match(/本句表演：/g) || [];
  assert.equal(matches.length, 1);
  assert.equal((synth.style || "").includes("过时旧句"), false);
});

test("resolveChunkSynthesizeFields peels dirty character without delivery", () => {
  const dirty = {
    index: 0,
    speakerKind: "character",
    characterId: "c1",
    speakerLabel: "何屿",
    text: "先歇。",
    ttsMode: "preset",
    voice: "苏打",
    style: "基线\n本句表演：嘶吼崩溃。",
    baseStyle: "基线",
    delivery: null,
  };
  const synth = resolveChunkSynthesizeFields(dirty);
  assert.equal(synth.style, "基线");
  assert.equal((synth.style || "").includes("本句表演"), false);
});
