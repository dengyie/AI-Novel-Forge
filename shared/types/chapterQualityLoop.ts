import type { ChapterRuntimePackage } from "./chapterRuntime.js";
import type { QualityScore, ReviewIssue } from "./novel.js";
import type {
  ChapterExecutionMissingObligation,
  ChapterFailureClassification,
} from "./chapterRuntime.js";
import type { SettingAlignmentAssessment } from "./settingAlignment.js";
import { settingAlignmentToQualityLoopSignal } from "./settingAlignment.js";
import {
  DEFAULT_QUALITY_IS_PASS_THRESHOLD,
  isLiteraryQualityPass,
  type QualityIsPassThreshold,
} from "./literaryQualityPass.js";

export const CHAPTER_QUALITY_LOOP_ARTIFACT_TYPES = [
  "chapter_retention_contract",
  "continuity_state",
  "rolling_window_review",
  "prose_quality",
  "literary_score",
  "setting_alignment",
] as const;

export type ChapterQualityLoopArtifactType = typeof CHAPTER_QUALITY_LOOP_ARTIFACT_TYPES[number];
export type ChapterQualityLoopSignalStatus = "valid" | "risk" | "invalid" | "missing";
export type ChapterQualityLoopAction = "continue" | "patch_repair" | "replan" | "manual_gate";
export type ChapterQualityLoopBudgetAction = "patch_repair" | "rewrite_chapter" | "replan_window" | "hard_stop";
export type ChapterQualityLoopRiskClassification = "none" | "blocking" | "non_blocking_quality_debt";

export interface ChapterQualityLoopBudget {
  signature: string;
  attempt: number;
  maxAttempts: number;
  nextAction: ChapterQualityLoopBudgetAction;
  exhausted: boolean;
  reason: string;
}

export interface ChapterQualityLoopSignal {
  artifactType: ChapterQualityLoopArtifactType;
  status: ChapterQualityLoopSignalStatus;
  reason: string;
  issueCodes: string[];
}

