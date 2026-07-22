const test = require("node:test");
const assert = require("node:assert/strict");

const {
  plannerBookPlanPrompt,
  plannerChapterPlanPrompt,
} = require("../dist/prompting/prompts/planner/plannerPlan.prompts.js");

test("book planner postValidate fills phaseLabel/mustPreserve defaults", () => {
  const output = plannerBookPlanPrompt.postValidate({
    title: "全书主线",
    objective: "主角从零崛起并夺回身份",
    // phaseLabel / mustAdvance / mustPreserve intentionally omitted
  });
  assert.equal(output.title, "全书主线");
  assert.ok(output.phaseLabel && output.phaseLabel.trim().length > 0);
  assert.ok(Array.isArray(output.mustAdvance) && output.mustAdvance.length > 0);
  assert.ok(Array.isArray(output.mustPreserve) && output.mustPreserve.length > 0);
});

test("chapter planner postValidate fills planRole/phaseLabel/must* defaults but still requires scenes", () => {
  assert.throws(
    () => plannerChapterPlanPrompt.postValidate({
      title: "试探",
      objective: "主角试探旧识底线",
    }),
    /missing scenes/,
  );

  const output = plannerChapterPlanPrompt.postValidate({
    title: "试探",
    objective: "主角试探旧识底线",
    scenes: [
      {
        title: "夜谈",
        objective: "套出旧识态度",
        conflict: "对方回避",
        reveal: "对方知情",
        emotionBeat: "压抑",
      },
    ],
  });
  assert.ok(output.planRole);
  assert.ok(output.phaseLabel && output.phaseLabel.trim().length > 0);
  assert.ok(output.mustAdvance.length > 0);
  assert.ok(output.mustPreserve.length > 0);
});

test("chapter planner postValidate uses order-aware defaults when chapterOrder is known", () => {
  const mid = plannerChapterPlanPrompt.postValidate(
    {
      title: "中段",
      objective: "推进主线冲突",
      scenes: [
        {
          title: "对峙",
          objective: "逼出立场",
          conflict: "旧识反水",
          reveal: "对方另有盘算",
          emotionBeat: "紧绷",
        },
      ],
    },
    { scopeLabel: "章节规划：第12章", chapterOrder: 12, totalChapters: 20 },
  );
  assert.equal(mid.planRole, "pressure");
  assert.equal(mid.phaseLabel, "冲突加压");

  const late = plannerChapterPlanPrompt.postValidate(
    {
      title: "终局",
      objective: "兑现主线承诺",
      scenes: [
        {
          title: "抉择",
          objective: "完成选择",
          conflict: "代价显现",
          reveal: "路径不可逆",
          emotionBeat: "决绝",
        },
      ],
    },
    { scopeLabel: "章节规划：第19章", chapterOrder: 19, totalChapters: 20 },
  );
  assert.equal(late.planRole, "payoff");
  assert.equal(late.phaseLabel, "终局兑现");
});

test("chapter planner postValidate uses neutral defaults when chapterOrder unknown", () => {
  const output = plannerChapterPlanPrompt.postValidate(
    {
      title: "未知序",
      objective: "推进当前阶段",
      scenes: [
        {
          title: "推进",
          objective: "完成阶段目标",
          conflict: "阻力",
          reveal: "新信息",
          emotionBeat: "克制",
        },
      ],
    },
    { scopeLabel: "章节规划" },
  );
  assert.equal(output.planRole, "progress");
  assert.equal(output.phaseLabel, "阶段推进");
});

test("planner postValidate still rejects missing title/objective", () => {
  assert.throws(
    () => plannerBookPlanPrompt.postValidate({
      objective: "有目标没标题",
    }),
    /missing title/,
  );
  assert.throws(
    () => plannerBookPlanPrompt.postValidate({
      title: "有标题没目标",
    }),
    /missing objective/,
  );
});
