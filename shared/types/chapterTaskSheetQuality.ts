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
  /**
   * 功能验收挂载（B4）。仅用于模板提示与兑付短列表校验，不是字数闸。
   * mode=off 时可缺省。
   */
  functionIds?: string[] | null;
  /** 已解析的功能兑付短列表文案（可直接对照 taskSheet 是否覆盖） */
  functionPayoffHints?: string[] | null;
}

export interface AssessChapterExecutionContractShapeOptions {
  /**
   * taskSheet 质量模式：full_book_autopilot 下 cognitive_nailing 可升为 high 阻断。
   * 缺省按 advisory（medium，不单独阻断 canEnterExecution）。
   */
  qualityMode?: ChapterTaskSheetQualityMode;
  /**
   * 设定对齐模式：enforce 时模板硬缺口（缺选择/现场）与钉认知可升 high。
   * 缺省 off — 规则仍产出 issue，但不因模板语义单独 hard-block。
   */
  settingQualityMode?: "off" | "advisory" | "enforce";
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
  // Reset the shared global regex's lastIndex: a prior contains()/test() call may
  // have advanced it past the first match. V8's String.replace on a global regex
  // resumes exec from lastIndex when it is non-zero, which would skip every code
  // located before that index — leaving parroted internal codes in the taskSheet
  // and re-tripping the task_sheet_internal_codes quality gate (structured-outline
  // phase deadlock). Resetting here makes strip independent of call ordering.
  INTERNAL_QUALITY_CODE_PATTERN.lastIndex = 0;
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

/**
 * B4 模板语义规则（正则/结构优先，先于 LLM）。
 * 与 self-cycle strip 兼容：调用方应先 sanitize codes，再对本函数评估清洗后正文。
 *
 * 钉认知 / 缺选择 / 缺现场：默认 advisory（medium）。
 * 仅 qualityMode=full_book_autopilot 或 settingQualityMode=enforce 时，
 * cognitive_nailing 升 high 可阻断 canEnterExecution。
 */
const COGNITIVE_NAILING_PATTERNS: RegExp[] = [
  /读者应(?:该)?理解/,
  /读者(?:会|要|必须)?(?:明白|理解|知道|认识到)/,
  /让读者(?:明白|理解|知道|认识到|看清)/,
  /本章(?:主题|要表达|想说明|想传达|要传达)/,
  /主题是[：:]/,
  /传达主题/,
  /钉死认知/,
  /认知钉/,
  /主题句[：:]/,
  /读者(?:应当|必须)(?:得出|得到)结论/,
];

const CHOICE_PRESSURE_PATTERNS: RegExp[] = [
  /【人物选择】/,
  /人物选择[：:]/,
  /有代价的?选择/,
  /两难/,
  /取舍/,
  /(?:被迫|不得不|必须)(?:在|于)?.{0,12}(?:之间|之中)?选/,
  /选择.{0,16}代价/,
  /代价.{0,16}选择/,
  /押上/,
  /牺牲.{0,12}换/,
  /(?:决定|抉择|拍板).{0,20}(?:代价|后果|风险|失去|放弃)/,
  /放弃.{0,12}(?:换|保住|争取)/,
];

const SCENE_ANCHOR_PATTERNS: RegExp[] = [
  /【现场压力】/,
  /【本章独占事件】/,
  /现场压力[：:]/,
  /独占事件[：:]/,
  /环境锚/,
  /场景锚/,
  /整体环境/,
  /现场(?:压迫|压力|锚点)?/,
  /(?:社会|身体|环境)压力/,
  /(?:桥面|港口|巷口|走廊|雨夜|机舱|甲板|码头|仓库|会议室|审讯室|废楼)/,
  /(?:冷风|潮气|灯光|警报|汽笛|腥味|血味|铁锈|硝烟|湿冷)/,
];

export type TaskSheetTemplateRuleAssessment = {
  hasCognitiveNailing: boolean;
  hasChoicePressure: boolean;
  hasSceneAnchor: boolean;
  issues: ChapterTaskSheetQualityIssue[];
};

function shouldElevateTemplateRulesToBlocking(
  options?: AssessChapterExecutionContractShapeOptions,
): boolean {
  if (options?.qualityMode === "full_book_autopilot") {
    return true;
  }
  if (options?.settingQualityMode === "enforce") {
    return true;
  }
  return false;
}

/**
 * 纯规则评估 taskSheet 模板语义。输入应为 strip 后的自然语言。
 */
export function assessTaskSheetTemplateRules(
  taskSheet: string | null | undefined,
  options?: AssessChapterExecutionContractShapeOptions,
): TaskSheetTemplateRuleAssessment {
  const text = taskSheet?.trim() ?? "";
  if (!text) {
    return {
      hasCognitiveNailing: false,
      hasChoicePressure: false,
      hasSceneAnchor: false,
      issues: [],
    };
  }

  const hasCognitiveNailing = COGNITIVE_NAILING_PATTERNS.some((pattern) => pattern.test(text));
  const hasChoicePressure = CHOICE_PRESSURE_PATTERNS.some((pattern) => pattern.test(text));
  const hasSceneAnchor = SCENE_ANCHOR_PATTERNS.some((pattern) => pattern.test(text));
  const elevate = shouldElevateTemplateRulesToBlocking(options);
  const issues: ChapterTaskSheetQualityIssue[] = [];

  if (hasCognitiveNailing) {
    issues.push(createQualityIssue(
      "cognitive_nailing",
      "task_sheet",
      "任务单含「钉死认知」句（读者应理解/主题是…），应改写为人物选择与现场压力。",
      "删掉主题说明与读者认知句；改写为有代价的选择 + 可拍摄的现场压力，不写觉悟总结。",
      elevate ? "high" : "medium",
    ));
  }

  if (!hasChoicePressure) {
    issues.push(createQualityIssue(
      "missing_choice_pressure",
      "task_sheet",
      "任务单缺少人物选择/代价压力。",
      "补充【人物选择】：写具体取舍与代价，不写觉悟句。",
      elevate ? "high" : "medium",
    ));
  }

  if (!hasSceneAnchor) {
    issues.push(createQualityIssue(
      "missing_scene_anchor",
      "task_sheet",
      "任务单缺少现场压力/场景锚。",
      "补充【现场压力】或【本章独占事件】：一处可拍的环境/社会/身体压力锚。",
      elevate ? "high" : "medium",
    ));
  }

  return {
    hasCognitiveNailing,
    hasChoicePressure,
    hasSceneAnchor,
    issues,
  };
}

/**
 * 功能兑付短列表（B4 合同提示，非字数闸）。
 * 优先用已解析 hints；否则用 functionIds 生成占位行。
 */
export function buildFunctionPayoffShortList(input: {
  functionIds?: string[] | null;
  functionPayoffHints?: string[] | null;
  maxItems?: number;
}): string[] {
  const maxItems = Math.max(1, Math.min(input.maxItems ?? 6, 12));
  const hints = (input.functionPayoffHints ?? [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
  if (hints.length > 0) {
    return Array.from(new Set(hints)).slice(0, maxItems);
  }
  const ids = (input.functionIds ?? [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
  return Array.from(new Set(ids))
    .slice(0, maxItems)
    .map((id) => `功能兑付 ${id}`);
}

export function formatFunctionPayoffShortListForTaskSheet(input: {
  functionIds?: string[] | null;
  functionPayoffHints?: string[] | null;
  maxItems?: number;
}): string {
  const lines = buildFunctionPayoffShortList(input);
  if (lines.length === 0) {
    return "";
  }
  return ["【功能兑付】", ...lines.map((line) => `- ${line}`)].join("\n");
}

export function assessChapterExecutionContractShape(
  candidate: ChapterExecutionContractQualityCandidate,
  options?: AssessChapterExecutionContractShapeOptions,
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

  // strip-first：模板语义对清洗后正文评估，避免内部 code 干扰规则，也保证与 self-cycle 共存
  const rawTaskSheet = candidate.taskSheet?.trim() ?? "";
  const taskSheetText = sanitizeWriterFacingTaskSheet(rawTaskSheet);
  if (!rawTaskSheet) {
    issues.push(createQualityIssue(
      "missing_task_sheet",
      "task_sheet",
      "章节任务单缺失。",
      "生成可交给正文写作器执行的任务单：独占事件、在场人物、人物选择、现场压力、功能兑付短列表与禁止项。",
    ));
  } else {
    if (containsInternalQualityCodes(rawTaskSheet)) {
      issues.push(createQualityIssue(
        "task_sheet_internal_codes",
        "task_sheet",
        "任务单含内部质量/失败 code，不能交给作家指令。",
        "删掉 payoff_missing_progress、draft_obligation_unmet、replan_required 等内部标识，改写为自然语言推进要求。",
        "high",
      ));
    }
    // 仅在 strip 后仍有正文时跑模板语义；空残留由 missing/internal 覆盖
    if (taskSheetText) {
      const templateRules = assessTaskSheetTemplateRules(taskSheetText, options);
      issues.push(...templateRules.issues);
    }
    const bulletHints = countTaskSheetBulletHints(taskSheetText || rawTaskSheet);
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
