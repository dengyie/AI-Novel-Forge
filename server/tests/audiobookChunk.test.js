const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AUDIOBOOK_CHUNK_MAX_CHARS,
  AUDIOBOOK_GAP_MS,
  MIMO_TTS_PRESET_VOICES,
  isMimoTtsPresetVoice,
  DEFAULT_AUDIOBOOK_NARRATOR_VOICE,
} = require("../../shared/dist/types/audiobook.js");
const {
  splitTextForTts,
  coalesceSegmentsBySpeaker,
  expandSegmentsToChunkJobs,
} = require("../dist/services/audiobook/audiobookChunk.js");
const {
  resolveAudiobookTaskDir,
  resolveChunkAudioPath,
} = require("../dist/services/audiobook/audiobookPaths.js");
const { extractAudioBase64, buildMimoTtsRequestBody } = require("../dist/services/audiobook/MimoChatAudioTTSProvider.js");
const { MIMO_TTS_MODELS, isAudiobookTtsMode } = require("../../shared/dist/types/audiobook.js");
const { isMissingAudiobookTaskTableError } = require("../dist/services/audiobook/audiobookErrors.js");

test("MiMo preset voice catalog includes product SoT voices", () => {
  assert.equal(isMimoTtsPresetVoice("茉莉"), true);
  assert.equal(isMimoTtsPresetVoice("冰糖"), true);
  assert.equal(isMimoTtsPresetVoice("Dean"), true);
  assert.equal(isMimoTtsPresetVoice("not-a-voice"), false);
  assert.equal(DEFAULT_AUDIOBOOK_NARRATOR_VOICE, "茉莉");
  assert.equal(MIMO_TTS_PRESET_VOICES.length, 8);
});

test("splitTextForTts returns empty for blank input", () => {
  assert.deepEqual(splitTextForTts(""), []);
  assert.deepEqual(splitTextForTts("   \n  "), []);
});

test("splitTextForTts keeps short text as single chunk", () => {
  const text = "夜色渐深，长街只剩脚步声。";
  assert.deepEqual(splitTextForTts(text, AUDIOBOOK_CHUNK_MAX_CHARS), [text]);
});

test("splitTextForTts respects maxChars and prefers sentence breaks", () => {
  const sentence = "这是一句完整的旁白。";
  const text = sentence.repeat(40);
  const chunks = splitTextForTts(text, 80);
  assert.equal(chunks.length > 1, true);
  assert.equal(chunks.every((chunk) => chunk.length <= 80), true);
  assert.equal(chunks.join(""), text);
  assert.equal(chunks.some((chunk) => chunk.endsWith("。")), true);
});

test("splitTextForTts hard-splits when no punctuation exists", () => {
  const text = "甲".repeat(120);
  const chunks = splitTextForTts(text, 50);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, 50);
  assert.equal(chunks[1].length, 50);
  assert.equal(chunks[2].length, 20);
  assert.equal(chunks.join(""), text);
});

test("splitTextForTts preserves interior whitespace across chunks", () => {
  const text = `${"甲".repeat(40)}\n\n${"乙".repeat(40)}`;
  const chunks = splitTextForTts(text, 45);
  assert.equal(chunks.length > 1, true);
  assert.equal(chunks.join(""), text);
  assert.equal(chunks.join("").includes("\n\n"), true);
});

test("coalesceSegmentsBySpeaker merges consecutive same speaker", () => {
  const segments = [
    {
      index: 0,
      speakerKind: "narrator",
      characterId: null,
      speakerLabel: "旁白",
      text: "夜色渐深。",
      ttsMode: "preset",
      voice: "茉莉",
      style: "旁白",
    },
    {
      index: 1,
      speakerKind: "narrator",
      characterId: null,
      speakerLabel: "旁白",
      text: "长街只剩脚步声。",
      ttsMode: "preset",
      voice: "茉莉",
      style: "旁白",
    },
    {
      index: 2,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "林远",
      text: "别回头。",
      ttsMode: "preset",
      voice: "白桦",
      style: null,
    },
    {
      index: 3,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "林远",
      text: "跟我走。",
      ttsMode: "preset",
      voice: "白桦",
      style: null,
    },
  ];
  const merged = coalesceSegmentsBySpeaker(segments);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].text, "夜色渐深。\n长街只剩脚步声。");
  assert.equal(merged[1].text, "别回头。\n跟我走。");
  assert.equal(merged[0].index, 0);
  assert.equal(merged[1].index, 1);
});

