const test = require("node:test");
const assert = require("node:assert/strict");

const {
  runRuleSpanPass,
} = require("../dist/services/audiobook/diarize/ruleSpanPass.js");
const {
  assembleSegmentsFromRules,
} = require("../dist/services/audiobook/diarize/ruleAssembly.js");
const {
  computeDiarizeChapterStats,
  collectTaskQualityFlags,
  buildQualityCompletionLabel,
  isWholeChapterNarratorFallback,
} = require("../dist/services/audiobook/diarize/diarizeQualityGate.js");
const {
  overlayChannelSkips,
} = require("../dist/services/audiobook/diarize/overlayChannelSkips.js");
const {
  expandSegmentsToChunkJobs,
} = require("../dist/services/audiobook/audiobookChunk.js");
const {
  sanitizeTtsChunkText,
} = require("../dist/services/audiobook/diarize/ttsTextSanitize.js");
const {
  buildNarratorOnlyAnnotation,
  tryBuildRuleAssemblyAnnotation,
} = require("../dist/services/audiobook/AudiobookAnnotationService.js");

const SAMPLE = `
夜色渐深。何屿说：「别回头。」
林致远问道：「你确定？」
他在手机上打字「收到」，然后锁屏。
微信弹出一条消息「在吗」。
旁白继续往下写。
`;

const ROSTER = [
  {
    characterId: "c-he",
    characterName: "何屿",
    ttsMode: "preset",
    ttsVoice: "白桦",
    ttsStyle: "中性",
  },
  {
    characterId: "c-lin",
    characterName: "林致远",
    ttsMode: "preset",
    ttsVoice: "苏打",
    ttsStyle: "明亮",
    speakerAliases: ["林哥"],
  },
];

const NARRATOR = { voice: "茉莉", style: "温和旁白" };

test("ruleSpanPass detects quotes and typed/chat channels", () => {
  const pass = runRuleSpanPass(SAMPLE);
  assert.ok(pass.quoteSpanCount >= 4);
  const kinds = new Set(pass.spans.map((s) => s.kind));
  assert.ok(kinds.has("quote") || kinds.has("phone"));
  assert.ok(kinds.has("typed"), "typed span expected");
  assert.ok(kinds.has("chat"), "chat span expected");
  const typed = pass.spans.find((s) => s.kind === "typed");
  assert.equal(typed.shouldSpeak, false);
  assert.match(typed.text, /收到/);
  const spoken = pass.spans.filter((s) => s.shouldSpeak);
  assert.ok(spoken.length >= 2);
  const he = spoken.find((s) => s.speakerHint && s.speakerHint.includes("何屿"));
  assert.ok(he, "speaker hint 何屿");
});

test("rule assembly skips typed/chat and assigns known speakers", () => {
  const { segments } = assembleSegmentsFromRules({
    content: SAMPLE,
    narrator: NARRATOR,
    characterVoices: ROSTER,
  });
  const typed = segments.filter((s) => s.segmentKind === "typed");
  const chat = segments.filter((s) => s.segmentKind === "chat");
  assert.ok(typed.length >= 1);
  assert.equal(typed[0].renderPolicy, "skip");
  assert.ok(chat.length >= 1);
  assert.equal(chat[0].renderPolicy, "skip");

  const he = segments.find((s) => s.characterId === "c-he");
  assert.ok(he, "何屿 character segment");
  assert.equal(he.segmentKind, "speech");
  assert.equal(he.renderPolicy, "tts");
  assert.match(he.text, /别回头/);

  const jobs = expandSegmentsToChunkJobs(segments);
  const joined = jobs.map((j) => j.text).join("\n");
  assert.equal(joined.includes("收到"), false, "typed must not enter TTS jobs");
  assert.equal(joined.includes("在吗"), false, "chat must not enter TTS jobs");
  assert.ok(joined.includes("别回头"));
});

