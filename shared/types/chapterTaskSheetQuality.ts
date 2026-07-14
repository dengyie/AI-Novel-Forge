import { z } from "zod";
import { parseChapterScenePlan } from "./chapterLengthControl.js";

export const CHAPTER_TASK_SHEET_QUALITY_MODES = [
  "full_book_autopilot",
  "ai_copilot",
  "manual",
] as const;

export type ChapterTaskSheetQualityMode = typeof CHAPTER_TASK_SHEET_QUALITY_MODES[number];

export const CHAPTER_TASK_SHEET_QUALITY_ISSUE_SEVERITIES = [
  "low",
  "medium",
  "high",
] as const;

export type ChapterTaskSheetQualityIssueSeverity = typeof CHAPTER_TASK_SHEET_QUALITY_ISSUE_SEVERITIES[number];

export const CHAPTER_TASK_SHEET_QUALITY_STATUS = [
  "passed",
  "repairable",
  "needs_confirmation",
  "blocked",
] as const;

export type ChapterTaskSheetQualityStatus = typeof CHAPTER_TASK_SHEET_QUALITY_STATUS[number];

/** 章节任务单叙事分型：用于义务负载与写作指令差异，不是物理卷类型。 */
export const CHAPTER_TASK_SHEET_TYPES = [
  "emotion",
  "combat",
  "explore",
  "transition",
] as const;

export type ChapterTaskSheetType = typeof CHAPTER_TASK_SHEET_TYPES[number];

export interface ChapterTaskSheetObligationBudget {
  chapterType: ChapterTaskSheetType;
  /** 建议的 must-hit / payoff 类义务上限（情感章更低） */
  maxHardObligationHints: number;
  /** taskSheet 中建议的短句/条目上限 */
  maxTaskSheetBulletHints: number;
  labelZh: string;
}

export interface ChapterExecutionContractQualityCandidate {
  novelId: string;
  volumeId?: string | null;
  chapterId: string;
  chapterOrder: number;
  title: string;
  summary?: string | null;
  purpose?: string | null;
  exclusiveEvent?: string | null;
  endingState?: string | null;
  nextChapterEntryState?: string | null;
  conflictLevel?: number | null;
  revealLevel?: number | null;
  targetWordCount?: number | null;
  mustAvoid?: string | null;
  payoffRefs?: string[] | null;
  taskSheet?: string | null;
  sceneCards?: string | null;
  /** 可选：上游已判定的章型；缺省则从文本推断 */
  chapterType?: ChapterTaskSheetType | null;
}

export interface ChapterTaskSheetQualityIssue {
  id: string;
  severity: ChapterTaskSheetQualityIssueSeverity;
  target: "purpose" | "boundary" | "task_sheet" | "scene_cards" | "semantic";
  summary: string;
  repairHint: string;
}

export interface ChapterTaskSheetQualityGateResult {
  status: ChapterTaskSheetQualityStatus;
  canEnterExecution: boolean;
  issues: ChapterTaskSheetQualityIssue[];
  summary: string;
  repairGuidance: string[];
  confidence: number;
}

function normalizeAssessmentVerdict(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["pass", "passed", "accepted", "accept", "ok", "okay", "valid", "use_as_is"].includes(normalized)) {
    return "usable";
  }
  if (["fixable", "needs_repair", "repair", "needs_fix", "repair_contract"].includes(normalized)) {
    return "repairable";
  }
  if (["blocked", "block", "replan", "unusable", "invalid", "reject", "replan_window"].includes(normalized)) {
    return "unusable";
  }
  return normalized;
}

function normalizeAssessmentIssueTarget(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["goal", "objective", "chapter_goal", "mission"].includes(normalized)) {
    return "purpose";
  }
  if (["scope", "cross_boundary", "boundary_crossing", "chapter_boundary", "range"].includes(normalized)) {
    return "boundary";
  }
  if (["task", "task_sheet", "tasksheet", "task_list", "chapter_task_sheet"].includes(normalized)) {
    return "task_sheet";
  }
  if (["scene", "scene_card", "scene_cards", "scenes", "scene_plan"].includes(normalized)) {
    return "scene_cards";
  }
  if ([
    "plot",
    "pacing",
    "pace",
    "load",
    "overload",
    "overloaded",
    "obligation",
    "obligations",
    "repetition",
    "active_action",
    "action",
    "character_action",
    "semantic",
  ].includes(normalized)) {
    return "semantic";
  }
  return normalized;
}

