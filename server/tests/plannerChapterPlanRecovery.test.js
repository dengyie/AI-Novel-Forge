const test = require("node:test");
const assert = require("node:assert/strict");

// E1：planner chapter plan asset 的 postValidateFailureRecovery 兜底。
// 背景（见 docs/optimizations/章节生成链路韧性-planner兜底与错误透传-开发优化文档.md §E1）：
// gemini-3.7-flash-high 作为 planner 偶发输出畸形 JSON（title 复读元描述、objective 缺失），
// postValidate 抛 "Planner output is missing objective"，semantic-retry-1 仍畸形，
// asset 无 postValidateFailureRecovery → resolveStructuredOutput 抛 post_validate_failed → 整章 generate 500。
// 本测试钉死兜底契约：一次畸形不致命，用已有契约字段（scopeLabel 含章节标题、context chapter_target 含任务单）
// 投影出最小可用 PlannerOutput，让持久化层兜底链（PlannerService.ts:707-711）补全实质内容。
//
// 产品铁律边界（不可破）：
// - 兜底只投影已有契约字段，不凭空生成 scenes/participants/objective 的创作性内容。
// - 不堆 mode/灰度：单一 recovery 路径。
// - 不控字数/节奏。
// 会让本测试失败的产品改动：删除 recovery、recovery 凭空生成创作性字段、recovery 对未知错误盲目兜底不重抛。

const { plannerChapterPlanPrompt } = require("../dist/prompting/prompts/planner/plannerPlan.prompts.js");
const { normalizePlannerOutput } = require("../dist/services/planner/plannerOutputNormalization.js");

function buildContextWithChapterTarget({ expectation, taskSheet } = {}) {
  // 对齐生产格式（plannerContextBlocks.ts buildBlockContent: `${label}：${value}`）。
  const lines = [];
  lines.push(`章节目标草稿：${(expectation ?? "").trim() || "无"}`);
  lines.push(`任务单：${(taskSheet ?? "").trim() || "无"}`);
  return {
    blocks: [{
      id: "chapter_target",
      group: "chapter_target",
      priority: 100,
      required: true,
      estimatedTokens: 100,
      content: lines.join("\n"),
    }],
    selectedBlockIds: ["chapter_target"],
    droppedBlockIds: [],
    summarizedBlockIds: [],
    estimatedInputTokens: 100,
  };
}

test("asset exposes postValidateFailureRecovery (E1 baseline)", () => {
  assert.equal(typeof plannerChapterPlanPrompt.postValidateFailureRecovery, "function",
    "plannerChapterPlanPrompt 必须有 postValidateFailureRecovery 兜底，否则单次畸形输出即整章 500");
});

test("recovery projects chapter title from scopeLabel when LLM output is garbled", () => {
  // ch6 实录：LLM title 复读元描述，objective 缺失。
  const garbledRaw = normalizePlannerOutput({
    title: "第6章 真同意：残痕托付与代价即死后的深渊对峙（总第6章）[残痕][托付][12000字][严禁截断]",
    objective: "",
    participants: [],
    reveals: [],
    riskNotes: [],
    hookTarget: "",
    planRole: "",
    phaseLabel: "",
    mustAdvance: [],
    mustPreserve: [],
    scenes: [],
  });
  const recovered = plannerChapterPlanPrompt.postValidateFailureRecovery({
    promptInput: {
      scopeLabel: "章节规划：第6章《真同意》",
      chapterOrder: 6,
      totalChapters: 20,
    },
    context: buildContextWithChapterTarget({
      expectation: "陆深以真同意托付源痕，代价即死",
      taskSheet: "章节目标：完成托付\n必须推进：真同意\n必须保留：何屿内向基调",
    }),
    rawOutput: garbledRaw,
    validationError: "Planner output is missing objective.",
    semanticRetryAttempts: 1,
  });

  // title 不得保留 LLM 复读的元描述垃圾；应回落到 scopeLabel 里的章节标题。
  assert.equal(recovered.title, "真同意",
    `recovery title 应从 scopeLabel 解析章节标题，而非保留 LLM 复读垃圾；实际=${JSON.stringify(recovered.title)}`);
});

