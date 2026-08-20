import type { ReviewIssue } from "@ai-novel/shared/types/novel";

/**
 * 证据锚定对位校验（evidenceAnchoring）。
 *
 * 背景（2026-08-20 ch18 rev50 生产实证）：评审 issues 的 evidence 未被强制锚定正文原文，
 * LLM 把「顾砚推门出去」+「评估负责人：顾砚」标签拼成「顾砚推门进入记录室对质」（logic:critical），
 * 该 evidence 在正文任意行为片段均无法命中，却被原样透传给 QL：
 *   severity=critical → buildRetentionSignal/continuity invalid → overallStatus:invalid。
 *
 * 目标：在 ReviewIssue 进入 QL 前做确定性对位校验（纯函数、可单测）：
 *   - evidence 里的「行为动词短语」能在正文出现 → 维持原 severity；
 *   - 命中不了（幻觉 / 拼串 / 行为张冠李戴）→ severity 降为 low 且 mark anchored=false，
 *     不再参与 QL 的 critical/high 升级，但保留原 evidence 供研读。
 *
 * 设计取舍：
 *   - 用**行为动词 + 上下文窗口**做锚，而非任意连续子串：4 字窗会被共享人物名
 *     （「与赵明远」）误锚，而「推门出去」「核对前份记录」「提交人工复核」这类
 *     行为核心才是事件真发生与否的可靠信号。
 *   - 真硬伤（正文真写过「顾砚进入记录室对质」）的行为短语必在正文出 → 不会误伤。
 *   - 只做正向锚定，不做语义否定反转（「未展示」被读成反向依赖 prompt 约束而非本层）。
 *   - severity 只降不升；命中的原样透传。
 */

/** 当出现在 riskFlags/issue 上时的占用 key */
export const EVIDENCE_ANCHOR_KEY = "evAnchor";

export interface AnchorReviewIssuesResult {
  issues: ReviewIssue[];
  /** 被降级+mark 的条数 */
  downgradedCount: number;
}

const DOWNGRADE_SEVERITY: ReviewIssue["severity"] = "low";

/** 只对会引发 QL 判定变化的 severity 做锚定降级；low 已低不处理。 */
function isEligibleForDowngrade(severity: ReviewIssue["severity"]): boolean {
  return severity === "critical" || severity === "high";
}

/** 行为动词/关键词：命中即以动词为中心扩展上下文窗口。 */
export const EVIDENCE_ACTION_VERBS =
  /(进入|推出|出去|对质|核对|调取|展示|提交|复核|离开|闯入|现身|在场|登门|驳回|不肯|并未|负责)/;

/** 从 evidence 提取行为短语：动词 + 紧随其后的受事/补语（不并前缀主语）。 */
function extractActionPhrases(evidence: string): string[] {
  const clean = typeof evidence === "string" ? evidence.trim() : "";
  const output: string[] = [];
  const regex = new RegExp(EVIDENCE_ACTION_VERBS.source, "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(clean)) !== null) {
    const verbIndex = match.index;
    const verbLen = match[0].length;
    // 只取「动词 + 紧后 0-8 字」的行为短语，不带上动词前的主语（避免「赵明远推门」offset）。
    const phrase = clean.slice(verbIndex, Math.min(clean.length, verbIndex + verbLen + 8));
    if (phrase.trim().length >= 2) {
      output.push(phrase.trim());
    }
    regex.lastIndex = verbIndex + verbLen;
  }
  return Array.from(new Set(output));
}

/** 归一中文标点：句号/逗号/顿号/省略号 → 统一空格,便于行为短语跨标点命中。 */
function normalizePunctuation(input: string): string {
  return input
    .replace(/[，。、；！？——…「」『』·]+/g, "")
    .replace(/\s+/g, "")
    .trim();
}

/** 判定 evidence 是否命中正文的可观察行为（两侧做标点归一后子串匹配）。 */
export function isEvidenceAnchored(evidence: string, content: string): boolean {
  if (typeof evidence !== "string" || typeof content !== "string") {
    return false;
  }
  const phrases = extractActionPhrases(evidence);
  if (phrases.length === 0) {
    return false;
  }
  const normalizedBody = normalizePunctuation(content);
  return phrases.some((phrase) => normalizedBody.includes(normalizePunctuation(phrase)));
}

/**
 * 对 issues 进行证据锚定。
 * 命中正文行为片段 → 原样返回；
 * 未命中 → severity 降为 low 并记 evAnchor="untestable"。
 */
export function anchorReviewIssues(
  issues: ReviewIssue[],
  content: string,
): AnchorReviewIssuesResult {
  const body = typeof content === "string" ? content : "";
  let downgradedCount = 0;
  const next = issues.map((issue) => {
    const severity = issue.severity;
    if (!isEligibleForDowngrade(severity)) {
      return issue;
    }
    const evidence = typeof issue.evidence === "string" ? issue.evidence : "";
    if (isEvidenceAnchored(evidence, body)) {
      return issue;
    }
    downgradedCount += 1;
    return {
      ...issue,
      severity: DOWNGRADE_SEVERITY,
      [EVIDENCE_ANCHOR_KEY]: "unverified",
    };
  });
  return { issues: next, downgradedCount };
}