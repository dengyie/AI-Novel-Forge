const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AUDIOBOOK_CHUNK_MAX_CHARS,
  MIMO_TTS_PRESET_VOICES,
  isMimoTtsPresetVoice,
  DEFAULT_AUDIOBOOK_NARRATOR_VOICE,
} = require("../../shared/dist/types/audiobook.js");
const { splitTextForTts } = require("../dist/services/audiobook/audiobookChunk.js");
const {
  resolveAudiobookTaskDir,
  resolveChunkAudioPath,
} = require("../dist/services/audiobook/audiobookPaths.js");
const { extractAudioBase64 } = require("../dist/services/audiobook/MimoChatAudioTTSProvider.js");
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
    const ann = resolveChapterAnnotationPath(root, chapterId);
    fs.writeFileSync(chunk, Buffer.alloc(48));
    fs.writeFileSync(chapterWav, Buffer.alloc(48));
    fs.writeFileSync(full, Buffer.alloc(48));
    fs.mkdirSync(path.dirname(ann), { recursive: true });
    fs.writeFileSync(ann, "{}");

    wipeChapterAudioArtifacts(root, chapterId);
    assert.equal(fs.existsSync(chunk), false);
    assert.equal(fs.existsSync(chapterWav), false);
    assert.equal(fs.existsSync(full), false);
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
  delete process.env.API_AUTH_TOKEN;
});