export interface ChapterQualityLoopAssessment {
  chapterId: string;
  chapterOrder?: number | null;
  evaluatedAt: string;
  overallStatus: ChapterQualityLoopSignalStatus;
  recommendedAction: ChapterQualityLoopAction;
  patchFirstRequired: boolean;
  recheckRequired: boolean;
  pauseReason?: string | null;
  rootCauseCode?: ChapterFailureClassification["code"] | null;
  blockingObligations?: ChapterExecutionMissingObligation[];
  budget?: ChapterQualityLoopBudget | null;
  signals: ChapterQualityLoopSignal[];
  /**
   * 不参与 recommendedAction 的可观测标签（如 length_over_hard）。
   * 来自 acceptance riskTags，写入 riskFlags.qualityLoop 供债板/运营读取。
   */
  observabilityTags?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseRiskFlagsObject(value: string | null | undefined): Record<string, unknown> | null {
  if (!value?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasBlockingObligations(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function hasSettingAlignmentHardInvalidSignal(qualityLoop: Record<string, unknown>): boolean {
  const signals = Array.isArray(qualityLoop.signals) ? qualityLoop.signals : [];
  return signals.some((signal) => {
    return isRecord(signal)
      && signal.artifactType === "setting_alignment"
      && signal.status === "invalid";
  });
}

/**
 * enforce 设定债务（含 soft function miss → risk）：不可被 defer 降级。
 * advisory-only（reason 含 advisory/不阻断 且 continue）仍允许 non-blocking。
 */
function hasEnforceSettingAlignmentDebt(qualityLoop: Record<string, unknown>): boolean {
  if (hasSettingAlignmentHardInvalidSignal(qualityLoop)) {
    return true;
  }
  if (hasSettingAlignmentAdvisoryOnlySignal(qualityLoop)) {
    return false;
  }
  const signals = Array.isArray(qualityLoop.signals) ? qualityLoop.signals : [];
  return signals.some((signal) => {
    return isRecord(signal)
      && signal.artifactType === "setting_alignment"
      && (signal.status === "risk" || signal.status === "invalid");
  });
}

/**
 * 政策 / 确定性 L0 码：sot_*、critical prose、结构 HUD。
 * 与 detector severity 对齐；high 非 critical（如 prose_negative_flip）不在此集合。
 * 双通道判定见 {@link hasNonDeferrableProseOrSotDebt}，不依赖 issueCodes 截断。
 */
export const NON_DEFERRABLE_PROSE_OR_SOT_ISSUE_CODES = [
  "sot_banned_term",
  "sot_must_avoid_leak",
  "prose_ai_self_reference",
  "prose_placeholder_leak",
  "prose_verbatim_repeat",
  "prose_truncation",
  "prose_system_hud",
  // 指代 AI 味硬门：仅 hard 码；soft density 用 prose_pronoun_density_soft 不入此表
  "prose_pronoun_subject_stack",
  "prose_pronoun_density",
] as const;

const NON_DEFERRABLE_PROSE_OR_SOT_CODE_SET = new Set<string>(
  NON_DEFERRABLE_PROSE_OR_SOT_ISSUE_CODES,
);

export function isNonDeferrableProseOrSotIssueCode(
  code: string | null | undefined,
): boolean {
  if (typeof code !== "string" || !code) {
    return false;
  }
  if (NON_DEFERRABLE_PROSE_OR_SOT_CODE_SET.has(code)) {
    return true;
  }
  // 防御：未来 sot_* 新码仍不可 defer
  return code.startsWith("sot_");
}

/**
 * 政策 L0 不可被 terminalAction=defer_and_continue 降为 non_blocking。
 * 双通道（D1）：
 * 1. prose_quality signal status === "invalid"（主路径，不依赖 issueCodes 截断）
 * 2. 任一 signal.issueCodes 命中 non-deferrable 集合（signal 漏写 invalid 时仍拦）
 */
export function hasNonDeferrableProseOrSotDebt(qualityLoop: unknown): boolean {
  if (!isRecord(qualityLoop)) {
    return false;
  }
  const signals = Array.isArray(qualityLoop.signals) ? qualityLoop.signals : [];
  for (const signal of signals) {
    if (!isRecord(signal)) {
      continue;
    }
    if (
      signal.artifactType === "prose_quality"
      && signal.status === "invalid"
    ) {
      return true;
    }
    const codes = Array.isArray(signal.issueCodes) ? signal.issueCodes : [];
    if (codes.some((code) => isNonDeferrableProseOrSotIssueCode(
      typeof code === "string" ? code : null,
    ))) {
      return true;
    }
  }
  return false;
}

export function classifyChapterQualityLoopRisk(
  qualityLoop: unknown,
): ChapterQualityLoopRiskClassification {
  if (!isRecord(qualityLoop)) {
    return "none";
  }
  const rootCauseCode = qualityLoop.rootCauseCode;
  const recommendedAction = qualityLoop.recommendedAction;
  if (
    rootCauseCode === "replan_required"
    || recommendedAction === "replan"
  ) {
    return "blocking";
  }
  // 设定硬失败 / manual_gate / 政策 L0 invalid 不可被 defer 降级为 non-blocking。
  // pipeline 常在 prose 未达标时写 terminalAction=defer_and_continue；若同时存在
  // setting_alignment 或 sot/critical prose/HUD 债务，导演仍必须视为未 processed。
  if (
    recommendedAction === "manual_gate"
    || hasSettingAlignmentHardInvalidSignal(qualityLoop)
    || hasNonDeferrableProseOrSotDebt(qualityLoop)
  ) {
    return "blocking";
  }
  if (qualityLoop.terminalAction === "defer_and_continue") {
    if (hasEnforceSettingAlignmentDebt(qualityLoop)) {
      return "blocking";
    }
    // 防御：上分支已拦 invalid；此处再读一次，避免未来 early-return 漂移
    if (hasNonDeferrableProseOrSotDebt(qualityLoop)) {
      return "blocking";
    }
    return "non_blocking_quality_debt";
  }
  // 已放行写流：assessment 为 valid+continue 时，勿因历史快照里残留的 blockingObligations 误标 blocking。
  // 样板书曾出现 approved/completed 章仍带 draft_obligation_unmet + obligations 数组，导致债务板噪声与误熔断信号。
  if (qualityLoop.overallStatus === "valid" && recommendedAction === "continue") {
    return "none";
  }
  if (hasBlockingObligations(qualityLoop.blockingObligations)) {
    return "blocking";
  }
  // 仅时间线 deferred 风险：continue 放行写流，记 non-blocking 债，不挡 auto-execution。
  if (
    qualityLoop.overallStatus === "risk"
    && recommendedAction === "continue"
    && hasTimelineExtractionDeferredSignal(qualityLoop)
  ) {
    return "non_blocking_quality_debt";
  }
  // advisory setting_alignment only：risk + continue，不挡 processed / auto-execution。
  if (
    qualityLoop.overallStatus === "risk"
    && recommendedAction === "continue"
    && hasSettingAlignmentAdvisoryOnlySignal(qualityLoop)
  ) {
    return "non_blocking_quality_debt";
  }
  if (qualityLoop.overallStatus === "risk" || qualityLoop.overallStatus === "invalid") {
    return "blocking";
  }
  return "none";
}

function hasSettingAlignmentAdvisoryOnlySignal(qualityLoop: Record<string, unknown>): boolean {
  const signals = Array.isArray(qualityLoop.signals) ? qualityLoop.signals : [];
  const settingSignals = signals.filter((signal) => {
    return isRecord(signal) && signal.artifactType === "setting_alignment";
  });
  if (settingSignals.length === 0) {
    return false;
  }
  const hasAdvisoryRisk = settingSignals.some((signal) => {
    if (!isRecord(signal) || signal.status !== "risk") {
      return false;
    }
    const reason = typeof signal.reason === "string" ? signal.reason : "";
    return reason.includes("advisory") || reason.includes("不阻断");
  });
  if (!hasAdvisoryRisk) {
    return false;
  }
  // 其它 artifact 必须 valid，否则仍按主路径 blocking/risk 处理
  return signals.every((signal) => {
    if (!isRecord(signal)) {
      return true;
    }
    if (signal.artifactType === "setting_alignment") {
      return signal.status === "risk" || signal.status === "valid";
    }
    return signal.status === "valid";
  });
}

function hasTimelineExtractionDeferredSignal(qualityLoop: Record<string, unknown>): boolean {
  const signals = Array.isArray(qualityLoop.signals) ? qualityLoop.signals : [];
  return signals.some((signal) => {
    if (!isRecord(signal) || signal.artifactType !== "continuity_state") {
      return false;
    }
    const codes = Array.isArray(signal.issueCodes) ? signal.issueCodes : [];
    return codes.some((code) => code === "timeline_extraction_deferred");
  });
}

export function classifyChapterQualityLoopRiskFlags(
  riskFlags: string | null | undefined,
): ChapterQualityLoopRiskClassification {
  return classifyChapterQualityLoopRisk(parseRiskFlagsObject(riskFlags)?.qualityLoop);
}

/**
 * L0 清净投影：无 non-deferrable prose/sot/HUD 债务 → true。
 * **≠ literaryPass**（文学三维）；高分 + HUD/sot 仍可为 l0Clear=false。
 * 无 qualityLoop / 不可解析 → null（与 literaryPass 列表语义对齐）。
 */
export function projectL0ClearFromQualityLoop(qualityLoop: unknown): boolean | null {
  if (!isRecord(qualityLoop)) {
    return null;
  }
  // 有 qualityLoop 对象即视为已评估过；以 non-deferrable 双通道为准
  return !hasNonDeferrableProseOrSotDebt(qualityLoop);
}

/**
 * 从章行 riskFlags JSON 投影 l0Clear（qualityLoop 内 prose/sot/HUD）。
 */
export function projectL0ClearFromRiskFlags(
  riskFlags: string | null | undefined,
): boolean | null {
  const parsed = parseRiskFlagsObject(riskFlags);
  if (!parsed) {
    return null;
  }
  return projectL0ClearFromQualityLoop(parsed.qualityLoop);
}

export function hasContinuableChapterQualityLoopRiskFlags(riskFlags: string | null | undefined): boolean {
  const parsed = parseRiskFlagsObject(riskFlags);
  const qualityLoop = parsed?.qualityLoop;
  if (!isRecord(qualityLoop)) {
    return false;
  }
  const classification = classifyChapterQualityLoopRisk(qualityLoop);
  return classification === "non_blocking_quality_debt"
    || (
      classification === "none"
      && qualityLoop.overallStatus === "valid"
      && qualityLoop.recommendedAction === "continue"
    );
}

export interface ChapterQualityLoopAssessmentInput {
  chapterId: string;
  chapterOrder?: number | null;
  score: QualityScore;
  issues: ReviewIssue[];
  runtimePackage?: ChapterRuntimePackage | null;
  evaluatedAt?: string | Date;
  previousRepairHistory?: string | null;
  /**
   * B3 设定对齐评估。缺省 / mode=off 不注入 setting_alignment signal。
   * blocking 只经本 builder 归并进 qualityLoop；详情由调用方写 riskFlags.settingAlignment。
   */
  settingAlignment?: SettingAlignmentAssessment | null;
}

const SEVERITY_RANK: Record<ReviewIssue["severity"], number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function normalizeEvaluatedAt(value: string | Date | undefined): string {
  if (!value) {
    return new Date().toISOString();
  }
  return value instanceof Date ? value.toISOString() : value;
}

function issueCode(issue: ReviewIssue, index: number): string {
  const evidence = issue.evidence.trim().slice(0, 24);
  return `${issue.category}:${issue.severity}:${evidence || index + 1}`;
}

function stableHash(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function normalizeSignaturePart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function buildLoopSignature(action: ChapterQualityLoopAction, signals: ChapterQualityLoopSignal[]): string {
  const failedSignals = signals.filter((signal) => signal.status !== "valid");
  const signatureSignals = failedSignals.length > 0 ? failedSignals : signals;
  const signatureSource = [
    action,
    ...signatureSignals.map((signal) => [
      signal.artifactType,
      signal.status,
      normalizeSignaturePart(signal.reason),
      signal.issueCodes.map(normalizeSignaturePart).sort().slice(0, 6).join("|"),
    ].join(":")),
  ].join("||");
  return `ql:${stableHash(signatureSource)}`;
}

function countPreviousLoopAttempts(previousRepairHistory: string | null | undefined, signature: string): number {
  if (!previousRepairHistory?.trim()) {
    return 0;
  }
  return previousRepairHistory
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes(`signature=${signature}`))
    .length;
}

function resolveBudgetAction(attempt: number): ChapterQualityLoopBudgetAction {
  if (attempt <= 1) {
    return "patch_repair";
  }
  if (attempt === 2) {
    return "rewrite_chapter";
  }
  if (attempt === 3) {
    return "replan_window";
  }
  return "hard_stop";
}

function buildLoopBudget(input: {
  recommendedAction: ChapterQualityLoopAction;
  signals: ChapterQualityLoopSignal[];
  previousRepairHistory?: string | null;
}): ChapterQualityLoopBudget | null {
  if (input.recommendedAction === "continue") {
    return null;
  }
  const signature = buildLoopSignature(input.recommendedAction, input.signals);
  const attempt = countPreviousLoopAttempts(input.previousRepairHistory, signature) + 1;
  const nextAction = resolveBudgetAction(attempt);
  return {
    signature,
    attempt,
    maxAttempts: 3,
    nextAction,
    exhausted: nextAction === "hard_stop",
    reason: nextAction === "hard_stop"
      ? "quality loop budget exhausted for the same failure signature"
      : "quality loop budget selected the next escalation step",
  };
}

function maxSeverity(issues: ReviewIssue[]): number {
  return issues.reduce((max, issue) => Math.max(max, SEVERITY_RANK[issue.severity] ?? 0), 0);
}

function scoreStatus(value: number, hardFloor: number, softFloor: number): ChapterQualityLoopSignalStatus {
  if (value < hardFloor) {
    return "invalid";
  }
  if (value < softFloor) {
    return "risk";
  }
  return "valid";
}

function worseStatus(
  left: ChapterQualityLoopSignalStatus,
  right: ChapterQualityLoopSignalStatus,
): ChapterQualityLoopSignalStatus {
  const rank: Record<ChapterQualityLoopSignalStatus, number> = {
    valid: 0,
    risk: 1,
    missing: 2,
    invalid: 3,
  };
  return rank[right] > rank[left] ? right : left;
}

/**
 * 留存信号的文学三维门槛与 isPass 对齐（80/75/75），去掉历史 65/68 双轨。
 * overall 不再单独做 soft/hard 双门（避免 qualityScore 代理与 literaryPass 混用）。
 * softFloor 取阈值本身：未达 isPass 维即 risk；远低于 hard 带宽记 invalid。
 */
function literaryDimensionStatus(
  value: number,
  passFloor: number,
): ChapterQualityLoopSignalStatus {
  // hard = passFloor - 10：明显不达标 → invalid；passFloor 以下 → risk；≥pass → valid
  return scoreStatus(value, Math.max(0, passFloor - 10), passFloor);
}

function buildRetentionSignal(
  input: ChapterQualityLoopAssessmentInput,
  threshold: QualityIsPassThreshold = DEFAULT_QUALITY_IS_PASS_THRESHOLD,
): ChapterQualityLoopSignal {
  const retentionIssues = input.issues.filter((issue) => (
    issue.category === "pacing"
    || issue.category === "coherence"
    || issue.category === "logic"
  ));
  const scoreDrivenStatus = worseStatus(
    worseStatus(
      literaryDimensionStatus(input.score.engagement, threshold.engagement),
      literaryDimensionStatus(input.score.repetition, threshold.repetition),
    ),
    literaryDimensionStatus(input.score.coherence, threshold.coherence),
  );
  const severityDrivenStatus = maxSeverity(retentionIssues) >= SEVERITY_RANK.critical
    ? "invalid"
    : maxSeverity(retentionIssues) >= SEVERITY_RANK.high
      ? "risk"
      : "valid";
  const status = worseStatus(scoreDrivenStatus, severityDrivenStatus);
  return {
    artifactType: "chapter_retention_contract",
    status,
    reason: status === "valid"
      ? "章节留存信号满足继续推进要求。"
      : "章节留存信号不足，需要优先用局部补丁修复推进目标、读者期待或结尾拉力。",
    issueCodes: retentionIssues.map(issueCode).slice(0, 6),
  };
}

/**
 * 文学门专用 signal：与 isPass 同阈值。
 * pass → valid；单维差 <10 → risk；任一维差 ≥10 → invalid。
 */
function buildLiteraryScoreSignal(
  input: ChapterQualityLoopAssessmentInput,
  threshold: QualityIsPassThreshold = DEFAULT_QUALITY_IS_PASS_THRESHOLD,
): ChapterQualityLoopSignal {
  const { coherence, repetition, engagement } = input.score;
  if (isLiteraryQualityPass(input.score, threshold)) {
    return {
      artifactType: "literary_score",
      status: "valid",
      reason: "文学可读门通过（coherence/repetition/engagement 均达 isPass 阈值）。",
      issueCodes: [],
    };
  }
  const gaps = [
    { code: "literary:coherence", gap: threshold.coherence - coherence },
    { code: "literary:repetition", gap: threshold.repetition - repetition },
    { code: "literary:engagement", gap: threshold.engagement - engagement },
  ].filter((item) => item.gap > 0);
  const farMiss = gaps.some((item) => item.gap >= 10);
  const status: ChapterQualityLoopSignalStatus = farMiss ? "invalid" : "risk";
  return {
    artifactType: "literary_score",
    status,
    reason: status === "invalid"
      ? "文学可读门明显未达 isPass 阈值，需修复后才可质量过审。"
      : "文学可读门接近但未达 isPass，记质量债/局部修复。",
    issueCodes: gaps.map((item) => item.code).slice(0, 6),
  };
}

function buildContinuitySignal(input: ChapterQualityLoopAssessmentInput): ChapterQualityLoopSignal {
  const runtimeIssues = input.runtimePackage?.audit.openIssues ?? [];
  const continuityIssues = input.issues.filter((issue) => (
    issue.category === "coherence" || issue.category === "logic"
  ));
  const runtimeContinuityIssues = runtimeIssues.filter((issue) => (
    issue.auditType === "continuity" || issue.auditType === "character"
  ));
  const worstSeverity = Math.max(
    maxSeverity(continuityIssues),
    runtimeContinuityIssues.some((issue) => issue.severity === "critical")
      ? SEVERITY_RANK.critical
      : runtimeContinuityIssues.some((issue) => issue.severity === "high")
        ? SEVERITY_RANK.high
        : runtimeContinuityIssues.some((issue) => issue.severity === "medium")
          ? SEVERITY_RANK.medium
          : 0,
  );
  let status: ChapterQualityLoopSignalStatus = worstSeverity >= SEVERITY_RANK.critical
    ? "invalid"
    : worstSeverity >= SEVERITY_RANK.high || input.score.coherence < 75
      ? "risk"
      : "valid";
  const deferredTimeline = isTimelineExtractionDeferred(input);
  if (deferredTimeline) {
    // 热路径故意 defer 时 timelineCheck 多为 info/warning，不得因此记 continuity valid。
    status = worseStatus(status, "risk");
  }
  const issueCodes = [
    ...(deferredTimeline ? ["timeline_extraction_deferred"] : []),
    ...continuityIssues.map(issueCode),
    ...runtimeContinuityIssues.map((issue) => issue.code),
  ].slice(0, 8);
  return {
    artifactType: "continuity_state",
    status,
    reason: deferredTimeline
      ? "时间线抽取仍处于 deferred，不得视为连续性健康；由异步定稿补齐后需重新评估。"
      : status === "valid"
        ? "章节连续性状态可以继续使用。"
        : "章节连续性或人物状态存在风险，需要局部修复后重新评估。",
    issueCodes,
  };
}

/** 热路径 deferred 时间线：evidence / extractorError / issue code 任一命中即视为未完成 continuity。 */
export function isTimelineExtractionDeferred(input: ChapterQualityLoopAssessmentInput): boolean {
  const timelineCheck = input.runtimePackage?.timelineCheck;
  if (timelineCheck) {
    const issues = Array.isArray(timelineCheck.issues) ? timelineCheck.issues : [];
    if (issues.some((issue) => {
      if (!issue || typeof issue !== "object") return false;
      const evidence = "evidence" in issue ? String(issue.evidence ?? "") : "";
      const type = "type" in issue ? String(issue.type ?? "") : "";
      return evidence.includes("timeline_extraction_deferred")
        || type === "timeline_extraction_deferred";
    })) {
      return true;
    }
  }
  const openIssues = input.runtimePackage?.audit.openIssues ?? [];
  if (openIssues.some((issue) => (
    issue.code === "timeline_extraction_deferred"
    || (typeof issue.evidence === "string" && issue.evidence.includes("timeline_extraction_deferred"))
    || (typeof issue.description === "string" && issue.description.includes("timeline_extraction_deferred"))
  ))) {
    return true;
  }
  return false;
}

/** L0 正文机械码：既有 prose_* + SoT/mustAvoid 的 sot_*。 */
export function isProseOrSotIssueCode(code: string | null | undefined): boolean {
  if (typeof code !== "string" || !code) {
    return false;
  }
  return code.startsWith("prose_") || code.startsWith("sot_");
}

/**
 * prose_quality signal（channel-1 契约，冻结）：
 * - **仅** non-deferrable 码（sot_* / critical prose / prose_system_hud）→ **invalid**
 * - 其它 severity≥high（如 prose_negative_flip、prose_engineering_term_leak high）→ **risk**
 * - medium/low → valid（issueCodes 仍保留可观测）
 *
 * 禁止用「任意 high severity」抬 invalid：channel-1 的 invalid 是
 * {@link hasNonDeferrableProseOrSotDebt} 主路径，误抬会把可 defer 的文风债变成硬门。
 *
 * issueCodes 投影仍截断到 8（签名/展示）；门禁以 status=invalid 与
 * channel-2 全量码集合为准，不依赖截断列表。
 */
function buildProseQualitySignal(input: ChapterQualityLoopAssessmentInput): ChapterQualityLoopSignal {
  const proseIssues = input.runtimePackage?.audit.openIssues.filter((issue) => (
    isProseOrSotIssueCode(issue.code)
  )) ?? [];
  if (proseIssues.length === 0) {
    return {
      artifactType: "prose_quality",
      status: "valid",
      reason: "正文自然度/退化检测未发现需要处理的问题。",
      issueCodes: [],
    };
  }

  // channel-1：invalid 仅来自 non-deferrable 集合 / sot_* 前缀，不看 severity  alone
  const hasNonDeferrable = proseIssues.some((issue) => (
    isNonDeferrableProseOrSotIssueCode(issue.code)
  ));
  const worstSeverity = proseIssues.reduce((max, issue) => {
    const rank = SEVERITY_RANK[issue.severity] ?? 0;
    return Math.max(max, rank);
  }, 0);

  let status: ChapterQualityLoopSignalStatus;
  if (hasNonDeferrable) {
    status = "invalid";
  } else if (worstSeverity >= SEVERITY_RANK.high) {
    status = "risk";
  } else {
    status = "valid";
  }

  const hasSot = proseIssues.some((issue) => (
    typeof issue.code === "string" && issue.code.startsWith("sot_")
  ));
  const hasHud = proseIssues.some((issue) => issue.code === "prose_system_hud");

  let reason: string;
  if (status === "valid") {
    reason = "正文存在自然度或节奏提示，可作为后续局部优化参考。";
  } else if (hasSot) {
    reason = "正文命中 SoT 禁词或 mustAvoid 泄漏，需优先局部修复，不得因高 overall 放行。";
  } else if (hasHud) {
    reason = "正文出现系统 HUD / 伪状态面板结构，需优先局部修复，不得因高 overall 放行。";
  } else if (status === "invalid") {
    reason = "正文存在 critical 级机械硬伤（身份泄漏/占位/截断/复读等），需优先局部修复。";
  } else {
    reason = "正文存在明显 AI 句式、退化或工程词泄漏，需要优先做本章局部修复。";
  }

  return {
    artifactType: "prose_quality",
    status,
    reason,
    // 展示/签名截断；门禁不依赖此列表完整性
    issueCodes: proseIssues.map((issue) => issue.code).slice(0, 8),
  };
}

function buildRollingWindowSignal(input: ChapterQualityLoopAssessmentInput): ChapterQualityLoopSignal {
  const replanRecommendation = input.runtimePackage?.replanRecommendation ?? null;
  if (replanRecommendation?.recommended && replanRecommendation.action === "stop_for_replan") {
    return {
      artifactType: "rolling_window_review",
      status: "invalid",
      reason: replanRecommendation.triggerReason || replanRecommendation.reason,
      issueCodes: replanRecommendation.blockingIssueIds.slice(0, 8),
    };
  }
  const reportIssues = input.runtimePackage?.audit?.reports?.flatMap((report) => report.issues) ?? [];
  const blockingReportIssues = reportIssues.filter((issue) => (
    issue.severity === "high" || issue.severity === "critical"
  ));
  const status = input.score.overall < 72 || blockingReportIssues.length > 0
    ? "risk"
    : "valid";
  return {
    artifactType: "rolling_window_review",
    status,
    reason: status === "valid"
      ? "近期章节复盘未发现必须打断后续批次的问题。"
      : "近期章节复盘存在质量风险，需要修复后再继续扩大范围。",
    issueCodes: blockingReportIssues.map((issue) => issue.code).slice(0, 8),
  };
}

function isDeferredTimelineOnlyRisk(signals: ChapterQualityLoopSignal[]): boolean {
  const continuity = signals.find((signal) => signal.artifactType === "continuity_state");
  if (!continuity || continuity.status !== "risk") {
    return false;
  }
  if (!continuity.issueCodes.includes("timeline_extraction_deferred")) {
    return false;
  }
  return signals.every((signal) => (
    signal.artifactType === "continuity_state"
      ? signal.status === "risk"
      : signal.status === "valid"
  ));
}

function isSettingAlignmentOnlyNonBlockingRisk(signals: ChapterQualityLoopSignal[]): boolean {
  const setting = signals.find((signal) => signal.artifactType === "setting_alignment");
  if (!setting || setting.status === "valid") {
    return false;
  }
  // advisory 映射：issueCodes 仍有值但 reason 标明 advisory / 不阻断
  const advisoryHint = setting.reason.includes("advisory") || setting.reason.includes("不阻断");
  if (!advisoryHint) {
    return false;
  }
  return signals.every((signal) => (
    signal.artifactType === "setting_alignment"
      ? signal.status === "risk"
      : signal.status === "valid"
  ));
}

function resolveAction(overallStatus: ChapterQualityLoopSignalStatus, signals: ChapterQualityLoopSignal[]): ChapterQualityLoopAction {
  const rollingWindow = signals.find((signal) => signal.artifactType === "rolling_window_review");
  if (rollingWindow?.status === "invalid") {
    return "replan";
  }
  const setting = signals.find((signal) => signal.artifactType === "setting_alignment");
  if (setting?.status === "invalid") {
    // enforce hard：优先 manual_gate（与 settingAlignment recommendedAction 对齐，避免被 patch 降级）
    return "manual_gate";
  }
  // 仅 deferred 时间线风险：可见于 continuity risk，但不强制 patch（异步定稿补齐）。
  if (overallStatus === "risk" && isDeferredTimelineOnlyRisk(signals)) {
    return "continue";
  }
  // advisory setting-only：risk signal 供债板/可观测，不抬升 repair/blocking
  if (overallStatus === "risk" && isSettingAlignmentOnlyNonBlockingRisk(signals)) {
    return "continue";
  }
  if (setting?.status === "risk" && !isSettingAlignmentOnlyNonBlockingRisk(signals)) {
    return "patch_repair";
  }
  if (overallStatus === "risk" || overallStatus === "invalid") {
    return "patch_repair";
  }
  return "continue";
}

function buildSettingAlignmentSignal(
  input: ChapterQualityLoopAssessmentInput,
): ChapterQualityLoopSignal | null {
  if (!input.settingAlignment) {
    return null;
  }
  const mapped = settingAlignmentToQualityLoopSignal(input.settingAlignment);
  return {
    artifactType: "setting_alignment",
    status: mapped.status,
    reason: mapped.reason,
    issueCodes: mapped.issueCodes,
  };
}

const LENGTH_OBSERVABILITY_TAG_PREFIX = "length_";

function extractLengthObservabilityTags(
  runtimePackage: ChapterRuntimePackage | null | undefined,
): string[] {
  const riskTags = runtimePackage?.meta?.riskTags;
  if (!Array.isArray(riskTags)) {
    return [];
  }
  return Array.from(new Set(
    riskTags
      .map((tag) => String(tag).trim())
      .filter((tag) => tag.startsWith(LENGTH_OBSERVABILITY_TAG_PREFIX)),
  ));
}

export function buildChapterQualityLoopAssessment(
  input: ChapterQualityLoopAssessmentInput,
): ChapterQualityLoopAssessment {
  const baseSignals = [
    buildRetentionSignal(input),
    buildLiteraryScoreSignal(input),
    buildContinuitySignal(input),
    buildProseQualitySignal(input),
    buildRollingWindowSignal(input),
  ];
  const settingSignal = buildSettingAlignmentSignal(input);
  const signals = settingSignal ? [...baseSignals, settingSignal] : baseSignals;
  const overallStatus = signals.reduce<ChapterQualityLoopSignalStatus>(
    (status, signal) => worseStatus(status, signal.status),
    "valid",
  );
  const recommendedAction = resolveAction(overallStatus, signals);
  const budget = buildLoopBudget({
    recommendedAction,
    signals,
    previousRepairHistory: input.previousRepairHistory,
  });
  const effectiveAction = budget?.nextAction === "hard_stop" ? "manual_gate" : recommendedAction;
  const observabilityTags = extractLengthObservabilityTags(input.runtimePackage);
  const settingOnlyAdvisory = settingSignal
    ? isSettingAlignmentOnlyNonBlockingRisk(signals)
    : false;
  // advisory setting-only：overall 保持 risk 可见，但 continue → classify 走 non_blocking/none 边界
  // 与 deferred timeline 一致：risk + continue 时 classify 读 non_blocking_quality_debt 路径
  const pauseReason = effectiveAction === "manual_gate"
    ? (
      settingSignal?.status === "invalid"
        ? "设定对齐硬失败，需要确认修复边界后再继续。"
        : "章节质量存在不可自动放行的问题，需要确认修复边界。"
    )
    : null;
  return {
    chapterId: input.chapterId,
    chapterOrder: input.chapterOrder ?? input.runtimePackage?.context.chapter.order ?? null,
    evaluatedAt: normalizeEvaluatedAt(input.evaluatedAt),
    overallStatus: settingOnlyAdvisory && recommendedAction === "continue"
      ? "risk"
      : overallStatus,
    recommendedAction: effectiveAction,
    patchFirstRequired: budget?.nextAction === "patch_repair" || effectiveAction === "patch_repair",
    recheckRequired: effectiveAction !== "continue",
    pauseReason,
    rootCauseCode: input.runtimePackage?.failureClassification.code ?? null,
    blockingObligations: input.runtimePackage?.failureClassification.blockingObligations ?? [],
    budget,
    signals,
    ...(observabilityTags.length > 0 ? { observabilityTags } : {}),
  };
}
