/**
 * Quality Feedback Packet (QFP) — check → writer/repair/planner bus.
 * Projection on riskFlags.qualityLoop.feedback; blocking still only via
 * classifyChapterQualityLoopRiskFlags(qualityLoop).
 *
 * @see docs/plans/quality-feedback-bus-and-vol2-debt-plan.md
 */

import type { ChapterQualityLoopAssessment } from "./chapterQualityLoop.js";

export const QUALITY_FEEDBACK_VERSION = 1 as const;
export const QUALITY_FEEDBACK_ROLLING_MAX = 3;
export const QUALITY_FEEDBACK_PRIOR_LOOKBACK = 3;
export const QUALITY_FEEDBACK_PRIOR_MAX_ITEMS = 5;
export const QUALITY_FEEDBACK_EVIDENCE_MAX = 3;
export const QUALITY_FEEDBACK_EVIDENCE_CHARS = 80;
export const QUALITY_FEEDBACK_CODES_MAX = 8;
export const QUALITY_FEEDBACK_HINTS_MAX = 5;
export const QUALITY_FEEDBACK_PREPARE_SUMMARY_CHARS = 500;

export type QualityFeedbackSeverity = "soft" | "blocking" | "replan";

export type QualityFeedbackRootCause =
  | "prose_ban"
  | "sot_leak"
  | "obligation_gap"
  | "plan_misaligned"
  | "repetition"
  | "length_drift"
  | "end_loop"
  | "device_hud_border"
  | "unknown";

export type QualityFeedbackRepairDecision = "adopt" | "discard" | "plateau_stop";

export interface QualityFeedbackPacket {
  version: typeof QUALITY_FEEDBACK_VERSION;
  chapterOrder: number;
  chapterId?: string;
  signature: string;
  severity: QualityFeedbackSeverity;
  rootCause: QualityFeedbackRootCause;
  codes: string[];
  evidence: string[];
  mustFix: string[];
  planHints: string[];
  failedPatchCount: number;
  avoidRetry: boolean;
  evaluatedAt: string;
}

export interface QualityDebtAttributionLike {
  sameObligationRepeated?: boolean;
  planMisaligned?: boolean;
  patchAnchorFailed?: boolean;
  lengthVsContentDrift?: boolean;
  missingObligationKinds?: string[];
  firstFailureIssueCodes?: string[];
  secondFailureIssueCodes?: string[];
}