test("coalesceSegmentsBySpeaker does not merge different voice config", () => {
  const segments = [
    {
      index: 0,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "林远",
      text: "一句。",
      ttsMode: "preset",
      voice: "白桦",
      style: "平静",
    },
    {
      index: 1,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "林远",
      text: "二句。",
      ttsMode: "preset",
      voice: "白桦",
      style: "急促",
    },
  ];
  const merged = coalesceSegmentsBySpeaker(segments);
  assert.equal(merged.length, 2);
});

test("coalesceSegmentsBySpeaker merges same deliveryMergeKey even if style strings differ", () => {
  const segments = [
    {
      index: 0,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "何屿",
      text: "你把责任说清楚。",
      ttsMode: "preset",
      voice: "白桦",
      style: "基线\n本句表演：平静公事地压着怒，甲。",
      deliveryMergeKey: "anger|mid|soft|measured",
    },
    {
      index: 1,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "何屿",
      text: "别再甩锅。",
      ttsMode: "preset",
      voice: "白桦",
      style: "基线\n本句表演：平静公事地压着怒，乙。",
      deliveryMergeKey: "anger|mid|soft|measured",
    },
  ];
  const merged = coalesceSegmentsBySpeaker(segments);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, "你把责任说清楚。\n别再甩锅。");
  // 段首 style 保留
  assert.equal(merged[0].style.includes("甲。"), true);
});

test("coalesceSegmentsBySpeaker does not merge different deliveryMergeKey", () => {
  const segments = [
    {
      index: 0,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "何屿",
      text: "你把责任说清楚。",
      ttsMode: "preset",
      voice: "白桦",
      style: "A",
      deliveryMergeKey: "anger|mid|soft|measured",
    },
    {
      index: 1,
      speakerKind: "character",
      characterId: "c1",
      speakerLabel: "何屿",
      text: "先歇一会儿。",
      ttsMode: "preset",
      voice: "白桦",
      style: "B",
      deliveryMergeKey: "tender|low|soft|slow",
    },
  ];
  const merged = coalesceSegmentsBySpeaker(segments);
  assert.equal(merged.length, 2);
});

test("expandSegmentsToChunkJobs groups then splits long text", () => {
  const longA = "甲。".repeat(300);
  const longB = "乙。".repeat(10);
  const segments = [
    {
      index: 0,
      speakerKind: "narrator",
      characterId: null,
      speakerLabel: "旁白",
      text: longA.slice(0, 200),
      ttsMode: "preset",
      voice: "茉莉",
    },
    {
      index: 1,
      speakerKind: "narrator",
      characterId: null,
      speakerLabel: "旁白",
      text: longA.slice(200),
      ttsMode: "preset",
      voice: "茉莉",
    },
    {
      index: 2,
      speakerKind: "character",
      characterId: "c2",
      speakerLabel: "苏沫",
      text: longB,
      ttsMode: "preset",
      voice: "冰糖",
    },
  ];
  const jobs = expandSegmentsToChunkJobs(segments);
  assert.equal(jobs.length >= 2, true);
  assert.equal(jobs.every((job) => job.text.length <= AUDIOBOOK_CHUNK_MAX_CHARS), true);
  const narratorJobs = jobs.filter((job) => job.segment.speakerKind === "narrator");
  assert.equal(narratorJobs.length >= 1, true);
  assert.equal(narratorJobs[0].segment.text.includes("\n"), true);
});

