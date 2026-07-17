/**
 * media path 白名单：token 模式下 <audio>?access= 须能进路由。
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { isAudiobookMediaPath } = require("../dist/middleware/auth");

describe("isAudiobookMediaPath", () => {
  it("放行 task / character_preview / voice-library audio", () => {
    assert.equal(
      isAudiobookMediaPath({
        originalUrl: "/api/novels/audiobook/tasks/t1/audio/full?access=x",
        url: "/api/novels/audiobook/tasks/t1/audio/full?access=x",
      }),
      true,
    );
    assert.equal(
      isAudiobookMediaPath({
        originalUrl: "/api/novels/n1/characters/c1/voice-preview/audio?access=y",
        url: "/api/novels/n1/characters/c1/voice-preview/audio?access=y",
      }),
      true,
    );
    assert.equal(
      isAudiobookMediaPath({
        originalUrl: "/api/novels/audiobook/voice-library/asset-1/audio?access=z",
        url: "/api/novels/audiobook/voice-library/asset-1/audio?access=z",
      }),
      true,
    );
  });

  it("拒绝非媒体路径", () => {
    assert.equal(
      isAudiobookMediaPath({
        originalUrl: "/api/novels/audiobook/voice-library/asset-1/media-access",
        url: "/api/novels/audiobook/voice-library/asset-1/media-access",
      }),
      false,
    );
    assert.equal(
      isAudiobookMediaPath({
        originalUrl: "/api/novels/audiobook/voice-library/asset-1/status",
        url: "/api/novels/audiobook/voice-library/asset-1/status",
      }),
      false,
    );
  });
});
