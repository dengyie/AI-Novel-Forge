import test from "node:test";
import assert from "node:assert/strict";
import {
  canPreviewCharacterVoice,
  isCharacterVoiceFormDirty,
  resolveCharacterVoiceBinding,
  resolveCharacterVoiceMode,
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
    /本地试听/,
  );
  assert.equal(
    canPreviewCharacterVoice({ ttsMode: "clone", ttsRefAudioPath: "/data/a.wav" }).ok,
    true,
  );
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
      ttsRefAudioBase64: "data:audio/wav;base64,AA==",
    }, saved),
    true,
  );
});

function makePcmWavBase64({ dataBytes, sampleRate = 24000 }) {
  const channels = 1;
  const bits = 16;
  const byteRate = sampleRate * channels * (bits / 8);
  const blockAlign = channels * (bits / 8);
  const fmtSize = 16;
  const riffSize = 4 + (8 + fmtSize) + (8 + dataBytes);
  const buf = Buffer.alloc(12 + 8 + fmtSize + 8 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(riffSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(fmtSize, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf.toString("base64");
}

test("audiobookVoiceAudio local src and object url slot", () => {
  assert.equal(resolveLocalAudioSrc(""), "");
  assert.equal(resolveLocalAudioSrc("data:audio/wav;base64,abc"), "data:audio/wav;base64,abc");
  assert.equal(resolveLocalAudioSrc("abc"), "data:audio/wav;base64,abc");

  assert.throws(() => decodeBase64AudioToObjectUrl(Buffer.from("hello-audio").toString("base64")), /WAV|短|解码|无效/);

  const b64 = makePcmWavBase64({ dataBytes: 48000 });
  const url1 = decodeBase64AudioToObjectUrl(b64, "audio/wav");
  const url2 = decodeBase64AudioToObjectUrl(`data:audio/wav;base64,${b64}`, "audio/wav");
  assert.match(url1, /^blob:/);
  assert.match(url2, /^blob:/);

  const slot = createObjectUrlSlot();
  assert.equal(slot.get(), null);
  assert.equal(slot.set(url1), url1);
  assert.equal(slot.get(), url1);
  // replace revokes previous; should not throw
  assert.equal(slot.set(url2), url2);
  assert.equal(slot.get(), url2);
  slot.clear();
  assert.equal(slot.get(), null);
  // double clear is safe
  slot.clear();
});


test("inspectWavAudioBase64 rejects empty/non-wav and accepts minimal pcm wav", () => {
  assert.equal(inspectWavAudioBase64("").isWav, false);
  assert.match(inspectWavAudioBase64("").reason || "", /空|解码|短/);

  const short = inspectWavAudioBase64(makePcmWavBase64({ dataBytes: 480 })); // 0.01s
  assert.equal(short.isWav, true);
  assert.ok(short.reason);

  const ok = inspectWavAudioBase64(makePcmWavBase64({ dataBytes: 48000 })); // 1.0s
  assert.equal(ok.isWav, true);
  assert.equal(ok.reason, undefined);
  assert.ok(Math.abs((ok.durationSec ?? 0) - 1) < 0.001);
  const url = decodeBase64AudioToObjectUrl(makePcmWavBase64({ dataBytes: 48000 }));
  assert.match(url, /^blob:/);
});