function normalizeAssessmentConfidence(value: unknown): unknown {
  const numeric = typeof value === "string" && value.trim()
    ? Number(value.trim())
    : typeof value === "number"
      ? value
      : NaN;
  if (!Number.isFinite(numeric)) {
    return value;
  }
  if (numeric > 1 && numeric <= 100) {
    return numeric / 100;
  }
  return numeric;
}

export const chapterTaskSheetQualityIssueSchema = z.object({
  id: z.string().trim().min(1),
  severity: z.enum(CHAPTER_TASK_SHEET_QUALITY_ISSUE_SEVERITIES),
  target: z.preprocess(
    normalizeAssessmentIssueTarget,
    z.enum(["purpose", "boundary", "task_sheet", "scene_cards", "semantic"]),
  ),
  summary: z.string().trim().min(1),
  repairHint: z.string().trim().min(1),
});

export const aiChapterTaskSheetQualityAssessmentSchema = z.object({
  verdict: z.preprocess(normalizeAssessmentVerdict, z.enum(["usable", "repairable", "unusable"])),
  safeToSync: z.boolean(),
  loadRisk: z.enum(["normal", "overloaded"]).default("normal"),
  recommendedHandling: z.enum(["use_as_is", "repair_contract", "replan_window"]).default("use_as_is"),
  summary: z.string().trim().min(1),
  issues: z.array(chapterTaskSheetQualityIssueSchema).max(8).default([]),
  repairGuidance: z.array(z.string().trim().min(1)).max(8).default([]),
  confidence: z.preprocess(normalizeAssessmentConfidence, z.number().min(0).max(1)),
});

export type AiChapterTaskSheetQualityAssessment = z.infer<typeof aiChapterTaskSheetQualityAssessmentSchema>;

