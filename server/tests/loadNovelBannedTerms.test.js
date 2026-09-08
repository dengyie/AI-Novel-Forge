const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const { SOP_BANNED_TERMS } = require("@ai-novel/shared/types/styleToneBannedTerms");
const { loadNovelBannedTerms } = require("../dist/services/novel/quality/loadNovelBannedTerms.js");

// 共享书级禁词加载（F5）单测：
// 生成 prompt 与评价 penalize 使用同一 union（SoT ∪ StyleToneSafe），本函数即「同一来源」契约。
// 与 retryTaskClaim.test.js 同约定：stub 共享 prisma 单例，串行（concurrency: false）。

const SOP_SET = [...SOP_BANNED_TERMS];

function makeNovelRow(overrides = {}) {
  return {
    id: "novel-1",
    storyWorldSliceOverridesJson: null,
    storyWorldSliceJson: null,
    styleTone: null,
    ...overrides,
  };
}

test("loadNovelBannedTerms unions SoT ∪ styleTone safe terms and dedupes", { concurrency: false }, async () => {
  const original = prisma.novel.findUnique;
  prisma.novel.findUnique = async () => makeNovelRow({
    storyWorldSliceOverridesJson: JSON.stringify({ sotBannedTerms: ["旧术语甲", "称重"] }),
    storyWorldSliceJson: JSON.stringify({ sotBannedTerms: ["裂空斩", "旧术语甲"] }),
    styleTone: "禁『称重/过秤』族机械度量隐喻概括压迫",
  });

  try {
    const terms = await loadNovelBannedTerms("novel-1");
    // SoT 并集：旧术语甲 ×2 去重、裂空斩、称重
    assert.ok(terms.includes("旧术语甲"), "SoT union 旧术语甲");
    assert.ok(terms.includes("裂空斩"), "SoT slice 裂空斩");
    // styleTone 显式声明抽到 过秤
    assert.ok(terms.includes("过秤"), "styleTone 声明 过秤");
    // 并集去重：称重（SoT 与 styleTone 声明均有）只出现一次
    assert.equal(terms.filter((t) => t === "称重").length, 1);
    assert.equal(terms.filter((t) => t === "旧术语甲").length, 1);
    // SOP 常驻集并集存在
    for (const sopTerm of SOP_SET) {
      assert.ok(terms.includes(sopTerm), `SOP 常驻 ${sopTerm} 在并集中`);
    }
  } finally {
    prisma.novel.findUnique = original;
  }
});

test("loadNovelBannedTerms falls back to SOP set when novel is missing", { concurrency: false }, async () => {
  const original = prisma.novel.findUnique;
  prisma.novel.findUnique = async () => null;

  try {
    const terms = await loadNovelBannedTerms("missing-novel");
    // 与既有 ChapterQualityProjectionService 行语义一致：novel 缺 → SoT 空 ∪ SOP 常驻集。
    // 保持既有行为，不因抽函数引入漂移（任务允许按既有具体行语义 fail-open）。
    for (const sopTerm of SOP_SET) {
      assert.ok(terms.includes(sopTerm), `novel 缺省仍含 SOP 常驻 ${sopTerm}`);
    }
  } finally {
    prisma.novel.findUnique = original;
  }
});