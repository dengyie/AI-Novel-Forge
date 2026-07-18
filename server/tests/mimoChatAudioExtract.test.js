const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractAudioBase64,
} = require("../dist/services/audiobook/MimoChatAudioTTSProvider.js");

// 构造一个最小 RIFF/WAVE base64：RIFF....WAVE
const wavBase64 = Buffer.from(
  "RIFF\x00\x00\x00\x00WAVEfmt ",
).toString("base64");

test("extractAudioBase64 prefers message.audio.data when present", () => {
  const out = extractAudioBase64({
    choices: [
      {
        message: {
          audio: { data: wavBase64 },
          content: "UklGR不应该被采信",
        },
      },
    ],
  });
  assert.equal(out, wavBase64);
});

test("extractAudioBase64 falls back to content only when decodable RIFF/WAVE", () => {
  const out = extractAudioBase64({
    choices: [{ message: { content: wavBase64 } }],
  });
  assert.equal(out, wavBase64);
});

test("extractAudioBase64 rejects content that merely starts with UklGR but is not RIFF/WAVE", () => {
  // UklGR 是 "RIFF" 的 base64 前 4 字节；构造一段以 UklGR 开头但解码后非 RIFF 的内容
  const fakePrefix = "UklGR" + Buffer.from("NOTAWAVEFILE").toString("base64");
  const out = extractAudioBase64({
    choices: [{ message: { content: fakePrefix } }],
  });
  assert.equal(out, null);
});

test("extractAudioBase64 returns null on empty/invalid payload", () => {
  assert.equal(extractAudioBase64(null), null);
  assert.equal(extractAudioBase64({}), null);
  assert.equal(extractAudioBase64({ choices: [] }), null);
  assert.equal(
    extractAudioBase64({ choices: [{ message: { content: "普通文本" } }] }),
    null,
  );
});
