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
  materializeAnnotationSegments,
} = require("../dist/services/audiobook/AudiobookAnnotationService.js");
const {
  pickGuestPresetVoice,
  guestPresetPoolForTest,
} = require("../dist/services/audiobook/diarize/guestVoice.js");
const {
  repairFalseChannelSkips,
  fillUncoveredSpokenQuotes,
} = require("../dist/services/audiobook/diarize/channelRepair.js");

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
  assert.equal(ann.assemblySource, "narrator_fallback");
  assert.equal(ann.diarizeStats.assemblySource, "narrator_fallback");
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
  assert.equal(ann.assemblySource, "rules", "top-level assemblySource required");
  assert.ok(ann.diarizeStats.typedSkippedCount >= 1);
  // 规则成功诊断进 assemblyNote，不得写 error、不得被当成旁白回退
  assert.equal(ann.error, null);
  assert.match(ann.assemblyNote || "", /规则装配/);
  assert.equal(isWholeChapterNarratorFallback(ann), false);
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

test("rules assembly with errorNote is cast degraded not narrator_fallback", () => {
  const rules = tryBuildRuleAssemblyAnnotation({
    chapterId: "ch1",
    chapterOrder: 1,
    chapterTitle: "一",
    chapterContent: SAMPLE,
    narrator: NARRATOR,
    characterVoices: ROSTER,
    errorNote: "ops: rule-path verify inject",
  });
  assert.ok(rules);
  assert.equal(rules.wholeChapterNarratorFallback, false);
  assert.equal(isWholeChapterNarratorFallback(rules), false);
  assert.equal(rules.error, null);
  assert.ok(rules.assemblyNote);

  const flags = collectTaskQualityFlags([rules]);
  assert.equal(flags.includes("narrator_fallback"), false);
  // L1 常有 unresolved → cast_degraded / high_unresolved，但绝不是旁白回退
  assert.ok(flags.includes("cast_degraded") || flags.includes("cast_ok") || flags.includes("high_unresolved"));
  const label = buildQualityCompletionLabel({
    qualityFlags: flags,
    narratorFallbackCount: 0,
    m4bReady: true,
  });
  assert.equal(/旁白回退/.test(label), false);
  if (flags.includes("high_unresolved")) {
    assert.match(label, /未匹配角色/);
  }
});

test("unresolved_ratio uses same domain for num and den", () => {
  // 未匹配角色强制旁白声 + speakerUnresolved → 应计入分母
  const segments = [
    {
      index: 0,
      speakerKind: "narrator",
      speakerLabel: "路人甲",
      text: "别回头。",
      segmentKind: "speech",
      renderPolicy: "tts",
      speakerUnresolved: true,
      unresolvedSpeakerName: "路人甲",
      voice: "茉莉",
    },
    {
      index: 1,
      speakerKind: "character",
      characterId: "c-he",
      speakerLabel: "何屿",
      text: "你确定？",
      segmentKind: "speech",
      renderPolicy: "tts",
      speakerUnresolved: false,
      voice: "白桦",
    },
  ];
  const stats = computeDiarizeChapterStats({
    content: "何屿说：「别回头。」又说：「你确定？」",
    segments,
    wholeChapterNarratorFallback: false,
    assemblySource: "llm",
  });
  assert.equal(stats.speechCharacterCount, 2);
  assert.equal(stats.unresolvedSpeakerCount, 1);
  assert.ok(stats.unresolvedSpeakerCount / stats.speechCharacterCount <= 0.5 + 1e-9);
});

test("overlayChannelSkips handles multiple skip spans in one segment", () => {
  const content = "他打字「截图发你了」，又弹出消息「对方正在输入」。";
  const buried = [
    {
      index: 0,
      speakerKind: "narrator",
      speakerLabel: "旁白",
      text: content,
      voice: "茉莉",
      segmentKind: "narration",
      renderPolicy: "tts",
    },
  ];
  const out = overlayChannelSkips(content, buried);
  const skips = out.filter((s) => s.renderPolicy === "skip");
  assert.ok(skips.length >= 2, `expected >=2 skip segs, got ${skips.length}`);
  const skipText = skips.map((s) => s.text).join("\n");
  assert.match(skipText, /截图发你了/);
  assert.match(skipText, /对方正在输入/);
  const jobs = expandSegmentsToChunkJobs(out);
  const joined = jobs.map((j) => j.text).join("\n");
  assert.equal(joined.includes("截图发你了"), false);
  assert.equal(joined.includes("对方正在输入"), false);
});

