const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveVoiceBindingStatus,
  resolveReadinessAction,
  buildCharacterReadinessItem,
  aggregateVoiceReadinessSummary,
  toBootstrapReadiness,
  buildVoiceDetailLabel,
} = require("../dist/services/audiobook/characterVoiceReadiness.js");

test("resolveVoiceBindingStatus: preset missing / invalid / configured", () => {
  assert.equal(
    resolveVoiceBindingStatus({ ttsMode: "preset", ttsVoice: "", refAudioOk: null }).status,
    "missing",
  );
  assert.equal(
    resolveVoiceBindingStatus({ ttsMode: "preset", ttsVoice: "不存在", refAudioOk: null }).status,
    "invalid",
  );
  assert.equal(
    resolveVoiceBindingStatus({ ttsMode: "preset", ttsVoice: "白桦", refAudioOk: null }).status,
    "configured",
  );
});

test("resolveVoiceBindingStatus: design / clone paths", () => {
  assert.equal(
    resolveVoiceBindingStatus({ ttsMode: "design", ttsDesignPrompt: "", refAudioOk: null }).status,
    "missing",
  );
  assert.equal(
    resolveVoiceBindingStatus({
      ttsMode: "design",
      ttsDesignPrompt: "低沉男声",
      refAudioOk: null,
    }).status,
    "configured",
  );
  assert.equal(
    resolveVoiceBindingStatus({ ttsMode: "clone", ttsRefAudioPath: "", refAudioOk: null }).status,
    "missing",
  );
  assert.equal(
    resolveVoiceBindingStatus({
      ttsMode: "clone",
      ttsRefAudioPath: "/tmp/a.wav",
      refAudioOk: false,
    }).status,
    "invalid",
  );
  assert.equal(
    resolveVoiceBindingStatus({
      ttsMode: "clone",
      ttsRefAudioPath: "/tmp/a.wav",
      refAudioOk: true,
    }).status,
    "configured",
  );
  assert.equal(
    resolveVoiceBindingStatus({ ttsMode: "weird", ttsVoice: "x", refAudioOk: null }).status,
    "invalid",
  );
});

test("resolveReadinessAction pure matrix", () => {
  assert.equal(resolveReadinessAction("invalid", "clone", "missing"), "manual_clone");
  assert.equal(resolveReadinessAction("invalid", "preset", "missing"), "fix_invalid");
  assert.equal(resolveReadinessAction("missing", "clone", "missing"), "manual_clone");
  assert.equal(resolveReadinessAction("missing", "preset", "missing"), "apply_plan");
  assert.equal(resolveReadinessAction("configured", "preset", "ready"), "none");
  assert.equal(resolveReadinessAction("configured", "preset", "stale"), "generate_preview");
  assert.equal(resolveReadinessAction("configured", "preset", "missing"), "generate_preview");
});

