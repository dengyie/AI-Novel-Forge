const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AUDIOBOOK_CHUNK_MAX_CHARS,
  MIMO_TTS_PRESET_VOICES,
  isMimoTtsPresetVoice,
  DEFAULT_AUDIOBOOK_NARRATOR_VOICE,
} = require("../../shared/dist/types/audiobook.js");
const { splitTextForTts } = require("../dist/services/audiobook/audiobookChunk.js");

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
});
