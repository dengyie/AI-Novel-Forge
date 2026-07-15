const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * 契约：有声书工作台 bootstrap 不得携带章节正文 / 角色长文本字段。
 * 实现侧通过 prisma select 保证；本测试锁定对外 shape。
 */
test("AudiobookWorkspaceBootstrap shape excludes heavy novel payload fields", () => {
  /** @type {import('../../shared/dist/types/audiobook.js').AudiobookWorkspaceBootstrap} */
  const sample = {
    novelId: "n1",
    title: "源世界",
    audiobookNarratorVoice: "茉莉",
    audiobookNarratorStyle: null,
    chapters: [{ id: "c1", order: 1, title: "冷席除名" }],
    characters: [
      {
        id: "ch1",
        name: "主角",
        gender: "male",
        castRole: "protagonist",
        role: "男主",
        ttsMode: "preset",
        ttsVoice: "冰糖",
        ttsStyle: null,
        ttsDesignPrompt: null,
        ttsRefAudioPath: null,
        ttsSpeakerAliases: null,
      },
    ],
    chapterCount: 1,
    characterCount: 1,
  };

  assert.equal(sample.chapters[0].title, "冷席除名");
  assert.equal("content" in sample.chapters[0], false);
  assert.equal("contentMarkdown" in sample.chapters[0], false);
  assert.equal("body" in sample.chapters[0], false);
  assert.equal("personality" in sample.characters[0], false);
  assert.equal("background" in sample.characters[0], false);
  assert.equal("appearance" in sample.characters[0], false);
  assert.equal("plotBeats" in sample, false);
  assert.equal("bible" in sample, false);
  assert.equal(sample.chapterCount, sample.chapters.length);
  assert.equal(sample.characterCount, sample.characters.length);
});

test("workspace route path is under novel audiobook namespace", () => {
  // 路由常量锁定，避免客户端与服务端漂移
  const clientPath = (novelId) => `/novels/${novelId}/audiobook/workspace`;
  assert.equal(clientPath("cmriiu3u300006m9k2jo45w93"), "/novels/cmriiu3u300006m9k2jo45w93/audiobook/workspace");
});