test("audiobookPaths rejects path traversal segments", () => {
  assert.throws(() => resolveAudiobookTaskDir("../etc", "task1"), /非法/);
  assert.throws(() => resolveAudiobookTaskDir("novel1", "a/b"), /非法/);
  assert.throws(() => resolveChunkAudioPath("/tmp/x", "../ch", 0), /非法/);
  const dir = resolveAudiobookTaskDir("novel_abc", "task_xyz");
  assert.equal(dir.includes("novel_abc"), true);
  assert.equal(dir.includes("task_xyz"), true);
});

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  wipeChapterAudioArtifacts,
  wipeChapterAnnotationArtifact,
  resolveChapterAudioPath,
  resolveFullBookAudioPath,
  resolveChapterAnnotationPath,
  ensureChapterAudioDir,
} = require("../dist/services/audiobook/audiobookPaths.js");
const {
  parseWavInfo,
  buildWavBuffer,
  concatWavFiles,
  createSilentPcm,
  isValidPcmWavFile,
  writeWavFileAtomic,
} = require("../dist/services/audiobook/audiobookWav.js");
const {
  issueAudiobookMediaAccess,
  verifyAudiobookMediaAccess,
} = require("../dist/services/audiobook/audiobookMediaAccess.js");

test("wipeChapterAudioArtifacts removes chapter audio and full-book only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ab-wipe-"));
  try {
    const chapterId = "ch01";
    ensureChapterAudioDir(root, chapterId);
    const chunk = resolveChunkAudioPath(root, chapterId, 0);
    const chapterWav = resolveChapterAudioPath(root, chapterId);
    const full = resolveFullBookAudioPath(root);
    const fullM4b = path.join(root, "full-book.m4b");
    const ann = resolveChapterAnnotationPath(root, chapterId);
    fs.writeFileSync(chunk, Buffer.alloc(48));
    fs.writeFileSync(chapterWav, Buffer.alloc(48));
    fs.writeFileSync(full, Buffer.alloc(48));
    fs.writeFileSync(fullM4b, Buffer.alloc(48));
    fs.mkdirSync(path.dirname(ann), { recursive: true });
    fs.writeFileSync(ann, "{}");

    wipeChapterAudioArtifacts(root, chapterId);
    assert.equal(fs.existsSync(chunk), false);
    assert.equal(fs.existsSync(chapterWav), false);
    assert.equal(fs.existsSync(full), false);
    assert.equal(fs.existsSync(fullM4b), false);
    assert.equal(fs.existsSync(ann), true);

    wipeChapterAnnotationArtifact(root, chapterId);
    assert.equal(fs.existsSync(ann), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extractAudioBase64 reads message.audio.data", () => {
  assert.equal(extractAudioBase64(null), null);
  assert.equal(extractAudioBase64({ choices: [] }), null);
  assert.equal(
    extractAudioBase64({
      choices: [{ message: { audio: { data: "  UklGRdata  " } } }],
    }),
    "UklGRdata",
  );
  assert.equal(
    extractAudioBase64({
      choices: [{ message: { content: "UklGRfallback" } }],
    }),
    "UklGRfallback",
  );
});

test("isMissingAudiobookTaskTableError rejects plain errors", () => {
  assert.equal(isMissingAudiobookTaskTableError(new Error("x")), false);
  assert.equal(isMissingAudiobookTaskTableError(null), false);
  assert.equal(isMissingAudiobookTaskTableError({ code: "P2021" }), false);
});

test("buildWavBuffer + parseWavInfo round-trip PCM header", () => {
  const pcm = Buffer.alloc(480); // 10ms @ 24k mono 16-bit
  const wav = buildWavBuffer(pcm, { numChannels: 1, sampleRate: 24_000, bitsPerSample: 16 });
  const info = parseWavInfo(wav);
  assert.equal(info.numChannels, 1);
  assert.equal(info.sampleRate, 24_000);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.audioFormat, 1);
  assert.equal(info.dataSize, 480);
});