test("buildCharacterReadinessItem + aggregate summary flags", () => {
  const missing = buildCharacterReadinessItem({
    characterId: "c1",
    characterName: "甲",
    ttsMode: "preset",
    ttsVoice: "",
    refAudioOk: null,
    previewStatus: "missing",
  });
  assert.equal(missing.voiceBindingStatus, "missing");
  assert.equal(missing.action, "apply_plan");
  assert.equal(missing.blocksTask, true);
  assert.equal(missing.blocksReadyPreview, false);

  const ready = buildCharacterReadinessItem({
    characterId: "c2",
    characterName: "乙",
    ttsMode: "preset",
    ttsVoice: "茉莉",
    refAudioOk: null,
    previewStatus: "ready",
  });
  assert.equal(ready.voiceBindingStatus, "configured");
  assert.equal(ready.action, "none");
  assert.equal(ready.blocksTask, false);
  assert.equal(ready.blocksReadyPreview, false);

  const stale = buildCharacterReadinessItem({
    characterId: "c3",
    characterName: "丙",
    ttsMode: "preset",
    ttsVoice: "白桦",
    refAudioOk: null,
    previewStatus: "stale",
  });
  assert.equal(stale.action, "generate_preview");
  assert.equal(stale.blocksReadyPreview, true);

  const cloneManual = buildCharacterReadinessItem({
    characterId: "c4",
    characterName: "丁",
    ttsMode: "clone",
    ttsRefAudioPath: "",
    refAudioOk: null,
    previewStatus: "missing",
  });
  assert.equal(cloneManual.action, "manual_clone");

  const summary = aggregateVoiceReadinessSummary({
    novelId: "n1",
    narratorVoice: "茉莉",
    narratorStyle: "旁白",
    items: [missing, ready, stale, cloneManual],
  });
  assert.equal(summary.characterTotal, 4);
  assert.equal(summary.voiceConfigured, 2);
  assert.equal(summary.voiceMissing, 2);
  assert.equal(summary.previewReady, 1);
  assert.equal(summary.previewStale, 1);
  assert.equal(summary.previewMissing, 0);
  assert.equal(summary.voiceOk, false);
  assert.equal(summary.previewOk, false);
  assert.equal(summary.readyForWorkbench, false);
  assert.equal(summary.narrator.valid, true);

  const boot = toBootstrapReadiness(summary, "job-1");
  assert.equal(boot.activeReadinessJobId, "job-1");
  assert.equal(boot.attentionItems.length >= 1, true);
  assert.equal(
    boot.attentionItems.every((item) => item.action !== "none"),
    true,
  );
});

test("buildVoiceDetailLabel covers main modes", () => {
  assert.equal(
    buildVoiceDetailLabel({ binding: "missing", mode: "preset" }),
    "preset·未配音色",
  );
  assert.equal(
    buildVoiceDetailLabel({ binding: "configured", mode: "preset", ttsVoice: "白桦" }),
    "preset/白桦",
  );
  assert.equal(
    buildVoiceDetailLabel({ binding: "configured", mode: "clone" }),
    "clone",
  );
});

test("aggregate: empty cast is voiceOk if narrator valid; previewOk true", () => {
  const summary = aggregateVoiceReadinessSummary({
    novelId: "n-empty",
    narratorVoice: "茉莉",
    items: [],
  });
  assert.equal(summary.voiceOk, true);
  assert.equal(summary.previewOk, true);
  assert.equal(summary.readyForWorkbench, true);
  assert.equal(summary.warnings.some((w) => w.includes("尚无角色")), true);
});

test("aggregate: invalid narrator fails voiceOk", () => {
  const summary = aggregateVoiceReadinessSummary({
    novelId: "n2",
    narratorVoice: "不存在的旁白",
    items: [],
  });
  assert.equal(summary.voiceOk, false);
  assert.equal(summary.narrator.valid, false);
  assert.equal(summary.blockingErrors.length >= 1, true);
});

test("resolveVoiceBindingStatus: clone + assetId only", () => {
  assert.equal(
    resolveVoiceBindingStatus({
      ttsMode: "clone",
      ttsVoiceAssetId: "va_abc",
      refAudioOk: null,
    }).status,
    "configured",
  );
  assert.equal(
    resolveVoiceBindingStatus({
      ttsMode: "clone",
      ttsVoiceAssetId: "va_abc",
      refAudioOk: true,
    }).status,
    "configured",
  );
  assert.equal(
    resolveVoiceBindingStatus({
      ttsMode: "clone",
      ttsVoiceAssetId: "va_abc",
      refAudioOk: false,
    }).status,
    "invalid",
  );
  assert.equal(
    resolveVoiceBindingStatus({
      ttsMode: "clone",
      ttsRefAudioPath: "",
      ttsVoiceAssetId: "",
      refAudioOk: null,
    }).status,
    "missing",
  );
});

test("buildCharacterReadinessItem passes assetId into binding resolve", () => {
  const item = buildCharacterReadinessItem({
    characterId: "c-asset",
    characterName: "库绑",
    ttsMode: "clone",
    ttsVoiceAssetId: "va_xyz",
    refAudioOk: null,
    previewStatus: "missing",
  });
  assert.equal(item.voiceBindingStatus, "configured");
  assert.equal(item.ttsVoiceAssetId, "va_xyz");
  assert.equal(item.action, "generate_preview");
});

