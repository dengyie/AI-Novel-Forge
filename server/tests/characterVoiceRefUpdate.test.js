/**
 * Milestone C harden: character voice ref update decision must not drop base64
 * when ttsVoiceAssetId is explicitly null (upload overrides library bind).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  decideCharacterVoiceRefUpdate,
} = require("../dist/services/novel/characterVoiceRefUpdate");

describe("decideCharacterVoiceRefUpdate", () => {
  it("bind wins over base64 when assetId is non-empty", () => {
    assert.deepEqual(
      decideCharacterVoiceRefUpdate({
        ttsVoiceAssetId: "va_approved01",
        ttsRefAudioBase64: "QQ==",
      }),
      { action: "bind", voiceAssetId: "va_approved01" },
    );
  });

  it("base64 write is not short-circuited by assetId null", () => {
    assert.deepEqual(
      decideCharacterVoiceRefUpdate({
        ttsVoiceAssetId: null,
        ttsRefAudioBase64: "  AA==  ",
      }),
      { action: "write_base64", base64: "AA==" },
    );
  });

  it("base64 alone writes without requiring assetId field", () => {
    assert.deepEqual(
      decideCharacterVoiceRefUpdate({
        ttsRefAudioBase64: "QQ==",
      }),
      { action: "write_base64", base64: "QQ==" },
    );
  });

  it("assetId null without base64 only clears asset", () => {
    assert.deepEqual(
      decideCharacterVoiceRefUpdate({
        ttsVoiceAssetId: null,
        ttsRefAudioBase64: "",
      }),
      { action: "clear_asset" },
    );
  });

  it("whitespace assetId is ignored in favor of base64", () => {
    assert.deepEqual(
      decideCharacterVoiceRefUpdate({
        ttsVoiceAssetId: "   ",
        ttsRefAudioBase64: "QQ==",
      }),
      { action: "write_base64", base64: "QQ==" },
    );
  });

  it("no voice ref fields → none", () => {
    assert.deepEqual(decideCharacterVoiceRefUpdate({}), { action: "none" });
    assert.deepEqual(
      decideCharacterVoiceRefUpdate({
        ttsVoiceAssetId: undefined,
        ttsRefAudioBase64: "  ",
      }),
      { action: "none" },
    );
  });
});
