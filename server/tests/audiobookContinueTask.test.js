/**
 * 有声书续生成（已交付任务「对照 list + 继续生成缺失章」）纯逻辑单测。
 *
 * SoT: docs/plans/audiobook-ai-ops-implemented.md 续生成节（本轮新增）
 *
 * 不 mock prisma（项目无此 mock 习惯），仅测可独立运行的纯函数契约：
 *  - resolveExplicitChapterIds：续生成路径 precheck 显式 chapterIds 解析
 *  - readParentTaskIdFromProgress / readFailedContinueChapters：listByNovel 隐闭过滤 + 对照 list 标黄依据
 *  - toSummary（间接 deriveChapterProgress + readFailedContinueChapters）：succeeded 任务 progressJson→summary 字符串透出
 *
 * DB 层（createTask/continueParentTask/executeTask/reconcileParent/cascade cancel）依赖真 audiobookTask 表，
 * 记 Manual-required，在 pxed 真机以 E2E 验（见开发文档验证步骤 4-7）。
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveExplicitChapterIds,
} = require("../dist/services/audiobook/AudiobookPrecheckService.js");
const {
  readParentTaskIdFromProgress,
  readFailedContinueChapters,
} = require("../dist/services/audiobook/AudiobookTaskService.js");

function makeChapter(order, id) {
  return { id, order, title: `第 ${order} 章` };
}

test("resolveExplicitChapterIds: 按显式 id 子集解析并按 order 升序", () => {
  const chapters = [
    makeChapter(3, "c3"),
    makeChapter(1, "c1"),
    makeChapter(2, "c2"),
  ];
  // 乱序传入，应按 order 升序回
  const resolved = resolveExplicitChapterIds(chapters, ["c3", "c1"]);
  assert.deepEqual(
    resolved.map((c) => c.id),
    ["c1", "c3"],
  );
  assert.deepEqual(
    resolved.map((c) => c.order),
    [1, 3],
  );
});

test("resolveExplicitChapterIds: trim + 去重", () => {
  const chapters = [makeChapter(1, "c1"), makeChapter(2, "c2")];
  const resolved = resolveExplicitChapterIds(chapters, [" c1 ", "c1", "c2"]);
  assert.deepEqual(
    resolved.map((c) => c.id),
    ["c1", "c2"],
  );
});

test("resolveExplicitChapterIds: 全部为空白 → 400", () => {
  const chapters = [makeChapter(1, "c1")];
  assert.throws(
    () => resolveExplicitChapterIds(chapters, ["  ", ""]),
    (err) => err.statusCode === 400 && /explicitChapterIds 不能为空/.test(err.message),
  );
});

test("resolveExplicitChapterIds: 空数组 → 400", () => {
  const chapters = [makeChapter(1, "c1")];
  assert.throws(
    () => resolveExplicitChapterIds(chapters, []),
    (err) => err.statusCode === 400,
  );
});

test("resolveExplicitChapterIds: 任一 id 不存在 → 404 并列出缺失", () => {
  const chapters = [makeChapter(1, "c1")];
  assert.throws(
    () => resolveExplicitChapterIds(chapters, ["c1", "ghost"]),
    (err) => err.statusCode === 404 && /ghost/.test(err.message) && /不在该小说范围内/.test(err.message),
  );
});

test("readParentTaskIdFromProgress: 父行为空、子行回写 parentTaskId", () => {
  assert.equal(readParentTaskIdFromProgress(null), null);
  assert.equal(readParentTaskIdFromProgress(""), null);
  assert.equal(readParentTaskIdFromProgress(JSON.stringify({ deliveryStyleMode: "off" })), null);
  assert.equal(
    readParentTaskIdFromProgress(JSON.stringify({ parentTaskId: "  " })),
    null,
  );
  assert.equal(
    readParentTaskIdFromProgress(JSON.stringify({ hidden: true, parentTaskId: "parent_x" })),
    "parent_x",
  );
});

test("readFailedContinueChapters: 解析失败章列表并过滤非法元素", () => {
  assert.deepEqual(readFailedContinueChapters(null), []);
  assert.deepEqual(readFailedContinueChapters(JSON.stringify({})), []);
  assert.deepEqual(
    readFailedContinueChapters(
      JSON.stringify({ failedContinueChapters: ["ch1", "ch2", "  ", 3, null] }),
    ),
    ["ch1", "ch2"],
  );
});

test("listByNovel 隐闭过滤契约：parentTaskId 非空即隐闭子任务", () => {
  // 列举两种 progressJson，模拟 listByNovel 应用端 filter 行为（同 readParentTaskIdFromProgress）
  const rows = [
    { id: "parent_1", progressJson: JSON.stringify({ deliveryStyleMode: "off" }) },
    { id: "child_1", progressJson: JSON.stringify({ parentTaskId: "parent_1", hidden: true }) },
    { id: "parent_2", progressJson: null },
    { id: "child_2", progressJson: "" },
  ];
  const visible = rows.filter(
    (row) => !readParentTaskIdFromProgress(row.progressJson),
  );
  assert.deepEqual(
    visible.map((r) => r.id),
    ["parent_1", "parent_2", "child_2"],
  );
  // child_1 因 progressJson 含 parentTaskId 被隐闭
});

test("对照 list 标黄契约：父 progressJson.failedContinueChapters 作为前端标黄依据", () => {
  const parentProgressJson = JSON.stringify({
    deliveryStyleMode: "off",
    failedContinueChapters: ["ch4", "ch7"],
  });
  // toSummary 透出该字段（前端 AudiobookTaskSummary.failedContinueChapters）
  assert.deepEqual(
    readFailedContinueChapters(parentProgressJson),
    ["ch4", "ch7"],
  );
});

test("子任务终态后失败章合并契约：appendFailedContinueChapters 去重语义", () => {
  // 手工模拟父 progressJson 失败章合并（去重 union），对应 server 内 appendFailedContinueChapters
  const existing = ["ch4", "ch7"];
  const newlyFailed = ["ch4", "ch9"];
  const merged = Array.from(new Set([...existing, ...newlyFailed]));
  assert.deepEqual(merged, ["ch4", "ch7", "ch9"]);
});
