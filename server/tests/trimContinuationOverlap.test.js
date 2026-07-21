const test = require("node:test");
const assert = require("node:assert/strict");

const { trimContinuationOverlap } = require("../dist/services/novel/chapterWritingGraph.js");

test("trimContinuationOverlap keeps line-level alignment working", () => {
  const draftTail = "第一行\n第二行\n第三行";
  const appended = "第二行\n第三行\n新的续写内容";
  assert.equal(trimContinuationOverlap(draftTail, appended), "新的续写内容");
});

test("trimContinuationOverlap returns original when no overlap", () => {
  const draftTail = "完全不同的草稿尾段内容。";
  const appended = "崭新的续写段落，没有任何复读。";
  assert.equal(trimContinuationOverlap(draftTail, appended), appended.trim());
});

test("trimContinuationOverlap falls back to char-level overlap for single-paragraph Chinese prose", () => {
  // 中文整段无换行：行级对齐必然失败，走字符级最长公共后缀/前缀
  const draftTail = "夜色渐深，他推开门看见桌上的信。信纸上只有一行字：别回头。";
  const appended = "信纸上只有一行字：别回头。他握紧信纸，转身走向窗边。";
  assert.equal(trimContinuationOverlap(draftTail, appended), "他握紧信纸，转身走向窗边。");
});

test("trimContinuationOverlap ignores short char overlaps below threshold", () => {
  const draftTail = "他笑了笑。";
  const appended = "他笑了笑，然后离开。";
  // 公共前缀「他笑了笑。」只有 6 字 < 12 阈值，不裁
  assert.equal(trimContinuationOverlap(draftTail, appended), appended.trim());
});

test("trimContinuationOverlap discards fully echoed continuation", () => {
  const draftTail = "这一段足够长的草稿尾内容用来测试完全复读的场景。";
  const appended = "这一段足够长的草稿尾内容用来测试完全复读的场景。";
  assert.equal(trimContinuationOverlap(draftTail, appended), "");
});

test("trimContinuationOverlap handles whitespace between overlapping segments", () => {
  const draftTail = "他推开门看见桌上的信封放在那里不动。";
  const appended = "他推开门看见桌上的信封\n放在那里不动。  他转身离开。";
  const result = trimContinuationOverlap(draftTail, appended);
  assert.equal(result, "他转身离开。");
});
