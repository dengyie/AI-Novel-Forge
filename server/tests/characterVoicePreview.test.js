const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_CHARACTER_VOICE_PREVIEW_TEXT,
  buildCharacterVoicePreviewFingerprint,
  resolveCharacterVoicePreviewStatus,
  resolvePreviewTtsMode,
  assertCharacterVoiceReadyForPreview,
  buildCharacterVoicePreviewAudioUrl,
} = require("../dist/services/audiobook/characterVoicePreview.js");

const {
  resolveCharacterVoicePreviewPath,
  writeCharacterVoicePreviewFromBase64,
} = require("../dist/services/audiobook/audiobookPaths.js");

test("resolvePreviewTtsMode defaults and validates", () => {
  assert.equal(resolvePreviewTtsMode(null), "preset");
  assert.equal(resolvePreviewTtsMode("weird"), "preset");
  assert.equal(resolvePreviewTtsMode("design"), "design");
  assert.equal(resolvePreviewTtsMode("clone"), "clone");
});

test("buildCharacterVoicePreviewFingerprint is stable and sensitive", () => {
  const base = {
    ttsMode: "preset",
    ttsVoice: "茉莉",
    ttsStyle: "平静",
    ttsDesignPrompt: "",
    ttsRefAudioPath: "",
  };
  const a = buildCharacterVoicePreviewFingerprint(base, DEFAULT_CHARACTER_VOICE_PREVIEW_TEXT);
  const b = buildCharacterVoicePreviewFingerprint({ ...base }, DEFAULT_CHARACTER_VOICE_PREVIEW_TEXT);
  assert.equal(a, b);
  assert.equal(a.length, 64);

  const changedVoice = buildCharacterVoicePreviewFingerprint(
    { ...base, ttsVoice: "白桦" },
    DEFAULT_CHARACTER_VOICE_PREVIEW_TEXT,
  );
  assert.notEqual(a, changedVoice);

  const changedSample = buildCharacterVoicePreviewFingerprint(base, "另一句样例");
  assert.notEqual(a, changedSample);
});

test("assertCharacterVoiceReadyForPreview gates modes", () => {
  assert.throws(
    () => assertCharacterVoiceReadyForPreview({ ttsMode: "preset", ttsVoice: "" }),
    /预置音色/,
  );
  assert.doesNotThrow(() =>
    assertCharacterVoiceReadyForPreview({ ttsMode: "preset", ttsVoice: "茉莉" }),
  );

  assert.throws(
    () => assertCharacterVoiceReadyForPreview({ ttsMode: "design", ttsDesignPrompt: "" }),
    /设计描述/,
  );
  assert.doesNotThrow(() =>
    assertCharacterVoiceReadyForPreview({ ttsMode: "design", ttsDesignPrompt: "沉稳男声" }),
  );

  assert.throws(
    () => assertCharacterVoiceReadyForPreview({ ttsMode: "clone", ttsRefAudioPath: "" }),
    /参考音频/,
  );
  assert.doesNotThrow(() =>
    assertCharacterVoiceReadyForPreview({ ttsMode: "clone", ttsRefAudioPath: "/tmp/a.wav" }),
  );
});

test("resolveCharacterVoicePreviewStatus missing/ready/stale", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-preview-"));
  const wavPath = path.join(tmpDir, "preview.wav");
  // 合法 PCM WAV（与 isValidPcmWavFile 对齐）
  const dataSize = 48;
  const buf = Buffer.alloc(44 + dataSize, 0);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(24000, 24);
  buf.writeUInt32LE(48000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(wavPath, buf);

  const fakePath = path.join(tmpDir, "fake.wav");
  const fake = Buffer.alloc(64, 0);
  fake.write("RIFF", 0);
  fake.writeUInt32LE(56, 4);
  fake.write("WAVE", 8);
  fs.writeFileSync(fakePath, fake);

  const fingerprint = "abc";
  assert.equal(
    resolveCharacterVoicePreviewStatus({
      audioPath: null,
      fingerprint,
      currentFingerprint: fingerprint,
    }),
    "missing",
  );
  assert.equal(
    resolveCharacterVoicePreviewStatus({
      audioPath: path.join(tmpDir, "nope.wav"),
      fingerprint,
      currentFingerprint: fingerprint,
    }),
    "missing",
  );
  assert.equal(
    resolveCharacterVoicePreviewStatus({
      audioPath: fakePath,
      fingerprint,
      currentFingerprint: fingerprint,
    }),
    "missing",
    "伪 RIFF 不得记为 ready",
  );
  assert.equal(
    resolveCharacterVoicePreviewStatus({
      audioPath: wavPath,
      fingerprint,
      currentFingerprint: fingerprint,
    }),
    "ready",
  );
  assert.equal(
    resolveCharacterVoicePreviewStatus({
      audioPath: wavPath,
      fingerprint: "old",
      currentFingerprint: "new",
    }),
    "stale",
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("buildCharacterVoicePreviewAudioUrl encodes ids", () => {
  assert.equal(
    buildCharacterVoicePreviewAudioUrl("n1", "c1"),
    "/novels/n1/characters/c1/voice-preview/audio",
  );
});

test("writeCharacterVoicePreviewFromBase64 accepts PCM WAV and rejects fake/non-wav", () => {
  const novelId = `tnovel_${Date.now()}`;
  const characterId = `tchar_${Date.now()}`;
  const writtenDir = path.dirname(resolveCharacterVoicePreviewPath(novelId, characterId));
  try {
    // 伪 RIFF（仅头）不得写入
    const fake = Buffer.alloc(64, 0);
    fake.write("RIFF", 0);
    fake.writeUInt32LE(56, 4);
    fake.write("WAVE", 8);
    assert.throws(
      () =>
        writeCharacterVoicePreviewFromBase64({
          novelId,
          characterId,
          base64: fake.toString("base64"),
        }),
      /PCM WAV|WAV/,
    );

    // 合法 PCM WAV
    const dataSize = 48;
    const pcm = Buffer.alloc(44 + dataSize, 0);
    pcm.write("RIFF", 0);
    pcm.writeUInt32LE(36 + dataSize, 4);
    pcm.write("WAVE", 8);
    pcm.write("fmt ", 12);
    pcm.writeUInt32LE(16, 16);
    pcm.writeUInt16LE(1, 20);
    pcm.writeUInt16LE(1, 22);
    pcm.writeUInt32LE(24000, 24);
    pcm.writeUInt32LE(48000, 28);
    pcm.writeUInt16LE(2, 32);
    pcm.writeUInt16LE(16, 34);
    pcm.write("data", 36);
    pcm.writeUInt32LE(dataSize, 40);
    const written = writeCharacterVoicePreviewFromBase64({
      novelId,
      characterId,
      base64: pcm.toString("base64"),
    });
    assert.equal(written, resolveCharacterVoicePreviewPath(novelId, characterId));
    assert.equal(fs.existsSync(written), true);
    assert.equal(fs.statSync(written).size, 44 + dataSize);

    assert.throws(
      () =>
        writeCharacterVoicePreviewFromBase64({
          novelId,
          characterId,
          base64: Buffer.from("not-wav").toString("base64"),
        }),
      /WAV/,
    );
  } finally {
    fs.rmSync(writtenDir, { recursive: true, force: true });
  }
});