test("overlayChannelSkips rewrites buried typed inside narrator segment", () => {
  const buried = [
    {
      index: 0,
      speakerKind: "narrator",
      speakerLabel: "旁白",
      text: "他在手机上打字「收到」，然后锁屏。",
      voice: "茉莉",
      segmentKind: "narration",
      renderPolicy: "tts",
    },
  ];
  const out = overlayChannelSkips("他在手机上打字「收到」，然后锁屏。", buried);
  assert.ok(out.some((s) => s.segmentKind === "typed" && s.renderPolicy === "skip"));
  const jobs = expandSegmentsToChunkJobs(out);
  assert.equal(jobs.some((j) => j.text.includes("收到")), false);
});

test("sanitizeTtsChunkText fixes trailing comma short lines", () => {
  assert.equal(sanitizeTtsChunkText("借个充电宝，"), "借个充电宝。");
  assert.equal(sanitizeTtsChunkText("，，，"), null);
  assert.equal(sanitizeTtsChunkText("  "), null);
  assert.ok(sanitizeTtsChunkText("好").endsWith("。"));
});

test("buildNarratorOnlyAnnotation marks wholeChapterNarratorFallback", () => {
  const ann = buildNarratorOnlyAnnotation({
    chapterId: "ch1",
    chapterOrder: 1,
    chapterTitle: "一",
    chapterContent: SAMPLE,
    narrator: NARRATOR,
    error: "标注失败已回退旁白：timeout",
  });
  assert.equal(ann.wholeChapterNarratorFallback, true);
  assert.equal(ann.diarizeStats.wholeChapterNarratorFallback, true);
  assert.equal(ann.diarizeStats.castOk, false);
  assert.equal(isWholeChapterNarratorFallback(ann), true);
});

test("tryBuildRuleAssemblyAnnotation beats narrator fallback when quotes exist", () => {
  const ann = tryBuildRuleAssemblyAnnotation({
    chapterId: "ch1",
    chapterOrder: 1,
    chapterTitle: "一",
    chapterContent: SAMPLE,
    narrator: NARRATOR,
    characterVoices: ROSTER,
    errorNote: "timeout",
  });
  assert.ok(ann);
  assert.equal(ann.wholeChapterNarratorFallback, false);
  assert.equal(ann.diarizeStats.assemblySource, "rules");
  assert.ok(ann.diarizeStats.typedSkippedCount >= 1);
  const jobs = expandSegmentsToChunkJobs(ann.segments);
  assert.equal(jobs.some((j) => /收到/.test(j.text)), false);
});

test("computeDiarizeChapterStats castOk fails on narrator-only with many quotes", () => {
  const ann = buildNarratorOnlyAnnotation({
    chapterId: "ch1",
    chapterOrder: 1,
    chapterTitle: "一",
    chapterContent: SAMPLE,
    narrator: NARRATOR,
    error: "x",
  });
  assert.equal(ann.diarizeStats.castOk, false);
  assert.ok(ann.diarizeStats.spokenQuoteSpanCount >= 2);
  assert.ok(ann.diarizeStats.spokenQuoteCoverage < 0.85);
});

test("quality flags and completion label mark degraded", () => {
  const bad = buildNarratorOnlyAnnotation({
    chapterId: "ch1",
    chapterOrder: 1,
    chapterTitle: "一",
    chapterContent: SAMPLE,
    narrator: NARRATOR,
    error: "fallback",
  });
  const flags = collectTaskQualityFlags([bad]);
  assert.ok(flags.includes("narrator_fallback"));
  assert.ok(flags.includes("cast_degraded"));
  const label = buildQualityCompletionLabel({
    qualityFlags: flags,
    narratorFallbackCount: 1,
    m4bReady: true,
  });
  assert.match(label, /降级/);
  assert.match(label, /旁白回退/);
});

test("rule assembly diarizeStats prefer higher coverage than whole narrator", () => {
  const rules = tryBuildRuleAssemblyAnnotation({
    chapterId: "ch1",
    chapterOrder: 1,
    chapterTitle: "一",
    chapterContent: SAMPLE,
    narrator: NARRATOR,
    characterVoices: ROSTER,
  });
  const narr = buildNarratorOnlyAnnotation({
    chapterId: "ch1",
    chapterOrder: 1,
    chapterTitle: "一",
    chapterContent: SAMPLE,
    narrator: NARRATOR,
    error: "x",
  });
  assert.ok(rules.diarizeStats.spokenQuoteCoverage > narr.diarizeStats.spokenQuoteCoverage);
});
