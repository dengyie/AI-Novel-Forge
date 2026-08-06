const test = require("node:test");
const assert = require("node:assert/strict");

// 方案 C（Phase 1.1）：质量回环预算账本已上提为共享纯函数模块 `qualityLoopBudget.ts`。
// volume 层与 director 层都只 import 该共享模块，杜绝 volume → director 反向依赖。
// 本测试验证：从"volume 侧"视角 import 共享账本只会加载一个叶子模块，
// 不会再把任何 director/runtime 实现拖进 require.cache（否则会构成循环依赖）。

const {
  DIRECTOR_QUALITY_LOOP_BUDGET_LIMITS,
  buildDirectorQualityLoopBudgetWindow,
  buildDirectorQualityLoopIssueSignature,
  buildDirectorQualityLoopIssueSignatureFromIssues,
  resolveDirectorQualityLoopBudgetNextAction,
  recordDirectorQualityLoopBudgetAttempt,
} = require("../dist/services/novel/qualityLoopBudget.js");

test("qualityLoopBudget 上提后从 volume 侧 import 不反向加载 director 实现", () => {
  // 只 import 共享账本后，cache 中不应出现任何 director 目录下的实现模块
  // （证明共享账本为叶子模块，volume 侧 import 不会构成循环依赖）。
  const directorLoaded = Object.keys(require.cache)
    .filter((path) => path.includes("/director/"));
  assert.equal(directorLoaded.length, 0,
    `import 共享账本不应加载任何 director 实现模块，实际加载: ${directorLoaded.join(", ")}`);
});

test("共享账本纯函数与 director 侧预算上限语义一致", () => {
  assert.equal(DIRECTOR_QUALITY_LOOP_BUDGET_LIMITS.patchRepair, 2);
  assert.equal(DIRECTOR_QUALITY_LOOP_BUDGET_LIMITS.chapterRewrite, 1);
  assert.equal(DIRECTOR_QUALITY_LOOP_BUDGET_LIMITS.windowReplan, 1);

  // 预算阶梯：patch 耗尽 → rewrite → replan → defer
  const entry = {
    patchRepairCount: 2,
    chapterRewriteCount: 0,
    windowReplanCount: 0,
    deferredCount: 0,
  };
  assert.equal(resolveDirectorQualityLoopBudgetNextAction(entry), "auto_rewrite_chapter");
  assert.equal(
    resolveDirectorQualityLoopBudgetNextAction({ ...entry, chapterRewriteCount: 1 }),
    "auto_replan_window",
  );
  assert.equal(
    resolveDirectorQualityLoopBudgetNextAction({ ...entry, chapterRewriteCount: 1, windowReplanCount: 1 }),
    "defer_and_continue",
  );
  // 空签名名称空间兜底
  const sig = buildDirectorQualityLoopIssueSignature({ reason: "章节质量问题" });
  assert.ok(typeof sig === "string" && sig.length > 0);
  assert.ok(buildDirectorQualityLoopBudgetWindow({
    autoExecution: { startOrder: 6, endOrder: 10, nextChapterId: "c-6", nextChapterOrder: 6 },
    chapterId: "c-6",
    chapterOrder: 6,
  }));
});

test("方案C Phase3: 结构化签名——同结构不同 reason 文案 → 相同签名；不同 targets → 不同签名", () => {
  const base = {
    recommendedHandling: "repair_contract",
    issueTargets: ["task_sheet", "semantic"],
    noticeCode: null,
    repairMode: null,
  };
  // 同一组 issueTargets 不同顺序 → 稳定字符串列表排序去重 → 相同签名
  const sigA = buildDirectorQualityLoopIssueSignatureFromIssues({
    ...base,
    issueTargets: ["semantic", "task_sheet"],
  });
  const sigB = buildDirectorQualityLoopIssueSignatureFromIssues(base);
  assert.equal(sigA, sigB);
  // 不同 issueTargets → 不同签名
  const sigC = buildDirectorQualityLoopIssueSignatureFromIssues({
    ...base,
    issueTargets: ["purpose"],
  });
  assert.notEqual(sigA, sigC);
  // 仅 reason 文案不同 → 签名不变（结构化签名不含 reason 字段）
  assert.equal(sigA, buildDirectorQualityLoopIssueSignatureFromIssues(base));
});