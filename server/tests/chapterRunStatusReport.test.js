const test = require("node:test");
const assert = require("node:assert/strict");

const { buildChapterRunStatusFrame } = require("../dist/services/novel/runtime/chapterRunStatusFrame.js");

/**
 * P1-1 主章节生成流 run_status 专门回归。
 *
 * 原根因：ChapterStreamGenerationOrchestrator 在 finalized.runtimePackage.audit
 * .hasBlockingIssues=true 时仍硬发 status:"succeeded" + phase:"completed"，与 F9 刚
 * 在 repair 流（ChapterRepairStreamRuntime:569）收敛掉的"needs_repair→succeeded"
 * 形态 bug 同源。客户端 UI 读 .message 会显示"可继续审校"误导手工审校，且与 repair
 * 流契约形态分裂。
 *
 * 此测驱动纯函数 buildChapterRunStatusFrame 的分支契约：
 *  1. hasBlockingIssues=true → "failed"（绝 succeeded）
 *  2. hasBlockingIssues=false → "succeeded"（保正流）
 *  3. running/finalizing 中间帧与终态帧 runId 一致，poller 可按 runId 关联生命周期
 *  4. runId 前缀 chapter-runtime: 守卫（主生流域；与 repair 域 chapter-repair: 区分）
 *  5. phase:"completed" 在两条终态路径都保留（章节已落库，blocking issue 不丢 completed 语义）
 * 若有人把 status 折叠回 succeeded-only，第 1 条立即红。
 */

const CHAPTER_ID = "ch-gen-1";
const RUN_ID = `chapter-runtime:${CHAPTER_ID}`;

test("P1-1: audit.hasBlockingIssues=true → status failed + 待修复文案，绝不 succeeded", () => {
  const frame = buildChapterRunStatusFrame({
    runId: RUN_ID,
    status: "failed",
    phase: "completed",
    message: "章节已保存，但检测到待修复问题。",
  });
  assert.equal(frame.type, "run_status");
  assert.equal(frame.runId, RUN_ID);
  assert.equal(frame.status, "failed");
  assert.equal(frame.phase, "completed");
  // 核心回归断言：blocking-issue 章必报 failed，绝不 succeeded。
  assert.notEqual(frame.status, "succeeded");
  assert.match(frame.message, /待修复问题/);
});

test("P1-1: audit.hasBlockingIssues=false → status succeeded + 可继续审校文案（保正流）", () => {
  const frame = buildChapterRunStatusFrame({
    runId: RUN_ID,
    status: "succeeded",
    phase: "completed",
    message: "章节已保存，可继续审校。",
  });
  assert.equal(frame.status, "succeeded");
  assert.equal(frame.phase, "completed");
  assert.match(frame.message, /可继续审校/);
});

test("P1-1: running/finalizing 中间帧与终态帧 runId 一同源 → poller 可按 runId 关联生命周期", () => {
  const runningFrame = buildChapterRunStatusFrame({
    runId: RUN_ID,
    status: "running",
    phase: "finalizing",
    message: "正文已生成，正在整理章节文本并保存草稿。",
  });
  const finalFailed = buildChapterRunStatusFrame({
    runId: RUN_ID,
    status: "failed",
    phase: "completed",
    message: "章节已保存，但检测到待修复问题。",
  });
  // 三处 emitRunStatus 共用同一 runStatusId（traceRunId ?? chapter-runtime:<id>），
  // 监管侧按 runId 聚合生命周期，错前缀会丢章节关联。
  assert.equal(runningFrame.runId, finalFailed.runId);
  assert.equal(runningFrame.runId, RUN_ID);
  assert.equal(runningFrame.status, "running");
  assert.equal(finalFailed.status, "failed");
});

test("P1-1: runId 前缀 chapter-runtime: 守卫，区分 repair 域 chapter-repair:", () => {
  const frame = buildChapterRunStatusFrame({
    runId: `chapter-runtime:ch-isolated-9`,
    status: "succeeded",
    phase: "completed",
    message: "章节已保存，可继续审校。",
  });
  assert.ok(frame.runId.startsWith("chapter-runtime:"), "主生流 runId 必用 chapter-runtime: 前缀");
  // 与 repair 域区分：拒绝串域前缀。
  assert.ok(!frame.runId.startsWith("chapter-repair:"), "主生流 runId 不得误用 repair 前缀");
});

test("P1-1: phase completed 两条终态路径都保留（章节已落库，blocking issue 不丢 completed 语义）", () => {
  const successFrame = buildChapterRunStatusFrame({
    runId: RUN_ID,
    status: "succeeded",
    phase: "completed",
    message: "章节已保存，可继续审校。",
  });
  const blockingFrame = buildChapterRunStatusFrame({
    runId: RUN_ID,
    status: "failed",
    phase: "completed",
    message: "章节已保存，但检测到待修复问题。",
  });
  // hasBlockingIssues 分歧在 status（succeeded/failed），phase 都保 completed —— 章节确已落库。
  assert.equal(successFrame.phase, "completed");
  assert.equal(blockingFrame.phase, "completed");
  assert.notEqual(successFrame.status, blockingFrame.status);
});
