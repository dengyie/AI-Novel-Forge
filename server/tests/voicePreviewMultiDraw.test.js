const test = require("node:test");
const assert = require("node:assert/strict");

const {
  pickMedianDurationCandidateIndex,
  assertMultiDrawAdoptedForCloneLock,
  DEFAULT_PREVIEW_CANDIDATES,
  MAX_PREVIEW_CANDIDATES,
} = require("../dist/services/audiobook/AudiobookVoiceAssetService.js");

const {
  resolveCharacterVoicePreviewCandidatePath,
  resolveCharacterVoicePreviewCandidatesMetaPath,
} = require("../dist/services/audiobook/audiobookPaths.js");

const {
  buildCharacterVoicePreviewFingerprint,
} = require("../dist/services/audiobook/characterVoicePreview.js");

test("pickMedianDurationCandidateIndex picks median of valid durations", () => {
  assert.equal(pickMedianDurationCandidateIndex([1000, 2000, 3000]), 1);
  assert.equal(pickMedianDurationCandidateIndex([3000, 1000, 2000]), 2);
  assert.equal(pickMedianDurationCandidateIndex([0, 1000, 2000]), 1);
  assert.equal(pickMedianDurationCandidateIndex([0, 0, 0]), 0);
  assert.equal(pickMedianDurationCandidateIndex([]), 0);
});

test("preview candidate path helpers are stable", () => {
  const p0 = resolveCharacterVoicePreviewCandidatePath("novelA", "charB", 0);
  const p1 = resolveCharacterVoicePreviewCandidatePath("novelA", "charB", 1);
  assert.match(p0, /preview-candidate-0\.wav$/);
  assert.match(p1, /preview-candidate-1\.wav$/);
  assert.notEqual(p0, p1);
  const meta = resolveCharacterVoicePreviewCandidatesMetaPath("novelA", "charB");
  assert.match(meta, /preview-candidates\.json$/);
});

test("default multi-draw constants", () => {
  assert.equal(DEFAULT_PREVIEW_CANDIDATES, 3);
  assert.equal(MAX_PREVIEW_CANDIDATES, 5);
});

test("adopt fingerprint uses same builder as multi-draw meta", () => {
  const sample = "路是自己选的，就不必再回头望。";
  const cfg = {
    ttsMode: "design",
    ttsDesignPrompt: "中音中性干净声线",
    ttsStyle: null,
    ttsVoice: null,
    ttsRefAudioPath: null,
  };
  const a = buildCharacterVoicePreviewFingerprint(cfg, sample);
  const b = buildCharacterVoicePreviewFingerprint(cfg, sample);
  assert.equal(a, b);
  assert.equal(a.length, 64);
});

test("assertMultiDrawAdoptedForCloneLock blocks unadopted multi-draw", () => {
  const fp = "a".repeat(64);
  assert.doesNotThrow(() => assertMultiDrawAdoptedForCloneLock(null, fp));
  assert.doesNotThrow(() =>
    assertMultiDrawAdoptedForCloneLock(
      {
        sampleText: "x",
        fingerprint: fp,
        createdAt: new Date().toISOString(),
        candidates: [{ id: "c0", index: 0, path: "/tmp/c0.wav", durationMs: 1000 }],
        suggestedCandidateId: "c0",
        adoptedCandidateId: null,
      },
      fp,
    ),
  );
  assert.throws(
    () =>
      assertMultiDrawAdoptedForCloneLock(
        {
          sampleText: "x",
          fingerprint: fp,
          createdAt: new Date().toISOString(),
          candidates: [
            { id: "c0", index: 0, path: "/tmp/c0.wav", durationMs: 1000 },
            { id: "c1", index: 1, path: "/tmp/c1.wav", durationMs: 1100 },
          ],
          suggestedCandidateId: "c0",
          adoptedCandidateId: null,
        },
        fp,
      ),
    /未采用的多抽候选/,
  );
  assert.doesNotThrow(() =>
    assertMultiDrawAdoptedForCloneLock(
      {
        sampleText: "x",
        fingerprint: fp,
        createdAt: new Date().toISOString(),
        candidates: [
          { id: "c0", index: 0, path: "/tmp/c0.wav", durationMs: 1000 },
          { id: "c1", index: 1, path: "/tmp/c1.wav", durationMs: 1100 },
        ],
        suggestedCandidateId: "c0",
        adoptedCandidateId: "c1",
      },
      fp,
    ),
  );
  // stale multi-draw meta (config changed) → defer to ready/stale gate
  assert.doesNotThrow(() =>
    assertMultiDrawAdoptedForCloneLock(
      {
        sampleText: "x",
        fingerprint: "b".repeat(64),
        createdAt: new Date().toISOString(),
        candidates: [
          { id: "c0", index: 0, path: "/tmp/c0.wav", durationMs: 1000 },
          { id: "c1", index: 1, path: "/tmp/c1.wav", durationMs: 1100 },
        ],
        suggestedCandidateId: "c0",
        adoptedCandidateId: null,
      },
      fp,
    ),
  );
});