export interface BuildQualityFeedbackInput {
  assessment: Pick<
    ChapterQualityLoopAssessment,
    | "chapterId"
    | "chapterOrder"
    | "evaluatedAt"
    | "overallStatus"
    | "recommendedAction"
    | "rootCauseCode"
    | "blockingObligations"
    | "signals"
    | "observabilityTags"
    | "budget"
  >;
  qualityDebtAttribution?: QualityDebtAttributionLike | null;
  previousFeedback?: QualityFeedbackPacket[] | null;
  repairDecision?: QualityFeedbackRepairDecision | null;
  /** Optional terminalAction from pipeline (e.g. defer_and_continue) */
  terminalAction?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stableHash(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function normalizeCode(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_").slice(0, 96);
}

function truncateEvidence(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= QUALITY_FEEDBACK_EVIDENCE_CHARS) {
    return text;
  }
  return `${text.slice(0, QUALITY_FEEDBACK_EVIDENCE_CHARS - 1)}…`;
}

export function buildQualityFeedbackSignature(input: {
  rootCause: string;
  codes: string[];
  chapterOrder: number;
}): string {
  const codes = Array.from(
    new Set(
      (input.codes ?? [])
        .map((code) => normalizeCode(String(code)))
        .filter(Boolean),
    ),
  )
    .sort()
    .slice(0, 6)
    .join(",");
  const source = [
    String(input.rootCause || "unknown").trim().toLowerCase(),
    codes,
    String(Math.round(Number(input.chapterOrder) || 0)),
  ].join("\n");
  return `qfb:${stableHash(source)}`;
}

/** Rewrite path uses a distinct key so patch avoidRetry does not block rewrite. */
export function buildQualityFeedbackRewriteSignature(signature: string): string {
  return `${signature}:rewrite`;
}

function collectCodes(input: BuildQualityFeedbackInput): string[] {
  const codes: string[] = [];
  for (const signal of input.assessment.signals ?? []) {
    if (signal.status === "valid") {
      continue;
    }
    for (const code of signal.issueCodes ?? []) {
      if (typeof code === "string" && code.trim()) {
        codes.push(code.trim());
      }
    }
  }
  const attribution = input.qualityDebtAttribution;
  for (const code of attribution?.firstFailureIssueCodes ?? []) {
    if (typeof code === "string" && code.trim()) {
      codes.push(code.trim());
    }
  }
  for (const code of attribution?.secondFailureIssueCodes ?? []) {
    if (typeof code === "string" && code.trim()) {
      codes.push(code.trim());
    }
  }
  for (const tag of input.assessment.observabilityTags ?? []) {
    if (typeof tag === "string" && tag.startsWith("length_")) {
      codes.push(tag);
    }
  }
  if (input.assessment.rootCauseCode) {
    codes.push(String(input.assessment.rootCauseCode));
  }
  return Array.from(new Set(codes.map(normalizeCode).filter(Boolean)))
    .sort()
    .slice(0, QUALITY_FEEDBACK_CODES_MAX);
}

function isProseBanCode(code: string): boolean {
  return code.startsWith("prose_")
    || code.includes("banned_term")
    || code.includes("sot_banned");
}

function isSotLeakCode(code: string): boolean {
  return code.includes("sot_must_avoid")
    || code.includes("must_avoid")
    || code.includes("sot_leak");
}

function isRepetitionCode(code: string): boolean {
  return code.includes("repetition")
    || code.includes("end_loop")
    || code.includes("duplicate");
}

function isLengthCode(code: string): boolean {
  return code.startsWith("length_")
    || code.includes("length_over")
    || code.includes("length_under");
}

function isHudCode(code: string): boolean {
  return code.includes("hud") || code.includes("device_ui") || code.includes("system_panel");
}

export function resolveQualityFeedbackRootCause(input: {
  codes: string[];
  qualityDebtAttribution?: QualityDebtAttributionLike | null;
  rootCauseCode?: string | null;
  signals?: ChapterQualityLoopAssessment["signals"];
}): QualityFeedbackRootCause {
  const codes = input.codes.map(normalizeCode);
  if (codes.some(isSotLeakCode)) {
    return "sot_leak";
  }
  if (codes.some(isProseBanCode)) {
    return "prose_ban";
  }
  if (input.qualityDebtAttribution?.planMisaligned) {
    return "plan_misaligned";
  }
  if (
    input.qualityDebtAttribution?.missingObligationKinds?.length
    || input.rootCauseCode === "draft_obligation_unmet"
    || codes.some((code) => code.includes("obligation"))
  ) {
    return "obligation_gap";
  }
  if (codes.some((code) => code.includes("end_loop"))) {
    return "end_loop";
  }
  if (codes.some(isRepetitionCode)) {
    return "repetition";
  }
  if (codes.some(isLengthCode) || input.qualityDebtAttribution?.lengthVsContentDrift) {
    return "length_drift";
  }
  if (codes.some(isHudCode)) {
    return "device_hud_border";
  }
  // literary repetition dimension often has no prose code
  const literary = (input.signals ?? []).find((signal) => signal.artifactType === "literary_score");
  if (literary && literary.status !== "valid" && literary.issueCodes.some((c) => c.includes("repetition"))) {
    return "repetition";
  }
  return "unknown";
}

function resolveSeverity(input: {
  recommendedAction: ChapterQualityLoopAssessment["recommendedAction"];
  rootCauseCode?: string | null;
  codes: string[];
  avoidRetry: boolean;
}): QualityFeedbackSeverity {
  if (
    input.recommendedAction === "replan"
    || input.rootCauseCode === "replan_required"
  ) {
    return "replan";
  }
  // patch_repair alone stays soft (literary / length soft path). Blocking only for
  // hard codes, manual_gate, avoidRetry (discard/plateau/budget), or replan above.
  if (
    input.avoidRetry
    || input.recommendedAction === "manual_gate"
    || input.codes.some((code) => isProseBanCode(code) || isSotLeakCode(code) || code.includes("obligation"))
  ) {
    return "blocking";
  }
  return "soft";
}

function termsFromCodes(codes: string[], limit = 4): string {
  const terms = codes
    .map((code) => code.replace(/^(prose_|sot_|literary:|length_)/, ""))
    .filter(Boolean)
    .slice(0, limit);
  return terms.length > 0 ? terms.join("、") : "相关硬伤码";
}

function obligationKinds(input: BuildQualityFeedbackInput): string {
  const kinds = input.qualityDebtAttribution?.missingObligationKinds?.filter(Boolean) ?? [];
  if (kinds.length > 0) {
    return kinds.slice(0, 5).join("、");
  }
  const fromBlocking = (input.assessment.blockingObligations ?? [])
    .map((item) => ("kind" in item && typeof item.kind === "string" ? item.kind : item.summary))
    .filter(Boolean)
    .slice(0, 5);
  return fromBlocking.length > 0 ? fromBlocking.join("、") : "未兑现义务";
}

export function buildMustFixAndPlanHints(input: {
  rootCause: QualityFeedbackRootCause;
  codes: string[];
  qualityDebtAttribution?: QualityDebtAttributionLike | null;
  assessment: BuildQualityFeedbackInput["assessment"];
}): { mustFix: string[]; planHints: string[] } {
  const terms = termsFromCodes(input.codes);
  switch (input.rootCause) {
    case "prose_ban":
      return {
        mustFix: [
          `正文禁止出现禁词/废弃术语族（命中：${terms}）；改用角色口语或动作表达同一意图，勿系统口令腔。`,
        ],
        planHints: [
          // Do not spell banned terms here — they would re-enter planner/writer context.
          "合同与杂讯/系统口令不得要求机械度量或已废弃术语族（见 mustAvoid / prose ban codes）；改为可执行的行为目标。",
        ],
      };
    case "sot_leak":
      return {
        mustFix: [
          `删除或替换 mustAvoid / 串台名泄漏（命中：${terms}）；角色身份用本合同口径内称呼。`,
        ],
        planHints: [
          "修订角色表与 mustAvoid：去掉错误 cast；脏接口人改用本卷身份，勿卷一校园名串台。",
        ],
      };
    case "obligation_gap": {
      const kinds = obligationKinds({
        assessment: input.assessment,
        qualityDebtAttribution: input.qualityDebtAttribution,
      } as BuildQualityFeedbackInput);
      return {
        mustFix: [
          `在场景内自然补齐未兑现义务：${kinds}；禁止清单腔报幕。`,
        ],
        planHints: [
          "削减或改写本窗 taskSheet 中冲突/过载义务，使场面可一次写清。",
        ],
      };
    }
    case "plan_misaligned":
      return {
        mustFix: [
          "勿同时满足互相矛盾的场面指令；以主场景因果与已写事实为准。",
        ],
        planHints: [
          "修订 taskSheet 矛盾条（角色在场/独占事件/口径冲突）后再生成，勿只靠 patch。",
        ],
      };
    case "repetition":
      return {
        mustFix: [
          "删除章内/跨段同句复读；勿回放已闭合节拍。",
        ],
        planHints: [
          "下章勿重复本章已完成的动作与意象清单。",
        ],
      };
    case "end_loop":
      return {
        mustFix: [
          "删除章末重复段落；结尾只保留一次收束与钩子。",
        ],
        planHints: [
          "合同勿要求章末回环复述上一节原文。",
        ],
      };
    case "length_drift":
      return {
        mustFix: [
          "按场景完整度调整篇幅：过短补关键节拍，过长删重复描写（非机械凑字）。",
        ],
        planHints: [
          "过长章可拆场景义务；过短章补必要在场与因果，勿只堆形容词。",
        ],
      };
    case "device_hud_border":
      return {
        mustFix: [
          "【】仅可用于角色可见的设备/短信 UI；禁止叙述层系统 HUD 面板腔。",
        ],
        planHints: [
          "合同勿要求系统面板式【标签】推进剧情。",
        ],
      };
    default:
      return {
        mustFix: [
          input.assessment.signals
            ?.filter((signal) => signal.status !== "valid")
            .slice(0, 2)
            .map((signal) => signal.reason)
            .filter(Boolean)[0]
            || "按审校 issues 修复连贯、义务与硬伤后再提交。",
        ],
        planHints: [
          "根据 qualityLoop 失败信号调整本窗合同义务与禁写项，勿无根因连打同路径 patch。",
        ],
      };
  }
}

function buildEvidence(input: BuildQualityFeedbackInput): string[] {
  const lines: string[] = [];
  for (const signal of input.assessment.signals ?? []) {
    if (signal.status === "valid") {
      continue;
    }
    if (signal.reason?.trim()) {
      lines.push(truncateEvidence(signal.reason));
    }
    if (lines.length >= QUALITY_FEEDBACK_EVIDENCE_MAX) {
      break;
    }
  }
  return lines.slice(0, QUALITY_FEEDBACK_EVIDENCE_MAX);
}

/**
 * Whether to append a QFP (avoid valid+continue spam unless hard codes / repair fail).
 */
export function shouldEmitQualityFeedback(input: BuildQualityFeedbackInput): boolean {
  if (input.repairDecision === "discard" || input.repairDecision === "plateau_stop") {
    return true;
  }
  if (input.assessment.recommendedAction !== "continue") {
    return true;
  }
  const codes = collectCodes(input);
  if (codes.some((code) => isProseBanCode(code) || isSotLeakCode(code))) {
    return true;
  }
  if (input.qualityDebtAttribution?.planMisaligned || input.qualityDebtAttribution?.missingObligationKinds?.length) {
    return true;
  }
  return false;
}

export function parseQualityFeedbackList(value: unknown): QualityFeedbackPacket[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const packets: QualityFeedbackPacket[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    if (item.version !== 1) {
      continue;
    }
    if (typeof item.signature !== "string" || !item.signature.trim()) {
      continue;
    }
    if (typeof item.rootCause !== "string") {
      continue;
    }
    packets.push({
      version: 1,
      chapterOrder: typeof item.chapterOrder === "number" ? item.chapterOrder : 0,
      chapterId: typeof item.chapterId === "string" ? item.chapterId : undefined,
      signature: item.signature,
      severity: item.severity === "replan" || item.severity === "blocking" || item.severity === "soft"
        ? item.severity
        : "soft",
      rootCause: item.rootCause as QualityFeedbackRootCause,
      codes: Array.isArray(item.codes)
        ? item.codes.filter((code): code is string => typeof code === "string").slice(0, QUALITY_FEEDBACK_CODES_MAX)
        : [],
      evidence: Array.isArray(item.evidence)
        ? item.evidence.filter((line): line is string => typeof line === "string").slice(0, QUALITY_FEEDBACK_EVIDENCE_MAX)
        : [],
      mustFix: Array.isArray(item.mustFix)
        ? item.mustFix.filter((line): line is string => typeof line === "string").slice(0, QUALITY_FEEDBACK_HINTS_MAX)
        : [],
      planHints: Array.isArray(item.planHints)
        ? item.planHints.filter((line): line is string => typeof line === "string").slice(0, QUALITY_FEEDBACK_HINTS_MAX)
        : [],
      failedPatchCount: typeof item.failedPatchCount === "number" ? Math.max(0, item.failedPatchCount) : 0,
      avoidRetry: Boolean(item.avoidRetry),
      evaluatedAt: typeof item.evaluatedAt === "string" ? item.evaluatedAt : new Date().toISOString(),
    });
  }
  return packets;
}

export function extractQualityFeedbackFromRiskFlags(
  riskFlags: string | null | undefined,
): QualityFeedbackPacket[] {
  if (!riskFlags?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(riskFlags) as unknown;
    if (!isRecord(parsed)) {
      return [];
    }
    const qualityLoop = parsed.qualityLoop;
    if (!isRecord(qualityLoop)) {
      return [];
    }
    return parseQualityFeedbackList(qualityLoop.feedback);
  } catch {
    return [];
  }
}

/**
 * Projection-only merge: write/replace qualityLoop.feedback without rewriting
 * assessment / source / qualityDebtAttribution / settingAlignment / status.
 * Empty feedback removes the feedback key but keeps the rest of qualityLoop.
 */
export function mergeQualityFeedbackIntoRiskFlags(
  previousRiskFlags: string | null | undefined,
  feedback: QualityFeedbackPacket[],
): string {
  let parsed: Record<string, unknown> = {};
  if (previousRiskFlags?.trim()) {
    try {
      const raw = JSON.parse(previousRiskFlags) as unknown;
      if (isRecord(raw)) {
        parsed = { ...raw };
      }
    } catch {
      parsed = {};
    }
  }
  const previousLoop = isRecord(parsed.qualityLoop) ? { ...parsed.qualityLoop } : {};
  if (feedback.length > 0) {
    previousLoop.feedback = feedback;
  } else {
    delete previousLoop.feedback;
  }
  return JSON.stringify({
    ...parsed,
    qualityLoop: previousLoop,
  });
}

export function mergeQualityFeedbackList(
  previous: QualityFeedbackPacket[] | null | undefined,
  next: QualityFeedbackPacket,
): QualityFeedbackPacket[] {
  const list = [...(previous ?? [])];
  const index = list.findIndex((item) => item.signature === next.signature);
  if (index >= 0) {
    list[index] = next;
  } else {
    list.push(next);
  }
  return list.slice(-QUALITY_FEEDBACK_ROLLING_MAX);
}

export function buildQualityFeedbackPacket(
  input: BuildQualityFeedbackInput,
): QualityFeedbackPacket | null {
  if (!shouldEmitQualityFeedback(input)) {
    return null;
  }

  const codes = collectCodes(input);
  const rootCause = resolveQualityFeedbackRootCause({
    codes,
    qualityDebtAttribution: input.qualityDebtAttribution,
    rootCauseCode: input.assessment.rootCauseCode,
    signals: input.assessment.signals,
  });
  const chapterOrder = typeof input.assessment.chapterOrder === "number"
    ? input.assessment.chapterOrder
    : 0;
  const signature = buildQualityFeedbackSignature({
    rootCause,
    codes,
    chapterOrder,
  });

  const previous = (input.previousFeedback ?? []).find((item) => item.signature === signature);
  let failedPatchCount = previous?.failedPatchCount ?? 0;
  if (input.repairDecision === "discard" || input.repairDecision === "plateau_stop") {
    failedPatchCount += 1;
  }
  // plateau always avoids further auto patch; single discard also blocks same signature auto re-patch (plan A)
  const avoidRetry = Boolean(
    previous?.avoidRetry
    || input.repairDecision === "plateau_stop"
    || failedPatchCount >= 1
    || (input.assessment.budget?.exhausted === true),
  );

  const { mustFix, planHints } = buildMustFixAndPlanHints({
    rootCause,
    codes,
    qualityDebtAttribution: input.qualityDebtAttribution,
    assessment: input.assessment,
  });

  return {
    version: 1,
    chapterOrder,
    chapterId: input.assessment.chapterId,
    signature,
    severity: resolveSeverity({
      recommendedAction: input.assessment.recommendedAction,
      rootCauseCode: input.assessment.rootCauseCode,
      codes,
      avoidRetry,
    }),
    rootCause,
    codes,
    evidence: buildEvidence(input),
    mustFix: mustFix.slice(0, QUALITY_FEEDBACK_HINTS_MAX),
    planHints: planHints.slice(0, QUALITY_FEEDBACK_HINTS_MAX),
    failedPatchCount,
    avoidRetry,
    evaluatedAt: input.assessment.evaluatedAt,
  };
}

/**
 * Decide whether auto light-patch should be blocked.
 *
 * - With `signature`: only that signature's avoidRetry blocks (same-sign re-patch).
 * - Without `signature` (repair entry): chapter-scope — any sticky avoidRetry forces
 *   heavy rewrite (A2). Soft literary packets without avoidRetry never block.
 *
 * Single discard sets avoidRetry (plan A threshold); sticky until a later packet
 * overwrites the signature with avoidRetry=false (not currently emitted on adopt).
 */
export function isAutoPatchAvoidedByFeedback(
  feedback: QualityFeedbackPacket[] | null | undefined,
  signature?: string | null,
): { avoided: boolean; packet?: QualityFeedbackPacket; reason: string } {
  const list = feedback ?? [];
  if (signature) {
    const hit = list.find((item) => item.signature === signature && item.avoidRetry);
    if (hit) {
      return {
        avoided: true,
        packet: hit,
        reason: `同签名自动 patch 已 avoidRetry（signature=${hit.signature}，failedPatchCount=${hit.failedPatchCount}）。请 rewrite 或修订 taskSheet 后再试。`,
      };
    }
    // Signature supplied but no match → do not widen to other root causes.
    return { avoided: false, reason: "" };
  }
  const anyAvoid = list.find((item) => item.avoidRetry);
  if (anyAvoid) {
    return {
      avoided: true,
      packet: anyAvoid,
      reason: `章节存在 avoidRetry 质量反馈（signature=${anyAvoid.signature}，failedPatchCount=${anyAvoid.failedPatchCount}）。请 rewrite 或改合同，勿同路径连 patch。`,
    };
  }
  return { avoided: false, reason: "" };
}

export function isAutoPatchAvoidedByRiskFlags(
  riskFlags: string | null | undefined,
  signature?: string | null,
): { avoided: boolean; packet?: QualityFeedbackPacket; reason: string } {
  return isAutoPatchAvoidedByFeedback(extractQualityFeedbackFromRiskFlags(riskFlags), signature);
}

export function formatPriorQualityFeedbackLines(
  packets: QualityFeedbackPacket[],
  options?: { maxItems?: number },
): string[] {
  const maxItems = options?.maxItems ?? QUALITY_FEEDBACK_PRIOR_MAX_ITEMS;
  const sorted = [...packets].sort((left, right) => {
    const rank = (severity: QualityFeedbackSeverity) => (
      severity === "replan" ? 0 : severity === "blocking" ? 1 : 2
    );
    const severityDelta = rank(left.severity) - rank(right.severity);
    if (severityDelta !== 0) {
      return severityDelta;
    }
    return right.chapterOrder - left.chapterOrder;
  });
  return sorted.slice(0, maxItems).map((packet) => {
    const fix = packet.mustFix[0] ?? packet.planHints[0] ?? packet.rootCause;
    return `第${packet.chapterOrder}章 [${packet.severity}/${packet.rootCause}] ${fix}${packet.avoidRetry ? "（禁同签自动 patch）" : ""}`;
  });
}

export function buildQualityFeedbackWindowSummary(
  packets: QualityFeedbackPacket[],
  maxChars = QUALITY_FEEDBACK_PREPARE_SUMMARY_CHARS,
): string {
  if (packets.length === 0) {
    return "";
  }
  const lines = formatPriorQualityFeedbackLines(packets, { maxItems: 8 });
  const header = `priorWindowQualityDebt：${packets.length} 条反馈（blocking 优先）`;
  const body = [header, ...lines.map((line) => `- ${line}`)].join("\n");
  if (body.length <= maxChars) {
    return body;
  }
  return `${body.slice(0, maxChars - 1)}…`;
}

export function compactQualityFeedbackForPlanner(
  packets: QualityFeedbackPacket[],
  maxPackets = 8,
): Array<Record<string, unknown>> {
  return packets.slice(0, maxPackets).map((packet) => ({
    chapterOrder: packet.chapterOrder,
    severity: packet.severity,
    rootCause: packet.rootCause,
    signature: packet.signature,
    codes: packet.codes.slice(0, 6),
    planHints: packet.planHints.slice(0, 3),
    mustFix: packet.mustFix.slice(0, 2),
    avoidRetry: packet.avoidRetry,
    failedPatchCount: packet.failedPatchCount,
  }));
}
