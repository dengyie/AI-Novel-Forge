/**
 * Milestone F: VOICE_LIBRARY_APPROVE_TOKEN gate for approved elevation.
 */
const { describe, it, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const ORIGINAL = process.env.VOICE_LIBRARY_APPROVE_TOKEN;

const {
  assertVoiceLibraryApproveToken,
  resolveVoiceLibraryApproveToken,
} = require("../dist/services/audiobook/voiceLibraryApproveGate");

describe("voiceLibraryApproveGate", () => {
  beforeEach(() => {
    delete process.env.VOICE_LIBRARY_APPROVE_TOKEN;
  });

  after(() => {
    if (ORIGINAL === undefined) {
      delete process.env.VOICE_LIBRARY_APPROVE_TOKEN;
    } else {
      process.env.VOICE_LIBRARY_APPROVE_TOKEN = ORIGINAL;
    }
  });

  it("未设置 env：approved 不要求 token", () => {
    assert.equal(resolveVoiceLibraryApproveToken(), null);
    assert.doesNotThrow(() =>
      assertVoiceLibraryApproveToken({ nextStatus: "approved", headerToken: null }),
    );
    assert.doesNotThrow(() =>
      assertVoiceLibraryApproveToken({ nextStatus: "draft", headerToken: null }),
    );
  });

  it("设置 env：approved 缺/错 token → 403；正确 token 通过；draft 不要求", () => {
    process.env.VOICE_LIBRARY_APPROVE_TOKEN = "secret-approve-token";
    assert.equal(resolveVoiceLibraryApproveToken(), "secret-approve-token");

    assert.throws(
      () =>
        assertVoiceLibraryApproveToken({
          nextStatus: "approved",
          headerToken: null,
        }),
      (err) => err?.statusCode === 403 || /Approve-Token|approved/.test(String(err?.message || err)),
    );
    assert.throws(
      () =>
        assertVoiceLibraryApproveToken({
          nextStatus: "approved",
          headerToken: "wrong",
        }),
      (err) => err?.statusCode === 403 || /Approve-Token|approved/.test(String(err?.message || err)),
    );
    assert.doesNotThrow(() =>
      assertVoiceLibraryApproveToken({
        nextStatus: "approved",
        headerToken: "secret-approve-token",
      }),
    );
    assert.doesNotThrow(() =>
      assertVoiceLibraryApproveToken({
        nextStatus: "archived",
        headerToken: null,
      }),
    );
  });
});
