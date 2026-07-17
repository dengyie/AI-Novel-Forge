const test = require("node:test");
const assert = require("node:assert/strict");

const {
  pickMedianDurationCandidateIndex,
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
