const test = require("node:test");
const assert = require("node:assert/strict");

const {
  styleDetectionRuleTypeSchema,
  styleDetectionViolationSchema,
} = require("../dist/prompting/prompts/style/style.promptSchemas.js");

// 真实抽检发现：LLM 常把 ruleType 输出为"类别名"（antiAi 等）而非枚举字面量，
// 导致每次检测都触发一次 schema repair（多一次 LLM 调用/延迟）。归一层应在首次解析
// 就把常见别名映射到合法枚举，消除 repair 往返。

test("合法枚举原样通过", () => {
  for (const t of ["style", "character", "forbidden", "risk", "encourage"]) {
    assert.equal(styleDetectionRuleTypeSchema.parse(t), t);
  }
});

test("antiAi 别名归一到 risk（消除 repair 主因）", () => {
  assert.equal(styleDetectionRuleTypeSchema.parse("antiAi"), "risk");
  assert.equal(styleDetectionRuleTypeSchema.parse("anti-ai"), "risk");
  assert.equal(styleDetectionRuleTypeSchema.parse("anti_ai"), "risk");
});

test("大小写与首尾空白不影响归一", () => {
  assert.equal(styleDetectionRuleTypeSchema.parse("  Style "), "style");
  assert.equal(styleDetectionRuleTypeSchema.parse("FORBIDDEN"), "forbidden");
  assert.equal(styleDetectionRuleTypeSchema.parse("AntiAI"), "risk");
});

test("其它类别名别名归一到语义最近枚举", () => {
  assert.equal(styleDetectionRuleTypeSchema.parse("writing"), "style");
  assert.equal(styleDetectionRuleTypeSchema.parse("character_expression"), "character");
  assert.equal(styleDetectionRuleTypeSchema.parse("role"), "character");
  assert.equal(styleDetectionRuleTypeSchema.parse("warn"), "risk");
  assert.equal(styleDetectionRuleTypeSchema.parse("encouraged"), "encourage");
});

test("完全未知字符串兜底到 risk（保守：反 AI 风险类），不再抛错触发 repair", () => {
  assert.equal(styleDetectionRuleTypeSchema.parse("完全乱写的值"), "risk");
  assert.equal(styleDetectionRuleTypeSchema.parse("xyz123"), "risk");
});

test("非字符串输入仍走原 enum 校验（抛错，不静默兜底）", () => {
  assert.throws(() => styleDetectionRuleTypeSchema.parse(123));
  assert.throws(() => styleDetectionRuleTypeSchema.parse(null));
});

test("violation 整体解析：antiAi ruleType 不再导致校验失败", () => {
  const parsed = styleDetectionViolationSchema.parse({
    ruleName: "禁止解释型心理描写",
    ruleType: "antiAi",
    severity: "high",
    excerpt: "他知道这一刻终将到来",
    reason: "全知旁白解释人物心理",
    suggestion: "改为外部动作或对话呈现",
    canAutoRewrite: true,
  });
  assert.equal(parsed.ruleType, "risk");
  assert.equal(parsed.ruleName, "禁止解释型心理描写");
});
