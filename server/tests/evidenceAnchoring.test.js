const test = require("node:test");
const assert = require("node:assert/strict");

// 证据锚定对位校验（evidenceAnchoring）。
//
// 背景：QL 误报根因（2026-08-20 ch18 rev50 实证）——评审 evidence 未被强制锚定原文，
// LLM 把「顾砚推门出去」+「评估负责人：顾砚」标签拼成「顾砚推门进入记录室对质」（logic:critical），
// 这条 evidence 无法在正文验证片段命中，却被原样透传给 QL：
//   severity=critical → retention/continuity invalid → overallStatus:invalid。
//
// 修法（用户已确认：③+④ 双杠杆）：新增确定性「证据锚定」层，在 ReviewIssue 进入 QL 前：
//   - evidence 能命中正文可观察的关键动作/名词片段 → 保持原 severity；
//   - 命中不了（幻觉/拼串/反向误读）→ 降级为 low 且 mark anchored=false（不参与 critical/high 升级，但仍可观测）。
// QL 判定规则本身不动（critical→invalid 是高危硬伤语义，不能让渡）。
//
// 真实硬伤（正文真写过「顾砚进入记录室」）的 evidence 必带原文锚点 → 不会误伤。
// 语义级否定反读（如「未展示」被读成「已展示」）由 prompt 侧约束兜，不靠本层（evidence 引真话时会锚住）。

const { anchorReviewIssues, EVIDENCE_ANCHOR_KEY } = require("../dist/services/novel/runtime/evidenceAnchoring.js");

const CHAPTER_TEXT = `赵明远推门出去。门没有立刻合拢。
系统提示树：当前评估负责人——顾砚。
记录室灯下，何屿与赵明远核对前份记录。
原始记录页面未向何屿展示。
何屿：请调取原始页。
赵明远：无法确认，提交人工复核。`;

function reviewIssue({ category = "logic", severity = "high", evidence, fixSuggestion = "fix" }) {
  return { severity, category, evidence: evidence ?? "示例证据", fixSuggestion };
}

test("benchmark: module loads & exposes anchorReviewIssues + EVIDENCE_ANCHOR_KEY", () => {
  assert.equal(typeof anchorReviewIssues, "function");
  assert.equal(typeof EVIDENCE_ANCHOR_KEY, "string");
});

test("强锚定：evidence 逐字命中正文明文关键片段 → 维持原 severity，不 mark", () => {
  const issues = [reviewIssue({ category: "logic", severity: "critical", evidence: "如何让顾见逐项核对记录" })];
  // 正文含「何屿与赵明远核对」，但『让顾见逐项核对』无；用更贴近原文的锚：
  const anchored = reviewIssue({ category: "logic", severity: "critical", evidence: "何屿与赵明远核对前份记录" });
  const result = anchorReviewIssues([anchored], CHAPTER_TEXT);
  assert.equal(result.issues[0].severity, "critical");
  assert.equal(result.issues[0][EVIDENCE_ANCHOR_KEY], undefined, "命中的证据不应带锚定标记");
  assert.equal(result.downgradedCount, 0);
});

test("未入锚：LLM 把『推门出去』误读为『进入对质』 → 关键片段『进入记录室』不在正文 → 降为 low + mark", () => {
  const issues = [reviewIssue({ category: "logic", severity: "critical", evidence: "顾见推门进入记录室与赵明远对质" })];
  const result = anchorReviewIssues(issues, CHAPTER_TEXT);
  assert.equal(result.downgradedCount, 1);
  assert.equal(result.issues[0].severity, "low", "未锚定不得参与 critical 升级");
  assert.equal(result.issues[0][EVIDENCE_ANCHOR_KEY], "unverified");
});

test("只含人名/单片段不足以锚定：须关键行为短语命中正文，幻觉的『进入』关键片段不存在 → 降级", () => {
  const issues = [reviewIssue({ category: "logic", severity: "high", evidence: "顾见进入记录室后直接回应质询" })];
  const result = anchorReviewIssues(issues, CHAPTER_TEXT);
  assert.equal(result.downgradedCount, 1);
  assert.equal(result.issues[0][EVIDENCE_ANCHOR_KEY], "unverified");
});

test("正例：原文实有的行为短语命中 → 保持原 severity（不误伤真实硬伤）", () => {
  const issues = [reviewIssue({ category: "coherence", severity: "high", evidence: "赵明远推门出去，门没有立刻合拢" })];
  const result = anchorReviewIssues(issues, CHAPTER_TEXT);
  assert.equal(result.downgradedCount, 0);
  assert.equal(result.issues[0].severity, "high");
});

test("语义反读（未展示→已展示）时 evidence 引正文原句 → 不会因锚定降级（留给 prompt/下游判定），但空转无事", () => {
  // 原文有「何屿：请调取原始页」→ 该 evidence 锚点真实（正文存在），不降级。
  const issues = [reviewIssue({ category: "coherence", severity: "medium", evidence: "何屿调取原始页并逐项核对" })];
  const result = anchorReviewIssues(issues, CHAPTER_TEXT);
  assert.equal(result.downgradedCount, 0, "语义级反向读不靠本层拦截，锚定只认『原文有该行为』");
  assert.equal(result.issues[0].severity, "medium");
});

test("多 issue：仅幻觉条降级，真实条保持；降级条保留原 content 供审计", () => {
  const real = reviewIssue({ category: "logic", severity: "high", evidence: "何屿与赵明远核对前份记录" });
  const fake = reviewIssue({ category: "logic", severity: "critical", evidence: "顾见进入记录室当场对质" });
  const result = anchorReviewIssues([real, fake], CHAPTER_TEXT);
  assert.equal(result.downgradedCount, 1);
  assert.equal(result.issues[0].severity, "high", "真实条不动");
  assert.equal(result.issues[1].severity, "low");
  assert.equal(result.issues[1].evidence, "顾见进入记录室当场对质", "原文 evidence 须保留供审计");
});

test("真实硬伤不误伤：正文真写过『顾见闯入』→ evidence 行为短语命中 → 保持 critical（不能放行真违规）", () => {
  const bodyWithRealBreach = CHAPTER_TEXT + "\n顾见闯入记录室与赵明远对质。";
  const realBreach = {
    category: "logic",
    severity: "critical",
    evidence: "顾见闯入记录室，与赵明远对质",
    fixSuggestion: "将顾见作用改为远程批注",
  };
  const result = anchorReviewIssues([realBreach], bodyWithRealBreach);
  assert.equal(result.downgradedCount, 0, "真硬伤证据命中正文行为短语,不得降级");
  assert.equal(result.issues[0].severity, "critical", "critical 必须保留，否则会放行真违规");
});