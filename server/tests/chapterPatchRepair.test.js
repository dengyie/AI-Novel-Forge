const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyChapterPatchRepairPlan,
} = require("../../shared/dist/types/chapterPatchRepair.js");
const {
  ChapterPatchRepairFailedError,
  ChapterPatchRepairService,
} = require("../dist/services/novel/chapterPatchRepairService.js");

test("applyChapterPatchRepairPlan applies exact single-location patches", () => {
  const result = applyChapterPatchRepairPlan("第一段承接断裂。第二段继续推进。", {
    strategy: "patch_first",
    summary: "补足承接。",
    patches: [{
      id: "patch-1",
      targetExcerpt: "第一段承接断裂。",
      replacement: "第一段补上前因后果，承接自然。",
      reason: "修复承接问题。",
      issueIds: ["issue-1"],
    }],
    requiresFullRewrite: false,
    escalationReason: null,
  });

  assert.equal(result.success, true);
  assert.equal(result.content, "第一段补上前因后果，承接自然。第二段继续推进。");
  assert.deepEqual(result.appliedPatchIds, ["patch-1"]);
  assert.deepEqual(result.failures, []);
});

test("applyChapterPatchRepairPlan rejects ambiguous target excerpts", () => {
  const result = applyChapterPatchRepairPlan("重复承接片段。重复承接片段。", {
    strategy: "patch_first",
    summary: "尝试修复重复。",
    patches: [{
      id: "patch-dup",
      targetExcerpt: "重复承接片段。",
      replacement: "替换后的片段。",
      reason: "目标片段重复。",
      issueIds: [],
    }],
    requiresFullRewrite: false,
    escalationReason: null,
  });

  assert.equal(result.success, false);
  assert.equal(result.content, "重复承接片段。重复承接片段。");
  assert.equal(result.failures[0].patchId, "patch-dup");
});

test("applyChapterPatchRepairPlan rejects full rewrite plans", () => {
  const result = applyChapterPatchRepairPlan("正文。", {
    strategy: "full_rewrite",
    summary: "需要重写。",
    patches: [],
    requiresFullRewrite: true,
    escalationReason: "结构性缺章。",
  });

  assert.equal(result.success, false);
  assert.equal(result.content, "正文。");
  assert.equal(result.failures[0].patchId, "plan");
});

test("ChapterPatchRepairService does not run local repair in rewrite-only modes", async () => {
  const service = new ChapterPatchRepairService();

  await assert.rejects(
    () => service.repair({
      novelTitle: "测试小说",
      chapterTitle: "第一章",
      content: "已有正文。",
      issues: [],
      repairMode: "heavy_repair",
    }),
    ChapterPatchRepairFailedError,
  );

  await assert.rejects(
    () => service.repair({
      novelTitle: "测试小说",
      chapterTitle: "第一章",
      content: "已有正文。",
      issues: [],
      repairMode: "detect_only",
    }),
    ChapterPatchRepairFailedError,
  );
});