test("splitChapterContentForLlm chunks long chapters without full-text single window", () => {
  const {
    splitChapterContentForLlm,
    AUDIOBOOK_LLM_CONTENT_WINDOW,
  } = require("../dist/services/audiobook/AudiobookAnnotationService.js");
  const short = "短章".repeat(10);
  assert.deepEqual(splitChapterContentForLlm(short), [short.replace(/\r\n/g, "\n")]);

  const para = `${"叙述句。".repeat(20)}\n何屿说：「别回头。」\n`;
  const long = para.repeat(Math.ceil((AUDIOBOOK_LLM_CONTENT_WINDOW + 5000) / para.length));
  const chunks = splitChapterContentForLlm(long, 2000, 100);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    assert.ok(c.length <= 2000 + 50, `chunk too long: ${c.length}`);
  }
  // 拼接覆盖主线（允许 overlap 重复，但不应丢尾）
  const joined = chunks.join("");
  assert.ok(joined.includes("别回头"));
  assert.ok(joined.length >= long.length * 0.9);
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

test("allChunkPartsPresent rejects partial success holes", () => {
  const {
    allChunkPartsPresent,
    mergeChunkedSegments,
    fillFailedChunksWithRules,
    buildMultiChunkAssemblyNote,
    normalizeAnnotationDiagnostics,
  } = require("../dist/services/audiobook/AudiobookAnnotationService.js");

  const seg = (text) => ({
    index: 0,
    speakerKind: "narrator",
    speakerLabel: "旁白",
    text,
    voice: "茉莉",
    segmentKind: "narration",
    renderPolicy: "tts",
  });

  assert.equal(allChunkPartsPresent([[seg("a")], [seg("b")]], 2), true);
  assert.equal(allChunkPartsPresent([[seg("a")], []], 2), false);
  assert.equal(allChunkPartsPresent([[seg("a")]], 2), false);
  assert.equal(allChunkPartsPresent([], 1), false);

  // H1: partial LLM parts must not be treated as complete
  const partial = [[seg("夜色渐深。何屿说：「别回头。」")], []];
  assert.equal(allChunkPartsPresent(partial, 2), false);

  // H2 fill: empty second chunk filled by rules when content has quotes/channels
  const chunkA = "夜色渐深。何屿说：「别回头。」";
  const chunkB = "他在手机上打字「收到」，然后锁屏。\n微信弹出一条消息「在吗」。";
  const filled = fillFailedChunksWithRules({
    contentChunks: [chunkA, chunkB],
    parts: [[seg(chunkA)], []],
    failedChunkIndexes: [1],
    narrator: NARRATOR,
    characterVoices: ROSTER,
  });
  assert.equal(filled.complete, true);
  assert.ok(filled.filledIndexes.includes(1));
  assert.equal(filled.stillFailedIndexes.length, 0);
  assert.ok(filled.parts[1].length > 0);
  assert.ok(filled.parts[1].some((s) => s.renderPolicy === "skip" || s.segmentKind === "typed"));

  const merged = mergeChunkedSegments(filled.parts);
  assert.ok(merged.length >= 2);
  assert.ok(merged.some((s) => /别回头/.test(s.text)));

  const note = buildMultiChunkAssemblyNote({
    stage: "diarize",
    chunkCount: 2,
    failedChunkIndexes: [1],
    filledByRulesIndexes: [1],
  });
  assert.match(note, /分 2 块 diarize/);
  assert.match(note, /失败块 2 已用规则补齐/);

  // legacy error → assemblyNote for UI/read path
  const legacy = normalizeAnnotationDiagnostics({
    chapterId: "ch1",
    chapterOrder: 1,
    chapterTitle: "一",
    segments: [seg("x")],
    error: "LLM 标注失败，已用规则装配：timeout",
    wholeChapterNarratorFallback: false,
    assemblyNote: null,
  });
  assert.equal(legacy.error, null);
  assert.match(legacy.assemblyNote || "", /已用规则装配/);

  const hard = normalizeAnnotationDiagnostics({
    chapterId: "ch1",
    chapterOrder: 1,
    chapterTitle: "一",
    segments: [seg("x")],
    error: "标注失败已回退旁白：timeout",
    wholeChapterNarratorFallback: true,
  });
  assert.match(hard.error || "", /回退旁白/);
});

test("fillFailedChunksWithRules leaves incomplete when rules cannot fill", () => {
  const {
    fillFailedChunksWithRules,
    allChunkPartsPresent,
  } = require("../dist/services/audiobook/AudiobookAnnotationService.js");

  // 极短且无 quote/通道 → rules 可能返回空，complete=false
  const filled = fillFailedChunksWithRules({
    contentChunks: ["短", "也短"],
    parts: [[], []],
    failedChunkIndexes: [0, 1],
    narrator: NARRATOR,
    characterVoices: ROSTER,
  });
  // 无论 rules 是否吐出旁白，函数契约：complete iff every part non-empty
  assert.equal(
    filled.complete,
    allChunkPartsPresent(filled.parts, 2),
  );
});

test("assemblySource: all-rules fill → no llm; partial fill → hybrid", () => {
  const {
    fillFailedChunksWithRules,
    allChunkPartsPresent,
    countLlmOwnedChunks,
  } = require("../dist/services/audiobook/AudiobookAnnotationService.js");

  const seg = (text) => ({
    index: 0,
    speakerKind: "narrator",
    speakerLabel: "旁白",
    text,
    voice: "茉莉",
    segmentKind: "narration",
    renderPolicy: "tts",
  });

  const chunkA = "夜色渐深。何屿说：「别回头。」";
  const chunkB = "他在手机上打字「收到」，然后锁屏。";

  // 全块失败 + 规则补齐 → llm owned = 0 → 调用方不得 assemblySource=llm
  const allRules = fillFailedChunksWithRules({
    contentChunks: [chunkA, chunkB],
    parts: [[], []],
    failedChunkIndexes: [0, 1],
    narrator: NARRATOR,
    characterVoices: ROSTER,
  });
  assert.equal(allRules.complete, true);
  assert.equal(allRules.filledIndexes.length, 2);
  assert.equal(countLlmOwnedChunks(allRules.parts, allRules.filledIndexes, 2), 0);
  assert.equal(allChunkPartsPresent(allRules.parts, 2), true);

  // 块 0 LLM 成功、块 1 规则补齐 → hybrid
  const hybrid = fillFailedChunksWithRules({
    contentChunks: [chunkA, chunkB],
    parts: [[seg(chunkA)], []],
    failedChunkIndexes: [1],
    narrator: NARRATOR,
    characterVoices: ROSTER,
  });
  assert.equal(hybrid.complete, true);
  assert.deepEqual(hybrid.filledIndexes, [1]);
  assert.equal(countLlmOwnedChunks(hybrid.parts, hybrid.filledIndexes, 2), 1);
  // 调用方映射：filled>0 && llm>0 → llm_rules_hybrid
  const assemblySource = hybrid.filledIndexes.length > 0
    ? (countLlmOwnedChunks(hybrid.parts, hybrid.filledIndexes, 2) > 0
      ? "llm_rules_hybrid"
      : "rules")
    : "llm";
  assert.equal(assemblySource, "llm_rules_hybrid");
});

test("mergeChunkedSegments drops multi-seg boundary overlap and punctuation-normalized dups", () => {
  const {
    mergeChunkedSegments,
  } = require("../dist/services/audiobook/AudiobookAnnotationService.js");

  const seg = (text, kind = "narration") => ({
    index: 0,
    speakerKind: "narrator",
    speakerLabel: "旁白",
    text,
    voice: "茉莉",
    segmentKind: kind,
    renderPolicy: "tts",
  });

  // 多段边界完全重叠：后块前 2 段 = 前块尾 2 段
  const part0 = [
    seg("夜色渐深。"),
    seg("何屿说：「别回头。」", "speech"),
    seg("风停了。"),
  ];
  const part1 = [
    seg("何屿说：「别回头。」", "speech"),
    seg("风停了。"),
    seg("他在手机上打字「收到」。"),
  ];
  const merged = mergeChunkedSegments([part0, part1]);
  const texts = merged.map((s) => s.text);
  assert.deepEqual(texts, [
    "夜色渐深。",
    "何屿说：「别回头。」",
    "风停了。",
    "他在手机上打字「收到」。",
  ]);
  assert.equal(merged.every((s, i) => s.index === i), true);

  // 标点/空白归一：半角/全角差异视为重复
  const mergedNorm = mergeChunkedSegments([
    [seg("别回头，他说。")],
    [seg("别回头,他说.")],
  ]);
  assert.equal(mergedNorm.length, 1);

  // 后块更长前缀 → 替换前块尾
  const longer = mergeChunkedSegments([
    [seg("夜色渐深。何屿说")],
    [seg("夜色渐深。何屿说：「别回头。」")],
  ]);
  assert.equal(longer.length, 1);
  assert.match(longer[0].text, /别回头/);
});

/**
 * 构造强制分 ≥2 块的正文（默认窗 28k）。
 * 两段可识别区：前半含何屿对白，后半含 typed/chat。
 */
function buildMultiChunkChapterContent() {
  const {
    AUDIOBOOK_LLM_CONTENT_WINDOW,
  } = require("../dist/services/audiobook/AudiobookAnnotationService.js");
  const head = "夜色渐深。何屿说：「别回头。」林致远问道：「你确定？」\n";
  const filler = "叙述填充句，用来把章节撑过 LLM 窗口。\n";
  const padUnit = "更多叙述填充，避免切块落在关键引号上。\n";
  // 目标：总长显著超过默认窗，保证 split ≥2；尾部保留 typed/chat 可识别区
  const target = AUDIOBOOK_LLM_CONTENT_WINDOW + 8_000;
  let body = head;
  while (body.length < target - 200) {
    body += body.length % 2 === 0 ? filler : padUnit;
  }
  const tail = "\n他在手机上打字「收到」，然后锁屏。\n微信弹出一条消息「在吗」。\n旁白继续往下写。\n";
  return body + tail;
}

function mockLlmSegmentsForChunk(chunkIndex) {
  if (chunkIndex === 0) {
    return {
      segments: [
        {
          speakerKind: "narrator",
          speakerName: "旁白",
          text: "夜色渐深。",
          segmentKind: "narration",
        },
        {
          speakerKind: "character",
          speakerName: "何屿",
          text: "别回头。",
          segmentKind: "speech",
        },
        {
          speakerKind: "character",
          speakerName: "林致远",
          text: "你确定？",
          segmentKind: "speech",
        },
      ],
    };
  }
  return {
    segments: [
      {
        speakerKind: "narrator",
        speakerName: "旁白",
        text: "他在手机上打字。",
        segmentKind: "narration",
      },
      {
        speakerKind: "character",
        speakerName: "何屿",
        text: "收到",
        segmentKind: "typed",
      },
    ],
  };
}

function parseChunkIndexFromTitle(title) {
  const m = String(title || "").match(/块\s*(\d+)\//);
  return m ? Number(m[1]) - 1 : 0;
}

test("annotateChapter mock: chunk0 ok + chunk1 throw → llm_rules_hybrid", async () => {
  const promptRunner = require("../dist/prompting/core/promptRunner.js");
  const {
    audiobookAnnotationService,
    splitChapterContentForLlm,
  } = require("../dist/services/audiobook/AudiobookAnnotationService.js");

  const content = buildMultiChunkChapterContent();
  const chunks = splitChapterContentForLlm(content);
  assert.ok(chunks.length >= 2, `expected multi-chunk, got ${chunks.length}`);

  const original = promptRunner.runStructuredPrompt;
  let diarizeCalls = 0;
  promptRunner.runStructuredPrompt = async ({ asset, promptInput }) => {
    const id = asset?.id || "";
    if (id.includes("diarize")) {
      diarizeCalls += 1;
      const idx = parseChunkIndexFromTitle(promptInput.chapterTitle);
      if (idx >= 1) {
        throw new Error("mock diarize fail chunk1+");
      }
      return { output: mockLlmSegmentsForChunk(0) };
    }
    // L0 已 hybrid 收工，不应落到 annotate
    throw new Error(`unexpected prompt ${id}`);
  };

  try {
    const ann = await audiobookAnnotationService.annotateChapter({
      chapterId: "ch-hybrid",
      chapterOrder: 1,
      chapterTitle: "一",
      chapterContent: content,
      narrator: NARRATOR,
      characterVoices: ROSTER,
      deliveryStyleMode: "off",
    });
    assert.equal(ann.diarizeStats.assemblySource, "llm_rules_hybrid");
    assert.ok(ann.contentTruncated === false || ann.contentTruncated === undefined);
    assert.equal(ann.wholeChapterNarratorFallback, false);
    assert.equal(ann.error, null);
    assert.match(ann.assemblyNote || "", /规则补齐|分 \d+ 块/);
    assert.ok(ann.segments.length > 0);
    assert.ok(diarizeCalls >= 2);
  } finally {
    promptRunner.runStructuredPrompt = original;
  }
});

test("annotateChapter mock: all diarize+annotate throw → whole-chapter rules not llm", async () => {
  const promptRunner = require("../dist/prompting/core/promptRunner.js");
  const {
    audiobookAnnotationService,
    splitChapterContentForLlm,
  } = require("../dist/services/audiobook/AudiobookAnnotationService.js");

  const content = buildMultiChunkChapterContent();
  assert.ok(splitChapterContentForLlm(content).length >= 2);

  const original = promptRunner.runStructuredPrompt;
  const calls = { diarize: 0, annotate: 0 };
  promptRunner.runStructuredPrompt = async ({ asset }) => {
    const id = asset?.id || "";
    if (id.includes("diarize")) {
      calls.diarize += 1;
      throw new Error("mock diarize down");
    }
    if (id.includes("annotate")) {
      calls.annotate += 1;
      throw new Error("mock annotate down");
    }
    throw new Error(`unexpected prompt ${id}`);
  };

  try {
    const ann = await audiobookAnnotationService.annotateChapter({
      chapterId: "ch-rules",
      chapterOrder: 1,
      chapterTitle: "一",
      chapterContent: content,
      narrator: NARRATOR,
      characterVoices: ROSTER,
      deliveryStyleMode: "characters",
    });
    assert.equal(ann.diarizeStats.assemblySource, "rules");
    assert.equal(ann.wholeChapterNarratorFallback, false);
    assert.equal(ann.error, null);
    assert.ok(ann.assemblyNote);
    assert.ok(calls.diarize >= 2);
    assert.ok(calls.annotate >= 2);
    // skip 通道应在整章规则里
    const skips = ann.segments.filter((s) => s.renderPolicy === "skip");
    assert.ok(skips.length >= 1, "rules path should skip typed/chat");
  } finally {
    promptRunner.runStructuredPrompt = original;
  }
});

test("annotateChapter mock: abort mid multi-chunk throws without partial success", async () => {
  const promptRunner = require("../dist/prompting/core/promptRunner.js");
  const {
    audiobookAnnotationService,
    splitChapterContentForLlm,
  } = require("../dist/services/audiobook/AudiobookAnnotationService.js");

  const content = buildMultiChunkChapterContent();
  assert.ok(splitChapterContentForLlm(content).length >= 2);

  const controller = new AbortController();
  const original = promptRunner.runStructuredPrompt;
  let diarizeCalls = 0;
  promptRunner.runStructuredPrompt = async ({ asset, promptInput }) => {
    const id = asset?.id || "";
    if (!id.includes("diarize")) throw new Error(`unexpected ${id}`);
    diarizeCalls += 1;
    const idx = parseChunkIndexFromTitle(promptInput.chapterTitle);
    if (idx === 0) {
      // 第一块成功后立即 abort，下一轮循环应抛取消
      controller.abort();
      return { output: mockLlmSegmentsForChunk(0) };
    }
    throw new Error("chunk after abort must not call LLM");
  };

  try {
    let threw = null;
    try {
      await audiobookAnnotationService.annotateChapter({
        chapterId: "ch-abort",
        chapterOrder: 1,
        chapterTitle: "一",
        chapterContent: content,
        narrator: NARRATOR,
        characterVoices: ROSTER,
        deliveryStyleMode: "off",
        signal: controller.signal,
      });
    } catch (error) {
      threw = error;
    }
    assert.ok(threw, "must throw on abort, not return partial");
    assert.match(String(threw.message || threw), /取消|abort|Abort/i);
    assert.equal(diarizeCalls, 1);
  } finally {
    promptRunner.runStructuredPrompt = original;
  }
});

test("annotateChapter mock: pure single-chunk diarize → assemblySource llm", async () => {
  const promptRunner = require("../dist/prompting/core/promptRunner.js");
  const {
    audiobookAnnotationService,
  } = require("../dist/services/audiobook/AudiobookAnnotationService.js");

  const original = promptRunner.runStructuredPrompt;
  promptRunner.runStructuredPrompt = async ({ asset }) => {
    const id = asset?.id || "";
    if (!id.includes("diarize")) throw new Error(`unexpected ${id}`);
    return {
      output: {
        segments: [
          {
            speakerKind: "narrator",
            speakerName: "旁白",
            text: "夜色渐深。",
            segmentKind: "narration",
          },
          {
            speakerKind: "character",
            speakerName: "何屿",
            text: "别回头。",
            segmentKind: "speech",
          },
          {
            speakerKind: "character",
            speakerName: "林致远",
            text: "你确定？",
            segmentKind: "speech",
          },
          {
            speakerKind: "character",
            speakerName: "何屿",
            text: "收到",
            segmentKind: "typed",
          },
        ],
      },
    };
  };

  try {
    const ann = await audiobookAnnotationService.annotateChapter({
      chapterId: "ch-llm",
      chapterOrder: 1,
      chapterTitle: "一",
      chapterContent: SAMPLE,
      narrator: NARRATOR,
      characterVoices: ROSTER,
      deliveryStyleMode: "off",
    });
    assert.equal(ann.diarizeStats.assemblySource, "llm");
    assert.equal(ann.assemblySource, "llm", "top-level assemblySource on finishAnnotation");
    assert.equal(ann.wholeChapterNarratorFallback, false);
    assert.equal(ann.error, null);
    assert.equal(ann.assemblyNote, null);
  } finally {
    promptRunner.runStructuredPrompt = original;
  }
});

test("guestVoice: same name stable, different from narrator", () => {
  const pool = guestPresetPoolForTest();
  assert.ok(pool.length >= 3);
  const a = pickGuestPresetVoice("郑文斌", "茉莉");
  const b = pickGuestPresetVoice("郑文斌", "茉莉");
  assert.equal(a, b);
  assert.notEqual(a, "茉莉");
  assert.ok(pool.includes(a));
});

test("materialize unresolved character uses guest preset not narrator voice", () => {
  const { segments } = materializeAnnotationSegments({
    rawSegments: [
      {
        speakerKind: "character",
        speakerName: "郑文斌",
        text: "同学们好。",
        segmentKind: "speech",
      },
    ],
    narrator: NARRATOR,
    characterVoices: ROSTER,
    deliveryStyleMode: "off",
  });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].speakerUnresolved, true);
  assert.equal(segments[0].unresolvedSpeakerName, "郑文斌");
  assert.notEqual(segments[0].voice, NARRATOR.voice);
  assert.equal(segments[0].renderPolicy, "tts");
  assert.equal(segments[0].segmentKind, "speech");
});