function hasText(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

function createQualityIssue(
  id: string,
  target: ChapterTaskSheetQualityIssue["target"],
  summary: string,
  repairHint: string,
  severity: ChapterTaskSheetQualityIssueSeverity = "high",
): ChapterTaskSheetQualityIssue {
  return {
    id,
    target,
    severity,
    summary,
    repairHint,
  };
}

/**
 * 质量环/失败分类等内部 code，不得写入作家可读 taskSheet / 写作指令正文。
 *
 * 注意：`payoff_*` 不使用裸通配 `payoff_[a-z0-9_]+`，因为 `payoff_touch` 是合法的作家义务 kind
 * （directorRuntime / chapterRuntime），`payoff_directives` 是合法上下文分组——通配会误删这些自然义务条目。
 * 仅匹配内部质量信号 code（由 PayoffLedgerSync / payoffLedgerShared 产出，流入 riskFlags/审计
 * issue，经 NovelPromptMaterialExporter/workspaceDiagnosis 格式化为 `[sev/code] ...` 作家上下文，
 * 属内部 code，不应再被 LLM 鹦鹉回灌进作家可读 taskSheet）：payoff_missing_progress / payoff_overdue /
 * payoff_regressed / payoff_premature_overdue_demoted / payoff_paid_without_setup / payoff_window_extended。
 * 新增同类内部信号 code 时需在此显式补全——不使用通配是为了保留 payoff_touch 等合法面向作家的 kind。
 */
const INTERNAL_QUALITY_CODE_PATTERN = /\b(?:payoff_missing_progress|payoff_overdue|payoff_regressed|payoff_premature_overdue_demoted|payoff_paid_without_setup|payoff_window_extended|draft_obligation_unmet|draft_repair_exhausted|draft_generation_failed|replan_required|replan_window|hard_stop|must_hit_now|forbidden_crossing|prose_[a-z0-9_]+|timeline_[a-z0-9_]+|rootCauseCode|recommendedAction)\b/gi;

export function stripInternalQualityCodes(text: string | null | undefined): string {
  if (!text) {
    return "";
  }
  return text
    .replace(INTERNAL_QUALITY_CODE_PATTERN, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function containsInternalQualityCodes(text: string | null | undefined): boolean {
  if (!text?.trim()) {
    return false;
  }
  INTERNAL_QUALITY_CODE_PATTERN.lastIndex = 0;
  return INTERNAL_QUALITY_CODE_PATTERN.test(text);
}

/**
 * Persist-path sanitize: strip internal quality/failure codes and collapse empty noise.
 * Does not rewrite narrative obligations (no overload bullet pruning).
 */
export function sanitizeChapterTaskSheetForPersistence(
  text: string | null | undefined,
): string | null {
  if (text == null) {
    return null;
  }
  const stripped = stripInternalQualityCodes(text)
    .replace(/^\s*[-*]\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return stripped.length > 0 ? stripped : null;
}

/** Writer-facing / layered-context sanitize (same strip, never null — empty string ok). */
export function sanitizeWriterFacingTaskSheet(text: string | null | undefined): string {
  return sanitizeChapterTaskSheetForPersistence(text) ?? "";
}

/**
 * Service-layer repair for internal codes only. assess stays pure.
 */
export function tryAutoRepairInternalCodesOnly(
  candidate: ChapterExecutionContractQualityCandidate,
): {
  repaired: ChapterExecutionContractQualityCandidate;
  stripped: boolean;
  emptiedTaskSheet: boolean;
} {
  const original = candidate.taskSheet ?? "";
  if (!containsInternalQualityCodes(original)) {
    return { repaired: candidate, stripped: false, emptiedTaskSheet: false };
  }
  const sanitized = sanitizeChapterTaskSheetForPersistence(original);
  return {
    repaired: {
      ...candidate,
      taskSheet: sanitized,
    },
    stripped: true,
    emptiedTaskSheet: !sanitized,
  };
}

export function getChapterTaskSheetObligationBudget(
  chapterType: ChapterTaskSheetType,
): ChapterTaskSheetObligationBudget {
  switch (chapterType) {
    case "emotion":
      return {
        chapterType,
        maxHardObligationHints: 2,
        maxTaskSheetBulletHints: 4,
        labelZh: "情感/关系",
      };
    case "combat":
      return {
        chapterType,
        maxHardObligationHints: 5,
        maxTaskSheetBulletHints: 8,
        labelZh: "战斗/对抗",
      };
    case "explore":
      return {
        chapterType,
        maxHardObligationHints: 4,
        maxTaskSheetBulletHints: 7,
        labelZh: "探索/发现",
      };
    case "transition":
    default:
      return {
        chapterType: "transition",
        maxHardObligationHints: 3,
        maxTaskSheetBulletHints: 5,
        labelZh: "过渡/转场",
      };
  }
}

function scoreChapterTypeHints(blob: string): Record<ChapterTaskSheetType, number> {
  const text = blob.toLowerCase();
  const score: Record<ChapterTaskSheetType, number> = {
    emotion: 0,
    combat: 0,
    explore: 0,
    transition: 0,
  };
  const bump = (type: ChapterTaskSheetType, weight: number, patterns: RegExp[]) => {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        score[type] += weight;
      }
    }
  };
  bump("emotion", 3, [/情感|关系|羁绊|告白|心动|和解|误会|陪伴|安慰|愧疚|吃醋|亲密|养成/]);
  bump("combat", 3, [/战斗|对决|交手|厮杀|追击|突围|杀|战|冲突升级|敌人|伏击|对轰/]);
  bump("explore", 3, [/探索|调查|搜|发现|线索|遗迹|地图|情报|潜入|勘察|解密/]);
  bump("transition", 2, [/过渡|转场|赶路|休整|安顿|整理|铺垫|衔接|喘息|整备/]);
  return score;
}

/**
 * 从标题/摘要/目标/任务单推断章型。显式 chapterType 优先。
 * 冲突强度高时偏向 combat；无明显信号则 transition。
 */
export function inferChapterTaskSheetType(
  candidate: Pick<
    ChapterExecutionContractQualityCandidate,
    "title" | "summary" | "purpose" | "exclusiveEvent" | "taskSheet" | "conflictLevel" | "chapterType"
  >,
): ChapterTaskSheetType {
  if (
    candidate.chapterType
    && (CHAPTER_TASK_SHEET_TYPES as readonly string[]).includes(candidate.chapterType)
  ) {
    return candidate.chapterType;
  }
  const blob = [
    candidate.title,
    candidate.summary,
    candidate.purpose,
    candidate.exclusiveEvent,
    candidate.taskSheet,
  ].filter(Boolean).join("\n");
  const scores = scoreChapterTypeHints(blob);
  if (typeof candidate.conflictLevel === "number") {
    if (candidate.conflictLevel >= 70) {
      scores.combat += 2;
    } else if (candidate.conflictLevel <= 30) {
      scores.emotion += 1;
      scores.transition += 1;
    }
  }
  let best: ChapterTaskSheetType = "transition";
  let bestScore = -1;
  for (const type of CHAPTER_TASK_SHEET_TYPES) {
    if (scores[type] > bestScore) {
      best = type;
      bestScore = scores[type];
    }
  }
  return bestScore <= 0 ? "transition" : best;
}

function countTaskSheetBulletHints(taskSheet: string): number {
  const lines = taskSheet
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length >= 2) {
    return lines.length;
  }
  const parts = taskSheet
    .split(/[；;。!！?？]/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4);
  return Math.max(parts.length, taskSheet.trim() ? 1 : 0);
}

export function assessChapterExecutionContractShape(
  candidate: ChapterExecutionContractQualityCandidate,
): ChapterTaskSheetQualityGateResult {
  const issues: ChapterTaskSheetQualityIssue[] = [];
  const chapterType = inferChapterTaskSheetType(candidate);
  const budget = getChapterTaskSheetObligationBudget(chapterType);

  if (!hasText(candidate.purpose)) {
    issues.push(createQualityIssue(
      "missing_purpose",
      "purpose",
      "章节目标缺失。",
      "补充本章要推进的明确叙事目标，不能只复述章节摘要。",
    ));
  }

  const boundaryMissing = [
    ["exclusiveEvent", candidate.exclusiveEvent],
    ["endingState", candidate.endingState],
    ["nextChapterEntryState", candidate.nextChapterEntryState],
    ["mustAvoid", candidate.mustAvoid],
  ].filter(([, value]) => !hasText(value as string | null | undefined));
  if (
    boundaryMissing.length > 0
    || typeof candidate.conflictLevel !== "number"
    || typeof candidate.revealLevel !== "number"
    || typeof candidate.targetWordCount !== "number"
  ) {
    issues.push(createQualityIssue(
      "incomplete_boundary",
      "boundary",
      "章节边界合同不完整。",
      "补齐独占事件、结束态、下章入口态、冲突/揭露强度、目标字数和禁止事项。",
    ));
  }

  const taskSheetText = candidate.taskSheet?.trim() ?? "";
  if (!taskSheetText) {
    issues.push(createQualityIssue(
      "missing_task_sheet",
      "task_sheet",
      "章节任务单缺失。",
      "生成可交给正文写作器执行的任务单，覆盖冲突对象、推进要求、情绪基调和收尾要求。",
    ));
  } else {
    if (containsInternalQualityCodes(taskSheetText)) {
      issues.push(createQualityIssue(
        "task_sheet_internal_codes",
        "task_sheet",
        "任务单含内部质量/失败 code，不能交给作家指令。",
        "删掉 payoff_missing_progress、draft_obligation_unmet、replan_required 等内部标识，改写为自然语言推进要求。",
        "high",
      ));
    }
    const bulletHints = countTaskSheetBulletHints(taskSheetText);
    const payoffCount = Array.isArray(candidate.payoffRefs)
      ? candidate.payoffRefs.map((item) => String(item ?? "").trim()).filter(Boolean).length
      : 0;
    const hardHints = Math.max(payoffCount, Math.ceil(bulletHints / 2));
    if (hardHints > budget.maxHardObligationHints || bulletHints > budget.maxTaskSheetBulletHints) {
      issues.push(createQualityIssue(
        "task_sheet_type_overload",
        "task_sheet",
        `当前推断为「${budget.labelZh}」章，任务单义务偏多（建议硬义务≤${budget.maxHardObligationHints}、条目≤${budget.maxTaskSheetBulletHints}）。`,
        chapterType === "emotion"
          ? "情感章优先 1-2 个关系/情绪兑现点，把系统义务与战斗目标拆到邻章。"
          : "按章型收束必达项：保留本章独占事件与收尾钩子，其余 payoff/角色转折拆到邻章。",
        "medium",
      ));
    }
  }

  const scenePlan = parseChapterScenePlan(candidate.sceneCards, {
    targetWordCount: candidate.targetWordCount ?? undefined,
  });
  if (!scenePlan) {
    issues.push(createQualityIssue(
      "invalid_scene_cards",
      "scene_cards",
      "场景拆解无法作为正文执行依据。",
      "重建 3-8 个场景卡，并为每个场景补齐目标、入场状态、离场状态、必须推进和字数预算。",
    ));
  }

  if (issues.length === 0) {
    return {
      status: "passed",
      canEnterExecution: true,
      issues: [],
      summary: `章节执行合同结构完整（章型：${budget.labelZh}），可进入语义可用性评估。`,
      repairGuidance: [],
      confidence: 1,
    };
  }

  // 仅 medium 过载且无硬缺失时仍可进入语义评估，避免把分型建议当死门。
  const blocking = issues.filter((issue) => issue.severity === "high");
  if (blocking.length === 0) {
    return {
      status: "passed",
      canEnterExecution: true,
      issues,
      summary: `章节执行合同可进入语义评估（章型：${budget.labelZh}；存在分型负载提示）。`,
      repairGuidance: issues.map((issue) => issue.repairHint),
      confidence: 0.9,
    };
  }

  return {
    status: "repairable",
    canEnterExecution: false,
    issues,
    summary: "章节执行合同缺少进入正文生成链路所需的基础字段。",
    repairGuidance: issues.map((issue) => issue.repairHint),
    confidence: 1,
  };
}

export function mapSemanticAssessmentToQualityGate(
  assessment: AiChapterTaskSheetQualityAssessment,
  mode: ChapterTaskSheetQualityMode,
): ChapterTaskSheetQualityGateResult {
  const issues = assessment.recommendedHandling === "replan_window"
    && !assessment.issues.some((issue) => issue.id === "contract_overloaded")
    ? assessment.issues.concat({
      id: "contract_overloaded",
      severity: "high",
      target: "semantic",
      summary: "当前章节职责过载，继续执行会提高遗漏关键义务的概率。",
      repairHint: "先重排附近章节职责，再进入正文生成。",
    })
    : assessment.issues;
  if (assessment.verdict === "usable" && assessment.safeToSync) {
    return {
      status: "passed",
      canEnterExecution: true,
      issues,
      summary: assessment.summary,
      repairGuidance: assessment.repairGuidance,
      confidence: assessment.confidence,
    };
  }

  const status: ChapterTaskSheetQualityStatus = mode === "full_book_autopilot"
    ? "repairable"
    : assessment.verdict === "unusable"
      ? "blocked"
      : "needs_confirmation";

  return {
    status,
    canEnterExecution: false,
    issues,
    summary: assessment.summary,
    repairGuidance: assessment.repairGuidance,
    confidence: assessment.confidence,
  };
}

export function formatChapterTaskSheetQualityFailure(result: ChapterTaskSheetQualityGateResult): string {
  const issueText = result.issues
    .slice(0, 4)
    .map((issue) => `${issue.summary}${issue.repairHint ? ` 修复建议：${issue.repairHint}` : ""}`)
    .join(" ");
  const guidanceText = result.repairGuidance.length > 0
    ? ` 需要调整：${result.repairGuidance.slice(0, 4).join("；")}`
    : "";
  return `${result.summary}${issueText ? ` ${issueText}` : ""}${guidanceText}`;
}