test("recovery objective comes from context chapter_target expectation, not invented", () => {
  const garbledRaw = normalizePlannerOutput({ title: "x", objective: "", scenes: [] });
  const expectation = "陆深以真同意托付源痕，规则代价即时致其身亡";
  const recovered = plannerChapterPlanPrompt.postValidateFailureRecovery({
    promptInput: {
      scopeLabel: "章节规划：第6章《真同意》",
      chapterOrder: 6,
      totalChapters: 20,
    },
    context: buildContextWithChapterTarget({ expectation }),
    rawOutput: garbledRaw,
    validationError: "Planner output is missing objective.",
    semanticRetryAttempts: 1,
  });

  // objective 必须来自已有契约（context chapter_target expectation），不得凭空生成。
  assert.ok(recovered.objective && recovered.objective.includes("真同意"),
    `recovery objective 应投影 context expectation，实际=${JSON.stringify(recovered.objective)}`);
  assert.ok(!recovered.objective.includes("（本章目标待补"),
    "有 expectation 时不得用占位串，必须投影实质契约字段");
});

test("recovery does not invent scenes/participants (铁律：监管只监控不代写)", () => {
  const garbledRaw = normalizePlannerOutput({ title: "x", objective: "", scenes: [] });
  const recovered = plannerChapterPlanPrompt.postValidateFailureRecovery({
    promptInput: {
      scopeLabel: "章节规划：第6章《真同意》",
      chapterOrder: 6,
      totalChapters: 20,
    },
    context: buildContextWithChapterTarget({ expectation: "推进托付" }),
    rawOutput: garbledRaw,
    validationError: "Planner output is missing objective.",
    semanticRetryAttempts: 1,
  });

  // 兜底不得凭空生成 scenes（创作性内容）——scenes 必须为空，让持久化层回落。
  assert.deepEqual(recovered.scenes ?? [], [],
    "recovery 不得凭空生成 scenes，必须为空数组交持久化层兜底链处理");
  // participants 不得凭空捏造人物。
  assert.deepEqual(recovered.participants ?? [], [],
    "recovery 不得凭空生成 participants");
});

test("recovery fills planRole/phaseLabel via existing defaults (chapterOrder-aware)", () => {
  const garbledRaw = normalizePlannerOutput({ title: "x", objective: "", planRole: "", phaseLabel: "", scenes: [] });
  const recovered = plannerChapterPlanPrompt.postValidateFailureRecovery({
    promptInput: {
      scopeLabel: "章节规划：第6章《真同意》",
      chapterOrder: 6,
      totalChapters: 20,
    },
    context: buildContextWithChapterTarget({ expectation: "推进托付" }),
    rawOutput: garbledRaw,
    validationError: "Planner output is missing objective.",
    semanticRetryAttempts: 1,
  });

  // planRole 必须是合法枚举值（buildDefaultPlanMetadata 按 chapterOrder 补 progress 等）。
  assert.ok(["setup", "progress", "pressure", "turn", "payoff", "cooldown"].includes(recovered.planRole),
    `recovery planRole 必须是合法枚举，实际=${JSON.stringify(recovered.planRole)}`);
  // phaseLabel 非空（defaults 补）。
  assert.ok(recovered.phaseLabel && recovered.phaseLabel.trim().length > 0,
    `recovery phaseLabel 不得为空，实际=${JSON.stringify(recovered.phaseLabel)}`);
});

test("recovery rethrows on unknown validation errors (不盲目兜底)", () => {
  // 对非 "missing objective/title" 类的未知错误，recovery 必须重抛，保持原 500 行为。
  // 否则盲目兜底会掩盖未知缺陷，违反「卡住先查根因不无脑重试」。
  const garbledRaw = normalizePlannerOutput({ title: "x", objective: "有目标", scenes: [] });
  assert.throws(
    () => plannerChapterPlanPrompt.postValidateFailureRecovery({
      promptInput: {
        scopeLabel: "章节规划：第6章《真同意》",
        chapterOrder: 6,
        totalChapters: 20,
      },
      context: buildContextWithChapterTarget({ expectation: "推进托付" }),
      rawOutput: garbledRaw,
      validationError: "Planner scene is missing conflict.",
      semanticRetryAttempts: 1,
    }),
    /conflict/,
    "recovery 对未知错误必须重抛，不得盲目兜底掩盖缺陷",
  );
});