test("repairFalseChannelSkips upgrades false on_screen to speech/tts", () => {
  const content = "母亲在电话里说：「吃饭了吗？」何屿回：「吃了。」";
  const bad = [
    {
      index: 0,
      speakerKind: "narrator",
      speakerLabel: "屏幕",
      text: "吃饭了吗？",
      voice: "茉莉",
      segmentKind: "on_screen",
      renderPolicy: "skip",
    },
    {
      index: 1,
      speakerKind: "narrator",
      speakerLabel: "屏幕",
      text: "吃了。",
      voice: "茉莉",
      segmentKind: "on_screen",
      renderPolicy: "skip",
    },
  ];
  const fixed = repairFalseChannelSkips(content, bad, NARRATOR);
  for (const seg of fixed) {
    assert.equal(seg.renderPolicy, "tts", `expected tts for ${seg.text}`);
    assert.ok(
      seg.segmentKind === "speech" || seg.segmentKind === "phone",
      `kind ${seg.segmentKind}`,
    );
  }
});

test("fillUncoveredSpokenQuotes inserts missing shouldSpeak spans", () => {
  const content = "何屿说：「别回头。」林致远问道：「你确定？」";
  // 只标了一句，缺「你确定？」
  const partial = [
    {
      index: 0,
      speakerKind: "character",
      characterId: "c-he",
      speakerLabel: "何屿",
      text: "别回头。",
      voice: "白桦",
      segmentKind: "speech",
      renderPolicy: "tts",
    },
  ];
  const filled = fillUncoveredSpokenQuotes({
    content,
    segments: partial,
    narrator: NARRATOR,
    characterVoices: ROSTER,
  });
  assert.ok(filled.length >= 2);
  const joined = filled.map((s) => s.text).join("|");
  assert.match(joined, /别回头/);
  assert.match(joined, /你确定/);
  const lin = filled.find((s) => s.characterId === "c-lin" || /你确定/.test(s.text));
  assert.ok(lin);
  assert.equal(lin.renderPolicy, "tts");
});

test("rule assembly unresolved guest voice differs from narrator", () => {
  const content = "郑文斌说：「开会了。」何屿说：「好。」";
  const { segments } = assembleSegmentsFromRules({
    content,
    narrator: NARRATOR,
    characterVoices: ROSTER,
  });
  const guest = segments.find(
    (s) => s.speakerUnresolved && /郑文斌|开会/.test(s.speakerLabel + s.text),
  );
  assert.ok(guest, "unresolved 郑文斌 segment");
  assert.notEqual(guest.voice, NARRATOR.voice);
  const he = segments.find((s) => s.characterId === "c-he");
  assert.ok(he);
  assert.equal(he.voice, "白桦");
});
