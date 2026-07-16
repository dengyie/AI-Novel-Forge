const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MIMO_TTS_MODELS,
} = require("../../shared/dist/types/audiobook.js");
const {
  buildMimoTtsRequestBody,
} = require("../dist/services/audiobook/MimoChatAudioTTSProvider.js");
const {
  planCharacterVoices,
} = require("../dist/services/audiobook/audiobookVoicePlanner.js");

test("buildMimoTtsRequestBody design omits audio.voice", () => {
  const body = buildMimoTtsRequestBody({
    text: "固定试听校准句。",
    mode: "design",
    designPrompt: "青年女声，清亮不尖",
  });
  assert.equal(body.model, MIMO_TTS_MODELS.design);
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages[0].content, "青年女声，清亮不尖");
  assert.equal(Object.prototype.hasOwnProperty.call(body.audio, "voice"), false);
});

test("buildMimoTtsRequestBody preset includes voice", () => {
  const body = buildMimoTtsRequestBody({
    text: "固定试听校准句。",
    mode: "preset",
    voice: "白桦",
    style: "沉稳",
  });
  assert.equal(body.model, MIMO_TTS_MODELS.preset);
  assert.equal(body.audio.voice, "白桦");
});

test("prefer_design plan items build valid Mimo design request bodies", () => {
  const { items } = planCharacterVoices({
    onlyMissing: false,
    strategy: "prefer_design",
    characters: [
      {
        characterId: "a",
        characterName: "何屿",
        gender: "male",
        castRole: "protagonist",
        voiceTexture: "青年男性，声线沉稳略沙哑",
      },
      {
        characterId: "b",
        characterName: "林婉",
        gender: "female",
        castRole: "love_interest",
        personality: "清亮克制",
      },
    ],
  });

  assert.equal(items.length, 2);
  for (const item of items) {
    assert.equal(item.ttsMode, "design");
    assert.ok(item.ttsDesignPrompt && item.ttsDesignPrompt.length >= 24);
    assert.ok(item.ttsDesignPrompt.length <= 480);
    const body = buildMimoTtsRequestBody({
      text: "固定试听校准句。",
      mode: "design",
      designPrompt: item.ttsDesignPrompt,
    });
    assert.equal(body.model, MIMO_TTS_MODELS.design);
    assert.equal(body.messages[0].role, "user");
    assert.equal(body.messages[0].content, item.ttsDesignPrompt);
    assert.equal(Object.prototype.hasOwnProperty.call(body.audio, "voice"), false);
  }
});
