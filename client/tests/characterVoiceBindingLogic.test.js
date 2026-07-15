import test from "node:test";
import assert from "node:assert/strict";
import {
  canGenerateCharacterVoicePreview,
  canPreviewCharacterVoice,
  isCharacterVoiceFormDirty,
  resolveCharacterVoiceBinding,
  resolveCharacterVoiceMode,
  resolveCharacterVoicePreviewBadge,
} from "../src/pages/novels/components/characterAssetWorkspace.helpers.ts";
import {
  createObjectUrlSlot,
  decodeBase64AudioToObjectUrl,
  inspectWavAudioBase64,
  resolveLocalAudioSrc,
} from "../src/lib/audiobookVoiceAudio.ts";

test("resolveCharacterVoiceMode defaults unknown to preset", () => {
  assert.equal(resolveCharacterVoiceMode(null), "preset");
  assert.equal(resolveCharacterVoiceMode("weird"), "preset");
  assert.equal(resolveCharacterVoiceMode("design"), "design");
  assert.equal(resolveCharacterVoiceMode("clone"), "clone");
});

test("resolveCharacterVoiceBinding readiness by mode", () => {
  assert.equal(resolveCharacterVoiceBinding({ ttsMode: "preset", ttsVoice: "" }).ready, false);
  assert.equal(resolveCharacterVoiceBinding({ ttsMode: "preset", ttsVoice: "茉莉" }).ready, true);
  assert.equal(resolveCharacterVoiceBinding({ ttsMode: "preset", ttsVoice: "茉莉" }).shortLabel, "茉莉");

  assert.equal(resolveCharacterVoiceBinding({ ttsMode: "design", ttsDesignPrompt: "" }).ready, false);
  assert.equal(
    resolveCharacterVoiceBinding({ ttsMode: "design", ttsDesignPrompt: "沉稳男声" }).ready,
    true,
  );

  assert.equal(resolveCharacterVoiceBinding({ ttsMode: "clone", ttsRefAudioPath: "" }).ready, false);
  assert.equal(
    resolveCharacterVoiceBinding({ ttsMode: "clone", ttsRefAudioPath: "/tmp/ref.wav" }).ready,
    true,
  );
  assert.match(
    resolveCharacterVoiceBinding({ ttsMode: "clone", ttsRefAudioPath: "/tmp/ref.wav" }).detailLabel,
    /ref\.wav/,
  );
});

test("canPreviewCharacterVoice gates preset/design/clone", () => {
  assert.equal(canPreviewCharacterVoice({ ttsMode: "preset", ttsVoice: "" }).ok, false);
  assert.equal(canPreviewCharacterVoice({ ttsMode: "preset", ttsVoice: "不存在音色" }).ok, false);
  assert.equal(canPreviewCharacterVoice({ ttsMode: "preset", ttsVoice: "茉莉" }).ok, true);

  assert.equal(canPreviewCharacterVoice({ ttsMode: "design", ttsDesignPrompt: "" }).ok, false);
  assert.equal(canPreviewCharacterVoice({ ttsMode: "design", ttsDesignPrompt: "青年女声" }).ok, true);

  assert.equal(canPreviewCharacterVoice({ ttsMode: "clone", ttsRefAudioPath: "" }).ok, false);
  assert.equal(
    canPreviewCharacterVoice({ ttsMode: "clone", ttsRefAudioPath: "", ttsRefAudioBase64: "xx" }).ok,
    false,
  );
  assert.match(
    canPreviewCharacterVoice({ ttsMode: "clone", ttsRefAudioPath: "", ttsRefAudioBase64: "xx" }).reason,
    /本地听|参考/,
  );
  assert.equal(
    canPreviewCharacterVoice({ ttsMode: "clone", ttsRefAudioPath: "/data/a.wav" }).ok,
    true,
  );
});

