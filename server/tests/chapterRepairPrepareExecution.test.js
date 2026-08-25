const test = require("node:test");
const assert = require("node:assert/strict");

const {
  prepareChapterRepairExecution,
} = require("../dist/services/novel/runtime/repair/chapterRepairRuntime.js");
const promptRunner = require("../dist/prompting/core/promptRunner.js");

const SHORT_CONTENT = "开头段交代环境。第二段对手戏推进冲突。第三段收束钩子并留下悬念。";

/**
 * 构造一个能成功应用的局部补丁计划：targetExcerpt 必须是正文中唯一出现的子串。
 * 返回可注入 runStructuredPrompt 的 { output }。
 */
function patchPlanFor(content) {
  const target = "第二段对手戏推进冲突。";
  assert.ok(content.includes(target), "content 必须含唯一锚点子串");
  return {
    output: {
      strategy: "patch_first",
      summary: "扩写收束段以补足篇幅。",
      patches: [{
        id: "patch-expand",
        targetExcerpt: target,
        replacement: "第二段对手戏反复拉扯推进冲突，铺垫关键节拍后再收束。",
        reason: "补足长度硬门要求的关键推进与细节。",
        issueIds: [],
      }],
      requiresFullRewrite: false,
      escalationReason: null,
    },
  };
}

const BASE_INPUT = {
  novelId: "novel-1",
  chapterId: "chapter-1",
  novelTitle: "测试小说",
  chapterTitle: "第一章",
  content: SHORT_CONTENT,
  issues: [],
  targetWordCount: 12000,
  options: { repairMode: "light_repair" },
};

test("F7/length: targetWordCount 存在且正文 under → 局部补丁切到 length_expansion 并带扩写专属提示", async () => {
  const original = promptRunner.runStructuredPrompt;
  promptRunner.runStructuredPrompt = async () => patchPlanFor(SHORT_CONTENT);
  try {
    const prepared = await prepareChapterRepairExecution({ ...BASE_INPUT });
    assert.equal(prepared.kind, "patched");
    // 期望自动补长度分支把 activeRepairMode 从 light_repair 切换到 length_expansion
    assert.equal(prepared.finalRepairMode, "length_expansion");
    // modeHint 应为 length_expansion 专属扩写提示（需 LENGTH_UNDER_SOFT_MIN 在 issueCodes）
    assert.match(prepared.modeHint, /自动补长度|extend_for_length/);
    assert.match(prepared.modeHint, /扩写/);
  } finally {
    promptRunner.runStructuredPrompt = original;
  }
});

test("F7: targetWordCount=null（无长度合同）即便 qualityFeedback 带 length_under 也不触发 length_expansion", async () => {
  const original = promptRunner.runStructuredPrompt;
  promptRunner.runStructuredPrompt = async () => patchPlanFor(SHORT_CONTENT);
  try {
    const prepared = await prepareChapterRepairExecution({
      ...BASE_INPUT,
      targetWordCount: null,
      // stale 的 length_under 反馈不应在无合同章节兜底触发扩写（F7 守卫）
      qualityFeedback: [{
        version: 1,
        chapterOrder: 6,
        chapterId: "chapter-6",
        signature: "qfb:length-under",
        severity: "soft",
        rootCause: "length_drift",
        codes: ["length_under_soft"],
        evidence: [],
        mustFix: [],
        planHints: [],
        failedPatchCount: 1,
        avoidRetry: false,
        evaluatedAt: "2026-08-18T00:00:00.000Z",
      }],
    });
    assert.equal(prepared.kind, "patched");
    // 无合同时 isUnderLength 恒 false → 保持 light_repair，不得被 length_under 反馈触发扩写
    assert.equal(prepared.finalRepairMode, "light_repair");
    // 信任关键：反馈注入的 length code 只让 hint 落到通用 extend 或默认，而未到「自动补长度」专属口径
    assert.equal(prepared.modeHint.includes("自动补长度"), false);
  } finally {
    promptRunner.runStructuredPrompt = original;
  }
});