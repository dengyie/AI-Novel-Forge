const test = require("node:test");
const assert = require("node:assert/strict");

const {
  chapterRepairPrompt,
} = require("../dist/prompting/prompts/novel/review.prompts.js");

// 最小可用的 render context：renderSelectedContextBlocks 读 context.blocks。
const EMPTY_CONTEXT = { blocks: [] };

function baseInput(overrides = {}) {
  return {
    novelTitle: "测试小说",
    bibleContent: "none",
    chapterTitle: "第五章 绝境人",
    chapterContent: "修复前正文，长度不足。",
    issuesJson: "[]",
    ragContext: "none",
    modeHint: "补足篇幅",
    repairMode: "heavy_repair",
    ...overrides,
  };
}

test("RED-G1: heavy_repair 携带 lengthBudget 时 rendered prompt 须含篇幅合同且写明 hardMin", () => {
  const lengthBudget = {
    targetWordCount: 12000,
    softMinWordCount: 10200,
    softMaxWordCount: 13800,
    hardMinWordCount: 7200,
  };
  const rendered = chapterRepairPrompt.render(baseInput({ lengthBudget }), EMPTY_CONTEXT);
  const joined = rendered.map((m) => (typeof m.content === "string" ? m.content : m.content)).join("\n");

  // 必须出现篇幅合同事实：目标、软区间、硬下限。
  assert.match(joined, /12000/, "prompt 须写明目标字数 12000");
  assert.match(joined, /7200/, "prompt 须写明硬下限 7200（hardMin 不可破）");
  // 明确的不可破硬下限指令（语义来自 task #27：边界优先但 hardMin 不豁免）。
  assert.match(joined, /不低于|不得少于|至少|硬下限|不可低于|不可少于/, "prompt 须明确写明不得低于硬下限");
});

test("RED-G2: light_repair 即便带 lengthBudget 也不注入扩写指令（结构上无力扩写）", () => {
  const lengthBudget = {
    targetWordCount: 12000,
    softMinWordCount: 10200,
    softMaxWordCount: 13800,
    hardMinWordCount: 7200,
  };
  const rendered = chapterRepairPrompt.render(
    baseInput({ repairMode: "light_repair", lengthBudget }),
    EMPTY_CONTEXT,
  );
  const joined = rendered.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");

  // light_repair 是局部补丁，禁止靠它扩写整章；篇幅指令不应出现在 light 路径。
  assert.doesNotMatch(
    joined,
    /硬下限 7200|不低于.*7200|扩写.*12000/,
    "light_repair 不得注入扩写/篇幅硬下限指令（应由拦截层升级到 heavy 后由 heavy prompt 承担）",
  );
});

test("RED-G3: 无 lengthBudget（旧数据/无合同）时不报错、不注入篇幅指令", () => {
  const rendered = chapterRepairPrompt.render(baseInput({}), EMPTY_CONTEXT);
  const joined = rendered.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");

  assert.ok(typeof joined === "string" && joined.length > 0, "render 须正常返回");
  assert.doesNotMatch(
    joined,
    /篇幅合同|目标字数\s*\d|硬下限\s*\d/,
    "无 lengthBudget 时不得注入篇幅指令",
  );
});