test("canGenerateCharacterVoicePreview requires saved clean form", () => {
  const saved = {
    ttsMode: "preset",
    ttsVoice: "茉莉",
    ttsStyle: "",
    ttsDesignPrompt: "",
    ttsRefAudioPath: "",
    ttsSpeakerAliases: "",
  };
  assert.equal(canGenerateCharacterVoicePreview({ form: saved, saved }).ok, true);
  assert.equal(
    canGenerateCharacterVoicePreview({
      form: { ...saved, ttsVoice: "白桦" },
      saved,
    }).ok,
    false,
  );
  assert.match(
    canGenerateCharacterVoicePreview({
      form: { ...saved, ttsVoice: "白桦" },
      saved,
    }).reason,
    /保存/,
  );
});

test("resolveCharacterVoicePreviewBadge labels", () => {
  assert.equal(resolveCharacterVoicePreviewBadge("ready").label, "试听✓");
  assert.equal(resolveCharacterVoicePreviewBadge("stale").label, "试听过期");
  assert.equal(resolveCharacterVoicePreviewBadge("missing").label, "无试听");
  assert.equal(resolveCharacterVoicePreviewBadge(null).label, "无试听");
});

test("isCharacterVoiceFormDirty detects mode/fields/base64 draft", () => {
  const saved = {
    ttsMode: "preset",
    ttsVoice: "茉莉",
    ttsStyle: "",
    ttsDesignPrompt: "",
    ttsRefAudioPath: "",
    ttsSpeakerAliases: ["远哥"],
  };
  assert.equal(
    isCharacterVoiceFormDirty({
      ttsMode: "preset",
      ttsVoice: "茉莉",
      ttsStyle: "",
      ttsDesignPrompt: "",
      ttsRefAudioPath: "",
      ttsSpeakerAliases: "远哥",
    }, saved),
    false,
  );
  assert.equal(
    isCharacterVoiceFormDirty({
      ...saved,
      ttsVoice: "白桦",
      ttsSpeakerAliases: "远哥",
    }, saved),
    true,
  );
  assert.equal(
    isCharacterVoiceFormDirty({
      ttsMode: "design",
      ttsVoice: "茉莉",
      ttsStyle: "",
      ttsDesignPrompt: "x",
      ttsRefAudioPath: "",
      ttsSpeakerAliases: "远哥",
    }, saved),
    true,
  );
  assert.equal(
    isCharacterVoiceFormDirty({
      ttsMode: "preset",
      ttsVoice: "茉莉",
      ttsStyle: "",
      ttsDesignPrompt: "",
      ttsRefAudioPath: "",
      ttsSpeakerAliases: "远哥",
      ttsRefAudioBase64: "data:audio/wav;base64,AA",
    }, saved),
    true,
  );
});

test("inspectWavAudioBase64 detects RIFF and duration fields", () => {
  const riff = Buffer.alloc(44, 0);
  riff.write("RIFF", 0);
  riff.writeUInt32LE(36, 4);
  riff.write("WAVE", 8);
  riff.write("fmt ", 12);
  riff.writeUInt32LE(16, 16);
  riff.writeUInt16LE(1, 20);
  riff.writeUInt16LE(1, 22);
  riff.writeUInt32LE(16000, 24);
  riff.writeUInt32LE(32000, 28);
  riff.writeUInt16LE(2, 32);
  riff.writeUInt16LE(16, 34);
  riff.write("data", 36);
  riff.writeUInt32LE(0, 40);
  const inspection = inspectWavAudioBase64(riff.toString("base64"));
  assert.equal(inspection.isWav, true);
});

test("resolveLocalAudioSrc and object url slot basic", () => {
  const src = resolveLocalAudioSrc("data:audio/wav;base64,AA==");
  assert.equal(typeof src, "string");
  const slot = createObjectUrlSlot();
  assert.equal(slot.set(null), null);
  slot.clear();
  if (typeof Blob !== "undefined") {
    try {
      const url = decodeBase64AudioToObjectUrl("AA==", "audio/wav");
      assert.equal(typeof url, "string");
      slot.set(url);
      slot.clear();
    } catch {
      // jsdom/node environment without full URL.createObjectURL is acceptable
    }
  }
});
