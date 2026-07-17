const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  copyCharacterVoicePreviewToRef,
  resolveCharacterVoicePreviewPath,
  resolveCharacterVoiceRefPath,
  resolveVoiceRefRoot,
  writeCharacterVoicePreviewFromBase64,
} = require("../dist/services/audiobook/audiobookPaths.js");
const { checkVoiceRefAudioPath } = require("../dist/services/audiobook/voiceRefPath.js");
const { isValidPcmWavFile } = require("../dist/services/audiobook/audiobookWav.js");
const {
  buildCharacterVoicePreviewFingerprint,
  resolveCharacterVoicePreviewStatus,
} = require("../dist/services/audiobook/characterVoicePreview.js");

/** minimal PCM WAV (8 bytes silence-ish header+data) via handcrafted RIFF */
function minimalPcmWavBase64() {
  // 44-byte header + 100 samples mono 16-bit
  const dataSize = 200;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // pcm chunk
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(24000, 24);
  buf.writeUInt32LE(48000, 28); // byte rate
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf.toString("base64");
}

test("copyCharacterVoicePreviewToRef rejects missing preview", () => {
  assert.throws(
    () =>
      copyCharacterVoicePreviewToRef({
        novelId: "n-missing",
        characterId: "c-missing",
        previewPath: path.join(os.tmpdir(), `no-such-${Date.now()}.wav`),
      }),
    /合法 PCM WAV|试听/,
  );
});

test("copyCharacterVoicePreviewToRef writes ref.wav under voice-refs", () => {
  const novelId = `n-clone-${Date.now()}`;
  const characterId = `c-clone-${Date.now()}`;
  const previewPath = writeCharacterVoicePreviewFromBase64({
    novelId,
    characterId,
    base64: minimalPcmWavBase64(),
  });
  assert.equal(isValidPcmWavFile(previewPath), true);

  const refPath = copyCharacterVoicePreviewToRef({
    novelId,
    characterId,
    previewPath,
  });
  assert.equal(refPath, resolveCharacterVoiceRefPath(novelId, characterId, "wav"));
  assert.equal(isValidPcmWavFile(refPath), true);
  const checked = checkVoiceRefAudioPath(refPath);
  assert.equal(checked.ok, true);
  // source preview still intact
  assert.equal(isValidPcmWavFile(previewPath), true);
  assert.ok(refPath.startsWith(resolveVoiceRefRoot()));

  // cleanup
  try {
    fs.unlinkSync(refPath);
    fs.unlinkSync(previewPath);
  } catch {
    /* ignore */
  }
});

test("half-bound clone without preview is not a valid copy source", () => {
  const novelId = `n-half-${Date.now()}`;
  const characterId = `c-half-${Date.now()}`;
  const missing = resolveCharacterVoicePreviewPath(novelId, characterId);
  assert.equal(fs.existsSync(missing), false);
  assert.throws(
    () => copyCharacterVoicePreviewToRef({ novelId, characterId }),
    /合法 PCM WAV|试听/,
  );
});

test("clone lock gate: only ready (not stale/missing) is allowed", () => {
  const novelId = `n-gate-${Date.now()}`;
  const characterId = `c-gate-${Date.now()}`;
  const previewPath = writeCharacterVoicePreviewFromBase64({
    novelId,
    characterId,
    base64: minimalPcmWavBase64(),
  });
  const sample = "路是自己选的。";
  const designCfg = {
    ttsMode: "design",
    ttsDesignPrompt: "偏低略沙青年男声",
    ttsStyle: "沉稳",
  };
  const fp = buildCharacterVoicePreviewFingerprint(designCfg, sample);
  assert.equal(
    resolveCharacterVoicePreviewStatus({
      audioPath: previewPath,
      fingerprint: fp,
      currentFingerprint: fp,
    }),
    "ready",
  );
  const staleFp = buildCharacterVoicePreviewFingerprint(
    { ...designCfg, ttsDesignPrompt: "完全不同的声线" },
    sample,
  );
  assert.equal(
    resolveCharacterVoicePreviewStatus({
      audioPath: previewPath,
      fingerprint: fp,
      currentFingerprint: staleFp,
    }),
    "stale",
  );
  assert.equal(
    resolveCharacterVoicePreviewStatus({
      audioPath: resolveCharacterVoicePreviewPath("no", "such"),
      fingerprint: fp,
      currentFingerprint: fp,
    }),
    "missing",
  );
  // product gate: lock only when ready
  assert.notEqual(
    resolveCharacterVoicePreviewStatus({
      audioPath: previewPath,
      fingerprint: fp,
      currentFingerprint: staleFp,
    }),
    "ready",
  );

  try {
    fs.unlinkSync(previewPath);
  } catch {
    /* ignore */
  }
});

test("candidate meta fingerprint mismatch is detectable for adopt gate", () => {
  const sample = "谁先认输，谁就先把今晚的话咽回去。";
  const metaFp = buildCharacterVoicePreviewFingerprint(
    { ttsMode: "design", ttsDesignPrompt: "旧设计" },
    sample,
  );
  const currentFp = buildCharacterVoicePreviewFingerprint(
    { ttsMode: "design", ttsDesignPrompt: "新设计" },
    sample,
  );
  assert.notEqual(metaFp, currentFp);
  // service rejects when meta.fingerprint !== current
  assert.equal(Boolean(metaFp && metaFp !== currentFp), true);
});
