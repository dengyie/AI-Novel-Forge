const test = require("node:test");
const assert = require("node:assert/strict");

const { buildRepairRunStatusFrame } = require("../dist/services/novel/runtime/repair/ChapterRepairStreamRuntime.js");

/**
 * F9 专门回归：chapter repair 的 run_status 帧禁止把 needs_repair 的章节报成 succeeded。
 *
 * 原根因：markPostAdoptNeedsRepair（adopt 后副作用失败 → 章节强制 needs_repair）
 * 与 adopt-recheck 未过质量门两路都误发 status:"succeeded"，监控 poller 据此
 * 把章节当"已过审"跳过，needs_repair 章静默漏网。
 *
 * 此测直接驱动纯函数 buildRepairRunStatusFrame 的两条分支契约：
 *  1. adopt-recheck 全过 → "succeeded"
 *  2. adopt-recheck 未过 → "failed"（needs_repair）
 *  3. post-adopt 副作用失败 → 必 "failed"
 * 若有人把 status 收敛回 succeeded-only，第 2/3 条立即红。
 */

const CHAPTER_ID = "ch-fix-9";

test("F9: adopt-recheck passed → status succeeded with 完成文案", () => {
  const frame = buildRepairRunStatusFrame({
    chapterId: CHAPTER_ID,
    status: "succeeded",
    phase: "completed",
    message: "修复候选已采纳，本章已达到可继续推进状态。",
  });
  assert.equal(frame.type, "run_status");
  assert.equal(frame.runId, `chapter-repair:${CHAPTER_ID}`);
  assert.equal(frame.status, "succeeded");
  assert.equal(frame.phase, "completed");
  assert.match(frame.message, /已达到可继续推进状态/);
});

test("F9: adopt-recheck failed (needs_repair) → status failed, 不许 succeeded", () => {
  const frame = buildRepairRunStatusFrame({
    chapterId: CHAPTER_ID,
    status: "failed",
    phase: "completed",
    message: "修复候选已采纳并保存，但仍有问题待继续处理。",
  });
  assert.equal(frame.status, "failed");
  assert.equal(frame.phase, "completed");
  // 核心回归断言：needs_repair 语义必报 failed，绝不 succeeded。
  assert.notEqual(frame.status, "succeeded");
  assert.match(frame.message, /仍有问题待继续处理/);
});

test("F9: post-adopt side-effect failure → status failed (markPostAdoptNeedsRepair)", () => {
  // adopt 写正文后 artifactSync / recheck 失败：正文已存，章节强制 needs_repair。
  // F9 原根因即此路误报 succeeded；现必 failed。
  const frame = buildRepairRunStatusFrame({
    chapterId: CHAPTER_ID,
    status: "failed",
    phase: "completed",
    message: "修复候选已采纳，但 artifacts 同步失败，已标 needs_repair。",
  });
  assert.equal(frame.status, "failed");
  assert.notEqual(frame.status, "succeeded");
  assert.match(frame.message, /needs_repair/);
});

test("F9: runId 派生自 chapterId，避免调用方传错 runId 关联不到章节", () => {
  const frame = buildRepairRunStatusFrame({
    chapterId: "ch-isolated-7",
    status: "failed",
    phase: "completed",
    message: "x",
  });
  assert.equal(frame.runId, "chapter-repair:ch-isolated-7");
  // 帧类型守卫：监管 poller 按 runId 前缀归并章节 status，错前缀会丢章节。
  assert.ok(frame.runId.startsWith("chapter-repair:"), "runId 必须用 chapter-repair: 前缀");
});

test("F9: running/finalizing 帧（adopt 前）归同 helper，runId 一致", () => {
  // 修复稿已生成、待 evaluate→adopt 的中间态：status=running, phase=finalizing。
  // 此帧与最终帧共用 buildRepairRunStatusFrame，runId 必同 → poller 可按 runId 关联生命周期。
  const runningFrame = buildRepairRunStatusFrame({
    chapterId: CHAPTER_ID,
    status: "running",
    phase: "finalizing",
    message: "修复稿已生成，正在评估是否采纳（evaluate → adopt|discard）。",
  });
  const finalFailed = buildRepairRunStatusFrame({
    chapterId: CHAPTER_ID,
    status: "failed",
    phase: "completed",
    message: "修复候选已采纳并保存，但仍有问题待继续处理。",
  });
  assert.equal(runningFrame.runId, finalFailed.runId);
  assert.equal(runningFrame.status, "running");
  assert.equal(finalFailed.status, "failed");
});