test("concatWavFiles merges same-format chunks in order (streaming)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-wav-"));
  try {
    const a = buildWavBuffer(Buffer.from([1, 2, 3, 4]), { numChannels: 1, sampleRate: 24_000, bitsPerSample: 16 });
    const b = buildWavBuffer(Buffer.from([5, 6, 7, 8]), { numChannels: 1, sampleRate: 24_000, bitsPerSample: 16 });
    const pathA = path.join(dir, "a.wav");
    const pathB = path.join(dir, "b.wav");
    const out = path.join(dir, "out.wav");
    fs.writeFileSync(pathA, a);
    fs.writeFileSync(pathB, b);
    const result = concatWavFiles([pathA, pathB], out);
    assert.equal(result.chunks, 2);
    assert.equal(result.sampleRate, 24_000);
    const merged = fs.readFileSync(out);
    const info = parseWavInfo(merged);
    assert.equal(info.dataSize, 8);
    assert.deepEqual(
      [...merged.subarray(info.dataOffset, info.dataOffset + info.dataSize)],
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.equal(fs.existsSync(`${out}.part`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createSilentPcm length matches duration", () => {
  const pcm = createSilentPcm(100, 24_000, 1);
  assert.equal(pcm.length, 24_000 * 0.1 * 2);
  assert.equal(pcm.every((byte) => byte === 0), true);
});

test("isValidPcmWavFile rejects truncated wav", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-wav-valid-"));
  try {
    const good = buildWavBuffer(Buffer.alloc(100), { numChannels: 1, sampleRate: 24_000, bitsPerSample: 16 });
    const goodPath = path.join(dir, "good.wav");
    writeWavFileAtomic(goodPath, good);
    assert.equal(isValidPcmWavFile(goodPath), true);

    const badPath = path.join(dir, "bad.wav");
    fs.writeFileSync(badPath, good.subarray(0, 60));
    assert.equal(isValidPcmWavFile(badPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("audiobook media access sign and verify", () => {
  process.env.API_AUTH_TOKEN = "test-media-secret-token";
  const issued = issueAudiobookMediaAccess({
    novelId: "novel1",
    taskId: "task1",
    resource: { kind: "full" },
    ttlSec: 120,
  });
  assert.ok(issued);
  assert.equal(
    verifyAudiobookMediaAccess({
      access: issued.access,
      novelId: "novel1",
      taskId: "task1",
      resource: { kind: "full" },
    }),
    true,
  );
  assert.equal(
    verifyAudiobookMediaAccess({
      access: issued.access,
      novelId: "novel1",
      taskId: "task-other",
      resource: { kind: "full" },
    }),
    false,
  );
  assert.equal(
    verifyAudiobookMediaAccess({
      access: issued.access,
      novelId: "novel1",
      taskId: "task1",
      resource: { kind: "chapter", chapterId: "c1" },
    }),
    false,
  );
  const m4bIssued = issueAudiobookMediaAccess({
    novelId: "novel1",
    taskId: "task1",
    resource: { kind: "full_m4b" },
    ttlSec: 120,
  });
  assert.ok(m4bIssued);
  assert.equal(
    verifyAudiobookMediaAccess({
      access: m4bIssued.access,
      novelId: "novel1",
      taskId: "task1",
      resource: { kind: "full_m4b" },
    }),
    true,
  );
  assert.equal(
    verifyAudiobookMediaAccess({
      access: m4bIssued.access,
      novelId: "novel1",
      taskId: "task1",
      resource: { kind: "full" },
    }),
    false,
  );
  delete process.env.API_AUTH_TOKEN;
});


const {
  classifyChunkGap,
  resolveInterChunkGapMs,
  resolveBetweenChapterGapMs,
  speakerKeyFromSegment,
} = require("../dist/services/audiobook/audiobookGap.js");

test("speakerKeyFromSegment distinguishes narrator and characters", () => {
  assert.equal(speakerKeyFromSegment({ speakerKind: "narrator", speakerLabel: "旁白" }), "narrator");
  assert.equal(
    speakerKeyFromSegment({ speakerKind: "character", characterId: "c1", speakerLabel: "何屿" }),
    "character:c1",
  );
  assert.equal(
    speakerKeyFromSegment({ speakerKind: "character", speakerLabel: "路人" }),
    "label:路人",
  );
});

test("resolveInterChunkGapMs applies semantic pause table and short-utterance bonus", () => {
  const narrator = { speakerKey: "narrator", speakerKind: "narrator", text: "他走进教室。" + "甲".repeat(40) };
  const heYu = { speakerKey: "character:c1", speakerKind: "character", text: "赵助教。" };
  const huang = { speakerKey: "character:c2", speakerKind: "character", text: "走，吃饭。" };

  assert.equal(classifyChunkGap(narrator, heYu), "narrator_character");
  assert.equal(classifyChunkGap(heYu, huang), "character_character");
  assert.equal(classifyChunkGap(narrator, { ...narrator, text: "续。" }), "same_speaker");

  // long narrator -> character: base only
  assert.equal(resolveInterChunkGapMs(narrator, heYu), AUDIOBOOK_GAP_MS.narratorCharacter);
  // short character -> narrator: base + bonus
  assert.equal(
    resolveInterChunkGapMs(heYu, narrator),
    AUDIOBOOK_GAP_MS.narratorCharacter + AUDIOBOOK_GAP_MS.shortUtteranceBonus,
  );
  // short character -> other character
  assert.equal(
    resolveInterChunkGapMs(heYu, huang),
    AUDIOBOOK_GAP_MS.characterCharacter + AUDIOBOOK_GAP_MS.shortUtteranceBonus,
  );
  // same speaker continuation
  assert.equal(
    resolveInterChunkGapMs(narrator, { ...narrator, text: "下一块。" }),
    AUDIOBOOK_GAP_MS.sameSpeaker,
  );
  assert.equal(resolveBetweenChapterGapMs(), AUDIOBOOK_GAP_MS.betweenChapters);
});

test("concatWavFiles inserts silenceBetweenMs between chunks", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-gap-"));
  const fmt = { numChannels: 1, sampleRate: 24_000, bitsPerSample: 16 };
  // 100ms tone-ish non-zero pcm + 100ms
  const pcmA = Buffer.alloc(24_000 * 2 * 0.1);
  for (let i = 0; i < pcmA.length; i += 2) pcmA.writeInt16LE(1000, i);
  const pcmB = Buffer.alloc(24_000 * 2 * 0.1);
  for (let i = 0; i < pcmB.length; i += 2) pcmB.writeInt16LE(-1000, i);
  const a = path.join(tmp, "a.wav");
  const b = path.join(tmp, "b.wav");
  const out = path.join(tmp, "out.wav");
  fs.writeFileSync(a, buildWavBuffer(pcmA, fmt));
  fs.writeFileSync(b, buildWavBuffer(pcmB, fmt));

  const merged = concatWavFiles([a, b], out, [500]);
  assert.equal(merged.silenceInsertedMs, 500);
  const buf = fs.readFileSync(out);
  const info = parseWavInfo(buf);
  const expectedPcmBytes = pcmA.length + pcmB.length + createSilentPcm(500, 24_000, 1).length;
  assert.equal(info.dataSize, expectedPcmBytes);
  // middle region should be zeros (silence)
  const mid = info.dataOffset + pcmA.length + Math.floor(createSilentPcm(500, 24_000, 1).length / 2);
  assert.equal(buf.readInt16LE(mid), 0);
});


test("isAudiobookTtsMode accepts three modes", () => {
  assert.equal(isAudiobookTtsMode("preset"), true);
  assert.equal(isAudiobookTtsMode("design"), true);
  assert.equal(isAudiobookTtsMode("clone"), true);
  assert.equal(isAudiobookTtsMode("other"), false);
});

test("buildMimoTtsRequestBody preset includes voice and style", () => {
  const body = buildMimoTtsRequestBody({
    text: "你好。",
    mode: "preset",
    voice: "茉莉",
    style: "知性旁白",
  });
  assert.equal(body.model, MIMO_TTS_MODELS.preset);
  assert.equal(body.messages[0].content, "知性旁白");
  assert.equal(body.messages[1].content, "你好。");
  assert.equal(body.audio.voice, "茉莉");
  assert.equal(body.audio.format, "wav");
});

test("buildMimoTtsRequestBody design omits audio.voice", () => {
  const body = buildMimoTtsRequestBody({
    text: "校准新声音。",
    mode: "design",
    designPrompt: "青年女声，清亮不尖",
  });
  assert.equal(body.model, MIMO_TTS_MODELS.design);
  assert.equal(body.messages[0].content, "青年女声，清亮不尖");
  assert.equal(body.messages[1].content, "校准新声音。");
  assert.equal(Object.prototype.hasOwnProperty.call(body.audio, "voice"), false);
});

test("buildMimoTtsRequestBody clone uses DataURL voice", () => {
  const bare = Buffer.from("RIFF....WAVEfmt ").toString("base64");
  const body = buildMimoTtsRequestBody({
    text: "克隆测试。",
    mode: "clone",
    style: "语速稍慢",
    refAudioBase64: bare,
  });
  assert.equal(body.model, MIMO_TTS_MODELS.clone);
  assert.equal(body.messages[0].content, "语速稍慢");
  assert.equal(body.audio.voice.startsWith("data:audio/wav;base64,"), true);
  assert.equal(body.audio.voice.endsWith(bare), true);
});

test("buildMimoTtsRequestBody rejects design without prompt", () => {
  assert.throws(
    () => buildMimoTtsRequestBody({ text: "x", mode: "design" }),
    /design/,
  );
});

test("buildMimoTtsRequestBody rejects preset unknown voice", () => {
  assert.throws(
    () => buildMimoTtsRequestBody({ text: "x", mode: "preset", voice: "not-real" }),
    /预置/,
  );
});


const { parseSpeakerAliases } = require("../dist/services/audiobook/audiobookSpeakerAliases.js");
const {
  buildM4bChapterTimeline,
  buildM4bFfmetadata,
  encodeFullBookM4b,
  resolveFfmpegBinary,
} = require("../dist/services/audiobook/audiobookM4b.js");
const {
  matchCharacterBySpeakerNameForTest,
} = require("../dist/services/audiobook/AudiobookAnnotationService.js");

test("parseSpeakerAliases accepts JSON array and delimiter strings", () => {
  assert.deepEqual(parseSpeakerAliases(null), []);
  assert.deepEqual(parseSpeakerAliases(""), []);
  assert.deepEqual(parseSpeakerAliases(["远哥", " 小远 ", ""]), ["远哥", "小远"]);
  assert.deepEqual(parseSpeakerAliases('["远哥","小远"]'), ["远哥", "小远"]);
  assert.deepEqual(parseSpeakerAliases("远哥、小远,阿远"), ["远哥", "小远", "阿远"]);
});

test("matchCharacterBySpeakerName prefers exact then longest alias", () => {
  const voices = [
    {
      characterId: "c1",
      characterName: "李远",
      speakerAliases: ["远", "远哥"],
      ttsVoice: "白桦",
    },
    {
      characterId: "c2",
      characterName: "远哥弟弟",
      speakerAliases: ["远哥弟弟"],
      ttsVoice: "Dean",
    },
  ];
  assert.equal(matchCharacterBySpeakerNameForTest("李远", voices)?.characterId, "c1");
  assert.equal(matchCharacterBySpeakerNameForTest("远哥", voices)?.characterId, "c1");
  // 子串：优先更长候选「远哥弟弟」
  assert.equal(matchCharacterBySpeakerNameForTest("远哥弟弟说", voices)?.characterId, "c2");
  assert.equal(matchCharacterBySpeakerNameForTest("旁白", voices), null);
});

test("buildM4bFfmetadata writes chapter blocks with ms timebase", () => {
  const meta = buildM4bFfmetadata({
    title: "测试书=标题",
    chapters: [
      { title: "第一章", startMs: 0, endMs: 1000 },
      { title: "第二章;夜", startMs: 1000, endMs: 2500 },
    ],
  });
  assert.equal(meta.includes(";FFMETADATA1"), true);
  assert.equal(meta.includes("title=测试书\\=标题"), true);
  assert.equal(meta.includes("TIMEBASE=1/1000"), true);
  assert.equal(meta.includes("START=0"), true);
  assert.equal(meta.includes("END=1000"), true);
  assert.equal(meta.includes("START=1000"), true);
  assert.equal(meta.includes("END=2500"), true);
  assert.equal(meta.includes("title=第二章\\;夜"), true);
});

test("buildM4bChapterTimeline includes between-chapter gaps", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-timeline-"));
  try {
    // 100ms @ 24k mono 16-bit = 4800 bytes PCM
    const pcmBytes = 4800;
    const wav = buildWavBuffer(Buffer.alloc(pcmBytes), { numChannels: 1, sampleRate: 24_000, bitsPerSample: 16 });
    const c1 = path.join(dir, "c1.wav");
    const c2 = path.join(dir, "c2.wav");
    fs.writeFileSync(c1, wav);
    fs.writeFileSync(c2, wav);
    const timeline = buildM4bChapterTimeline({
      chapters: [
        { chapterId: "1", chapterTitle: "一", chapterOrder: 1, wavPath: c1 },
        { chapterId: "2", chapterTitle: "二", chapterOrder: 2, wavPath: c2 },
      ],
      betweenChapterGapMs: 700,
    });
    assert.equal(timeline.length, 2);
    assert.equal(timeline[0].startMs, 0);
    assert.equal(timeline[0].endMs, 100);
    assert.equal(timeline[1].startMs, 800); // 100 + 700
    assert.equal(timeline[1].endMs, 900);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("encodeFullBookM4b skips when ffmpeg is unavailable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-m4b-"));
  const prevFfmpeg = process.env.AUDIOBOOK_FFMPEG_PATH;
  const prevFfmpeg2 = process.env.FFMPEG_PATH;
  const prevPath = process.env.PATH;
  try {
    const wav = buildWavBuffer(Buffer.alloc(4800), { numChannels: 1, sampleRate: 24_000, bitsPerSample: 16 });
    const full = path.join(dir, "full-book.wav");
    fs.writeFileSync(full, wav);
    process.env.AUDIOBOOK_FFMPEG_PATH = path.join(dir, "missing-ffmpeg-binary");
    process.env.FFMPEG_PATH = path.join(dir, "missing-ffmpeg-binary");
    process.env.PATH = "";
    const result = await encodeFullBookM4b({
      taskDir: dir,
      bookTitle: "无 ffmpeg 书",
      chapters: [],
    });
    assert.equal(result.status, "skipped");
    assert.equal(result.path, null);
    assert.match(result.reason || "", /ffmpeg/);

    const missing = await encodeFullBookM4b({
      taskDir: path.join(dir, "no-wav"),
      bookTitle: "x",
      chapters: [],
    });
    assert.equal(missing.status, "failed");
    assert.equal(Boolean(missing.reason), true);
  } finally {
    if (prevFfmpeg === undefined) delete process.env.AUDIOBOOK_FFMPEG_PATH;
    else process.env.AUDIOBOOK_FFMPEG_PATH = prevFfmpeg;
    if (prevFfmpeg2 === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = prevFfmpeg2;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
