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
  // minimal RIFF larger than 44 bytes
  const buf = Buffer.alloc(64, 0);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(56, 4);
  buf.write("WAVE", 8);
  fs.writeFileSync(wavPath, buf);

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

test("writeCharacterVoicePreviewFromBase64 accepts RIFF and rejects non-wav", () => {
  const novelId = `tnovel_${Date.now()}`;
  const characterId = `tchar_${Date.now()}`;
  const writtenDir = path.dirname(resolveCharacterVoicePreviewPath(novelId, characterId));
  try {
    const riff = Buffer.alloc(64, 0);
    riff.write("RIFF", 0);
    riff.writeUInt32LE(56, 4);
    riff.write("WAVE", 8);
    const b64 = riff.toString("base64");
    const written = writeCharacterVoicePreviewFromBase64({
      novelId,
      characterId,
      base64: b64,
    });
    assert.equal(written, resolveCharacterVoicePreviewPath(novelId, characterId));
    assert.equal(fs.existsSync(written), true);
    assert.equal(fs.statSync(written).size, 64);

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
