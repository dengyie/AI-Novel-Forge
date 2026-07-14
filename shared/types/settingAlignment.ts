import { z } from "zod";
import type { FunctionAcceptanceItem, FunctionAcceptanceTable } from "./functionAcceptance.js";
import { normalizeFunctionIds } from "./functionAcceptance.js";
import type { SettingQualityMode } from "./settingQualityPolicy.js";
import { isSettingQualityActive } from "./settingQualityPolicy.js";

/**
 * 设定对齐门禁（B3）。
 * - 规则段始终可测、廉价；不读 prose overallScore 当设定通过
 * - blocking 只经 qualityLoop 归并后生效；详情写 riskFlags.settingAlignment
 */

export const SETTING_ALIGNMENT_RULE_ENGINE_VERSION = "setting-alignment-rules-v1";

export const SETTING_ALIGNMENT_STATUSES = ["pass", "repairable", "blocking"] as const;
export type SettingAlignmentStatus = (typeof SETTING_ALIGNMENT_STATUSES)[number];

export const SETTING_ALIGNMENT_CHECK_KINDS = [
  "function",
  "entity",
  "forbid",
  "foreshadow",
  "location",
] as const;
export type SettingAlignmentCheckKind = (typeof SETTING_ALIGNMENT_CHECK_KINDS)[number];

export const SETTING_ALIGNMENT_SEVERITIES = ["low", "medium", "high"] as const;
export type SettingAlignmentSeverity = (typeof SETTING_ALIGNMENT_SEVERITIES)[number];

export const SETTING_ALIGNMENT_ACTIONS = [
  "continue",
  "patch_repair",
  "replan",
  "manual_gate",
] as const;
export type SettingAlignmentAction = (typeof SETTING_ALIGNMENT_ACTIONS)[number];

export const settingAlignmentCheckSchema = z.object({
  id: z.string().trim().min(1),
  kind: z.enum(SETTING_ALIGNMENT_CHECK_KINDS),
  passed: z.boolean(),
  severity: z.enum(SETTING_ALIGNMENT_SEVERITIES),
  summary: z.string().trim().min(1),
  evidence: z.string().optional(),
  /** hard 失败在 enforce 下抬升 qualityLoop blocking */
  hard: z.boolean().optional(),
});

export type SettingAlignmentCheck = z.infer<typeof settingAlignmentCheckSchema>;

export const settingAlignmentAssessmentSchema = z.object({
  chapterId: z.string().trim().min(1),
  chapterOrder: z.number().int().positive().nullable().optional(),
  status: z.enum(SETTING_ALIGNMENT_STATUSES),
  /** 独立于 prose；0–100 */
  score: z.number().min(0).max(100),
  checks: z.array(settingAlignmentCheckSchema).max(64),
  recommendedAction: z.enum(SETTING_ALIGNMENT_ACTIONS),
  ruleEngineVersion: z.string().trim().min(1),
  llmUsed: z.boolean(),
  /** LLM 超时/失败仅 observability，不默认 blocking */
  llmTimedOut: z.boolean().optional(),
  llmError: z.string().optional(),
  mode: z.enum(["off", "advisory", "enforce"]),
  evaluatedAt: z.string().optional(),
});

export type SettingAlignmentAssessment = z.infer<typeof settingAlignmentAssessmentSchema>;

export type SettingAlignmentRuleInput = {
  chapterId: string;
  chapterOrder?: number | null;
  content: string;
  mode: SettingQualityMode;
  functionIds?: string[] | null;
  functionItems?: FunctionAcceptanceItem[] | null;
  functionTable?: FunctionAcceptanceTable | null;
  mustAvoid?: string | null;
  exclusiveEvent?: string | null;
  requiredCharacterAppearances?: string[] | null;
  forbiddenCrossings?: string[] | null;
  hardForbiddenTerms?: string[] | null;
  evaluatedAt?: string | Date;
  /**
   * 可选 LLM 段结果。未提供 = 不跑 LLM。
   * 超时/失败应由调用方设 llmTimedOut/llmError，且不传 hard fails。
   */
  llmChecks?: SettingAlignmentCheck[] | null;
  llmUsed?: boolean;
  llmTimedOut?: boolean;
  llmError?: string | null;
};

const SEVERITY_RANK: Record<SettingAlignmentSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}

function normalizeEvaluatedAt(value: string | Date | undefined): string {
  if (!value) {
    return new Date().toISOString();
  }
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Soft 语义兑付：字面关键词 miss 时的同义/转述锚扩展（规则段，非 LLM）。
 * 失败仍 soft repairable，永不 hard-block；超时/无表时与未扩展等价。
 * 覆盖交接/托付/在场/落地等高频叙事动作；不声称完整 NER。
 */
const SEMANTIC_PARAPHRASE_GROUPS: readonly (readonly string[])[] = [
  ["托付", "交给", "交付", "交代", "嘱托", "委任", "转交", "移交"],
  ["当面", "当面对", "当面把", "面对面", "在场当面"],
  ["关键事务", "关键事", "要务", "重要事务", "核心事务"],
  ["承接人", "接手人", "接收人", "接手的人", "接手者", "接收方"],
  ["在场", "到场", "出席", "陪同在侧", "人在现场"],
  ["对话落地", "谈妥", "说定", "确认了后续", "敲定安排", "安排确认"],
  ["落地", "落实", "兑现", "谈妥", "办妥"],
];

function expandSemanticParaphraseAnchors(text: string, max = 10): string[] {
  const base = extractKeywords(text, max);
  const expanded: string[] = [...base];
  const compact = text.replace(/\s+/g, "");
  for (const group of SEMANTIC_PARAPHRASE_GROUPS) {
    const hitInSource = group.some((term) => (
      compact.includes(term)
      || base.some((b) => b.includes(term) || term.includes(b))
    ));
    if (!hitInSource) {
      continue;
    }
    for (const term of group) {
      if (term.length >= 2) {
        expanded.push(term);
      }
    }
  }
  if (compact.length >= 2 && compact.length <= 12) {
    expanded.push(compact);
  }
  return uniqueStrings(expanded).slice(0, max);
}

/**
 * 验收锚点提取：优先短专名/词，避免把整句 mustHappen 当 hard 子串。
 * - 空白分词 ≥2 字
 * - 中文：仅在原文已是短锚（≤8 字）时用全文；长句只取显式 2–4 字片段，不硬切前缀假锚
 */
function extractKeywords(text: string, max = 8): string[] {
  const cleaned = text
    .replace(/[「」『』【】\[\]（）()《》<>，。！？、；：,.!?;:\s]+/g, " ")
    .trim();
  if (!cleaned) {
    return [];
  }
  const parts = cleaned
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && part.length <= 12);
  const compact = cleaned.replace(/\s+/g, "");
  const cjkChunks: string[] = [];
  if (/[一-鿿]/.test(compact)) {
    // 短验收句（≤8）本身就是锚点；长句不切片前缀（避免「陆深当面托付关键事务」→「陆深当面」假通过）
    if (compact.length >= 2 && compact.length <= 8) {
      cjkChunks.push(compact);
    }
    // 若含顿号/逗号拆过，parts 已覆盖；否则对中等长度取首尾专名倾向短片
    if (compact.length > 8 && compact.length <= 16) {
      cjkChunks.push(compact.slice(0, 4));
      cjkChunks.push(compact.slice(-4));
    }
  }
  return uniqueStrings([...parts, ...cjkChunks]).slice(0, max);
}

/**
 * 否定判定（防「…托付对话落地的说法不成立」假通过）：
 * - 前缀：紧邻关键词前的 没有/并非/未/并无/绝非/并没有/并未
 * - 后缀：同句读内短窗含 不成立/谈不上/并未发生 等
 * 注意：下一分句的「没有外挂」不得否掉上一分句的「承接人在场」。
 */
const NEGATION_PREFIX_PATTERN = /(?:并非|并没有|没有|并无|绝非|并未|未)[\s「」『』“”'"]*$/;
const NEGATION_SUFFIX_PATTERN = /(?:不成立|不存在|谈不上|算不上|并不成立|并不存在|并未发生|绝非|并非)/;

function isNegatedKeywordHit(content: string, idx: number, termLength: number): boolean {
  const prefix = content.slice(Math.max(0, idx - 6), idx);
  if (NEGATION_PREFIX_PATTERN.test(prefix)) {
    return true;
  }
  // 后缀窗：到最近句读为止，最多 16 字（允许「的说法不成立」「也谈不上」）
  const after = content.slice(idx + termLength, idx + termLength + 16);
  const clauseEnd = after.search(/[，。！？；、,.!?;]/);
  const suffix = clauseEnd >= 0 ? after.slice(0, clauseEnd) : after;
  return NEGATION_SUFFIX_PATTERN.test(suffix);
}

function contentIncludesAny(content: string, needles: string[]): string | null {
  for (const needle of needles) {
    const term = needle.trim();
    if (term.length < 2) {
      continue;
    }
    let from = 0;
    while (from < content.length) {
      const idx = content.indexOf(term, from);
      if (idx < 0) {
        break;
      }
      if (!isNegatedKeywordHit(content, idx, term.length)) {
        return term;
      }
      from = idx + term.length;
    }
  }
  return null;
}

function contentIncludesAllGroups(content: string, groups: string[][]): {
  ok: boolean;
  missing: string[];
  hit: string[];
} {
  const missing: string[] = [];
  const hit: string[] = [];
  for (const group of groups) {
    const found = contentIncludesAny(content, group);
    if (found) {
      hit.push(found);
    } else {
      missing.push(group[0] ?? "");
    }
  }
  return {
    ok: missing.length === 0,
    missing: missing.filter(Boolean),
    hit,
  };
}

function parseMustAvoidTerms(mustAvoid: string | null | undefined): string[] {
  if (!mustAvoid?.trim()) {
    return [];
  }
  return uniqueStrings(mustAvoid.split(/[\n；;，,、|/]+/g)).filter((term) => term.length >= 2);
}

function resolveFunctionItems(input: SettingAlignmentRuleInput): FunctionAcceptanceItem[] {
  const ids = normalizeFunctionIds(input.functionIds);
  if (ids.length === 0) {
    return [];
  }
  const fromItems = input.functionItems ?? [];
  const fromTable = input.functionTable?.items ?? [];
  const pool = fromItems.length > 0 ? fromItems : fromTable;
  if (pool.length === 0) {
    return ids.map((id, index) => ({
      id,
      order: index + 1,
      title: id,
      mustHappen: "",
      acceptanceChecks: [],
      status: "assigned" as const,
    }));
  }
  const byId = new Map(pool.map((item) => [item.id, item]));
  return ids
    .map((id) => byId.get(id))
    .filter((item): item is FunctionAcceptanceItem => Boolean(item));
}

function buildFunctionChecks(
  content: string,
  items: FunctionAcceptanceItem[],
): SettingAlignmentCheck[] {
  const checks: SettingAlignmentCheck[] = [];
  for (const item of items) {
    const checkTexts = uniqueStrings([
      item.mustHappen,
      ...(item.acceptanceChecks ?? []),
    ]).filter(Boolean);
    if (checkTexts.length === 0) {
      checks.push({
        id: `function:${item.id}:empty`,
        kind: "function",
        passed: true,
        severity: "low",
        summary: `功能 ${item.id} 无 acceptanceChecks，规则段跳过`,
        hard: false,
      });
      continue;
    }

    const groups = checkTexts.map((text) => extractKeywords(text, 6));
    const usableGroups = groups.filter((group) => group.length > 0);
    if (usableGroups.length === 0) {
      checks.push({
        id: `function:${item.id}:unparseable`,
        kind: "function",
        passed: true,
        severity: "low",
        summary: `功能 ${item.id} 检查文本无法提取关键词，规则段跳过`,
        hard: false,
      });
      continue;
    }

    // 每个 check 至少命中一组关键词中的一个。
    // 1) 字面锚点 2) 失败则走 soft 语义兑付（同义/转述锚，仍 soft；失败=repairable 不 hard-block）
    // mustNotHappen / 硬禁词 / 必出角色 仍 hard。
    const coverage = contentIncludesAllGroups(content, usableGroups);
    let passed = coverage.ok;
    let evidenceHits = coverage.hit;
    let semanticRecovered = false;
    if (!passed) {
      const semanticGroups = checkTexts
        .map((text) => expandSemanticParaphraseAnchors(text, 8))
        .filter((group) => group.length > 0);
      if (semanticGroups.length > 0) {
        const semanticCoverage = contentIncludesAllGroups(content, semanticGroups);
        if (semanticCoverage.ok) {
          passed = true;
          semanticRecovered = true;
          evidenceHits = semanticCoverage.hit;
        }
      }
    }
    checks.push({
      id: `function:${item.id}`,
      kind: "function",
      passed,
      severity: passed ? "low" : "medium",
      summary: passed
        ? (semanticRecovered
          ? `功能「${item.title}」语义兑付命中（转述/同义）`
          : `功能「${item.title}」验收线索命中`)
        : `功能「${item.title}」验收线索未在正文出现：缺 ${coverage.missing.slice(0, 3).join("、")}`,
      evidence: evidenceHits.slice(0, 4).join("；") || undefined,
      hard: false,
    });

    for (const ban of item.mustNotHappen ?? []) {
      const term = ban.trim();
      if (term.length < 2) {
        continue;
      }
      const hit = content.includes(term);
      checks.push({
        id: `function:${item.id}:ban:${term.slice(0, 24)}`,
        kind: "forbid",
        passed: !hit,
        severity: hit ? "high" : "low",
        summary: hit
          ? `功能「${item.title}」禁项出现：${term}`
          : `功能「${item.title}」禁项未出现：${term}`,
        evidence: hit ? term : undefined,
        hard: hit,
      });
    }
  }
  return checks;
}

function buildForbidChecks(
  content: string,
  terms: string[],
  prefix: string,
): SettingAlignmentCheck[] {
  return terms.map((term) => {
    const hit = content.includes(term);
    return {
      id: `${prefix}:${term.slice(0, 32)}`,
      kind: "forbid" as const,
      passed: !hit,
      severity: hit ? "high" as const : "low" as const,
      summary: hit ? `硬禁/避写出现：${term}` : `硬禁/避写未出现：${term}`,
      evidence: hit ? term : undefined,
      hard: hit,
    };
  });
}

function buildCharacterChecks(
  content: string,
  names: string[],
): SettingAlignmentCheck[] {
  return names.map((name) => {
    const term = name.trim();
    if (term.length < 1) {
      return null;
    }
    const hit = content.includes(term);
    return {
      id: `entity:character:${term.slice(0, 32)}`,
      kind: "entity" as const,
      passed: hit,
      severity: hit ? "low" as const : "high" as const,
      summary: hit ? `必出角色在场：${term}` : `必出角色未在正文出现：${term}`,
      evidence: hit ? term : undefined,
      hard: !hit,
    };
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function buildExclusiveEventCheck(
  content: string,
  exclusiveEvent: string | null | undefined,
): SettingAlignmentCheck | null {
  const text = exclusiveEvent?.trim();
  if (!text) {
    return null;
  }
  const keywords = extractKeywords(text, 6);
  if (keywords.length === 0) {
    return {
      id: "function:exclusive_event:unparseable",
      kind: "function",
      passed: true,
      severity: "low",
      summary: "独占事件文本无法提取关键词，规则段跳过",
      hard: false,
    };
  }
  const hit = contentIncludesAny(content, keywords);
  return {
    id: "function:exclusive_event",
    kind: "function",
    passed: Boolean(hit),
    severity: hit ? "low" : "medium",
    summary: hit
      ? `独占事件线索命中：${hit}`
      : `独占事件线索未命中：${text.slice(0, 48)}`,
    evidence: hit ?? undefined,
    // exclusiveEvent 模糊，默认 repairable 而非 hard blocking
    hard: false,
  };
}

function emptyPassAssessment(input: SettingAlignmentRuleInput): SettingAlignmentAssessment {
  return {
    chapterId: input.chapterId,
    chapterOrder: input.chapterOrder ?? null,
    status: "pass",
    score: 100,
    checks: [],
    recommendedAction: "continue",
    ruleEngineVersion: SETTING_ALIGNMENT_RULE_ENGINE_VERSION,
    llmUsed: false,
    mode: input.mode,
    evaluatedAt: normalizeEvaluatedAt(input.evaluatedAt),
  };
}

/**
 * enforce 下上下文不可用（workspace 加载失败 / 规则段崩溃）时的 fail-closed 评估。
 * - off：仍 pass（不注入）
 * - advisory：soft risk，不挡
 * - enforce：hard blocking + manual_gate，禁止当「无债」放行
 */
export function buildUnavailableSettingAlignmentAssessment(input: {
  chapterId: string;
  chapterOrder?: number | null;
  mode: SettingQualityMode;
  reason: string;
  evaluatedAt?: string | Date;
}): SettingAlignmentAssessment {
  const mode = input.mode ?? "off";
  if (mode === "off") {
    return emptyPassAssessment({
      chapterId: input.chapterId,
      chapterOrder: input.chapterOrder,
      content: "",
      mode: "off",
      evaluatedAt: input.evaluatedAt,
    });
  }
  const reason = input.reason.trim() || "设定对齐上下文不可用";
  const hard = mode === "enforce";
  return {
    chapterId: input.chapterId,
    chapterOrder: input.chapterOrder ?? null,
    status: hard ? "blocking" : "repairable",
    score: hard ? 0 : 70,
    checks: [{
      id: "setting:unavailable",
      kind: "function",
      passed: false,
      severity: hard ? "high" : "medium",
      summary: reason,
      hard,
    }],
    recommendedAction: hard ? "manual_gate" : "continue",
    ruleEngineVersion: SETTING_ALIGNMENT_RULE_ENGINE_VERSION,
    llmUsed: false,
    mode,
    evaluatedAt: normalizeEvaluatedAt(input.evaluatedAt),
  };
}

/**
 * riskFlags 是否表明该章设定对齐已 pass（供多章功能 satisfied 累积）。
 * 只认 qualityLoop.setting_alignment=valid 或详情 settingAlignment.status=pass。
 */
export function chapterRiskFlagsIndicateSettingAlignmentPass(
  riskFlags: string | null | undefined,
): boolean {
  if (!riskFlags?.trim()) {
    return false;
  }
  try {
    const parsed = JSON.parse(riskFlags) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const root = parsed as Record<string, unknown>;
    const detail = root.settingAlignment;
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      if ((detail as { status?: unknown }).status === "pass") {
        return true;
      }
    }
    const qualityLoop = root.qualityLoop;
    if (!qualityLoop || typeof qualityLoop !== "object" || Array.isArray(qualityLoop)) {
      return false;
    }
    const signals = Array.isArray((qualityLoop as { signals?: unknown }).signals)
      ? (qualityLoop as { signals: unknown[] }).signals
      : [];
    const settingSignals = signals.filter((signal) => {
      return Boolean(
        signal
        && typeof signal === "object"
        && !Array.isArray(signal)
        && (signal as { artifactType?: unknown }).artifactType === "setting_alignment",
      );
    }) as Array<Record<string, unknown>>;
    if (settingSignals.length === 0) {
      // 无 setting signal：可能是 mode=off 历史章，不计入 enforce 累积 pass
      return false;
    }
    return settingSignals.every((signal) => signal.status === "valid");
  } catch {
    return false;
  }
}

function computeScore(checks: SettingAlignmentCheck[]): number {
  if (checks.length === 0) {
    return 100;
  }
  const hardFails = checks.filter((check) => !check.passed && check.hard).length;
  const softFails = checks.filter((check) => !check.passed && !check.hard).length;
  const raw = 100 - hardFails * 25 - softFails * 10;
  return Math.max(0, Math.min(100, raw));
}

function resolveStatusAndAction(input: {
  mode: SettingQualityMode;
  checks: SettingAlignmentCheck[];
  llmTimedOut?: boolean;
}): {
  status: SettingAlignmentStatus;
  recommendedAction: SettingAlignmentAction;
} {
  if (input.mode === "off") {
    return { status: "pass", recommendedAction: "continue" };
  }

  const hardFails = input.checks.filter((check) => !check.passed && check.hard);
  const softFails = input.checks.filter((check) => !check.passed && !check.hard);
  const highHard = hardFails.some((check) => check.severity === "high");

  if (input.mode === "advisory") {
    if (hardFails.length > 0 || softFails.length > 0) {
      return { status: "repairable", recommendedAction: "continue" };
    }
    return { status: "pass", recommendedAction: "continue" };
  }

  // enforce
  if (hardFails.length > 0) {
    return {
      status: "blocking",
      recommendedAction: highHard ? "manual_gate" : "patch_repair",
    };
  }
  if (softFails.length > 0) {
    return { status: "repairable", recommendedAction: "patch_repair" };
  }
  // LLM 超时永不单独 blocking
  if (input.llmTimedOut) {
    return { status: "pass", recommendedAction: "continue" };
  }
  return { status: "pass", recommendedAction: "continue" };
}

/**
 * 纯规则引擎：mode=off 直接 pass；不读 prose 分数。
 */
export function evaluateSettingAlignmentRules(
  input: SettingAlignmentRuleInput,
): SettingAlignmentAssessment {
  if (!isSettingQualityActive({ mode: input.mode, canonicalSliceLock: false })) {
    return emptyPassAssessment(input);
  }

  const content = input.content ?? "";
  const checks: SettingAlignmentCheck[] = [];

  const functionItems = resolveFunctionItems(input);
  checks.push(...buildFunctionChecks(content, functionItems));

  const exclusive = buildExclusiveEventCheck(content, input.exclusiveEvent);
  if (exclusive) {
    checks.push(exclusive);
  }

  const mustAvoidTerms = parseMustAvoidTerms(input.mustAvoid);
  checks.push(...buildForbidChecks(content, mustAvoidTerms, "forbid:must_avoid"));

  const hardForbidden = uniqueStrings(input.hardForbiddenTerms ?? []);
  checks.push(...buildForbidChecks(content, hardForbidden, "forbid:hard"));

  const forbiddenCrossings = uniqueStrings(input.forbiddenCrossings ?? []);
  checks.push(...buildForbidChecks(content, forbiddenCrossings, "forbid:crossing"));

  const requiredCharacters = uniqueStrings(input.requiredCharacterAppearances ?? []);
  checks.push(...buildCharacterChecks(content, requiredCharacters));

  const llmChecks = (input.llmChecks ?? []).filter((check) => {
    // LLM 段不得以 hard 抬 enforce blocking（超时/模糊项）
    return Boolean(check && typeof check === "object");
  }).map((check) => ({
    ...check,
    hard: false,
  }));
  checks.push(...llmChecks);

  const { status, recommendedAction } = resolveStatusAndAction({
    mode: input.mode,
    checks,
    llmTimedOut: input.llmTimedOut,
  });

  return {
    chapterId: input.chapterId,
    chapterOrder: input.chapterOrder ?? null,
    status,
    score: computeScore(checks),
    checks: checks.slice(0, 64),
    recommendedAction,
    ruleEngineVersion: SETTING_ALIGNMENT_RULE_ENGINE_VERSION,
    llmUsed: Boolean(input.llmUsed) || llmChecks.length > 0,
    ...(input.llmTimedOut ? { llmTimedOut: true } : {}),
    ...(input.llmError ? { llmError: input.llmError } : {}),
    mode: input.mode,
    evaluatedAt: normalizeEvaluatedAt(input.evaluatedAt),
  };
}

/**
 * 将 setting alignment 映射为 qualityLoop signal 语义。
 * advisory 失败 → risk 但调用方应把 recommendedAction 保持 continue（non-blocking）
 * enforce hard → invalid
 */
export function settingAlignmentToQualityLoopSignal(assessment: SettingAlignmentAssessment): {
  artifactType: "setting_alignment";
  status: "valid" | "risk" | "invalid" | "missing";
  reason: string;
  issueCodes: string[];
  recommendedAction: SettingAlignmentAction;
  blockingForQualityLoop: boolean;
} {
  if (assessment.mode === "off") {
    return {
      artifactType: "setting_alignment",
      status: "valid",
      reason: "settingQualityMode=off，跳过设定对齐。",
      issueCodes: [],
      recommendedAction: "continue",
      blockingForQualityLoop: false,
    };
  }

  const failed = assessment.checks.filter((check) => !check.passed);
  const hardFailed = failed.filter((check) => check.hard);
  const issueCodes = failed
    .map((check) => check.id)
    .slice(0, 8);

  if (assessment.mode === "advisory") {
    if (failed.length === 0) {
      return {
        artifactType: "setting_alignment",
        status: "valid",
        reason: "设定对齐规则段通过（advisory）。",
        issueCodes: [],
        recommendedAction: "continue",
        blockingForQualityLoop: false,
      };
    }
    return {
      artifactType: "setting_alignment",
      status: "risk",
      reason: `设定对齐存在提示（advisory，不阻断）：${failed[0]?.summary ?? "见 checks"}`,
      issueCodes,
      recommendedAction: "continue",
      blockingForQualityLoop: false,
    };
  }

  // enforce
  if (assessment.status === "blocking" || hardFailed.length > 0) {
    return {
      artifactType: "setting_alignment",
      status: "invalid",
      reason: assessment.checks.find((c) => !c.passed && c.hard)?.summary
        ?? "设定对齐硬失败，禁止视为已处理。",
      issueCodes,
      recommendedAction: assessment.recommendedAction === "continue"
        ? "manual_gate"
        : assessment.recommendedAction,
      blockingForQualityLoop: true,
    };
  }

  if (assessment.status === "repairable" || failed.length > 0) {
    return {
      artifactType: "setting_alignment",
      status: "risk",
      reason: failed[0]?.summary ?? "设定对齐存在可修复缺口。",
      issueCodes,
      recommendedAction: assessment.recommendedAction === "continue"
        ? "patch_repair"
        : assessment.recommendedAction,
      blockingForQualityLoop: true,
    };
  }

  return {
    artifactType: "setting_alignment",
    status: "valid",
    reason: "设定对齐规则段通过（enforce）。",
    issueCodes: [],
    recommendedAction: "continue",
    blockingForQualityLoop: false,
  };
}

export function qualityLoopHasSettingBlockingSignal(qualityLoop: unknown): boolean {
  if (!qualityLoop || typeof qualityLoop !== "object" || Array.isArray(qualityLoop)) {
    return false;
  }
  const signals = Array.isArray((qualityLoop as { signals?: unknown }).signals)
    ? (qualityLoop as { signals: unknown[] }).signals
    : [];
  return signals.some((signal) => {
    if (!signal || typeof signal !== "object" || Array.isArray(signal)) {
      return false;
    }
    const record = signal as Record<string, unknown>;
    return record.artifactType === "setting_alignment"
      && (record.status === "invalid" || record.status === "risk");
  });
}

/**
 * 是否「qualityLoop blocking 且含 setting_alignment signal」。
 * 注意：blocking 真源仍是 qualityLoop；本函数禁止只读 settingAlignment 详情。
 * 与 chapterQualityLoop.classify 对齐：manual_gate / setting invalid 优先于 defer。
 */
export function hasBlockingSettingAlignmentDebt(riskFlags: string | null | undefined): boolean {
  if (!riskFlags?.trim()) {
    return false;
  }
  try {
    const parsed = JSON.parse(riskFlags) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const qualityLoop = (parsed as Record<string, unknown>).qualityLoop;
    return classifyQualityLoopBlockingLite(qualityLoop) === "blocking"
      && qualityLoopHasSettingBlockingSignal(qualityLoop);
  } catch {
    return false;
  }
}

function classifyQualityLoopBlockingLite(
  qualityLoop: unknown,
): "none" | "blocking" | "non_blocking_quality_debt" {
  if (!qualityLoop || typeof qualityLoop !== "object" || Array.isArray(qualityLoop)) {
    return "none";
  }
  const loop = qualityLoop as Record<string, unknown>;
  if (loop.rootCauseCode === "replan_required" || loop.recommendedAction === "replan") {
    return "blocking";
  }
  const signals = Array.isArray(loop.signals) ? loop.signals : [];
  const settingSignals = signals.filter((signal) => {
    return Boolean(
      signal
      && typeof signal === "object"
      && !Array.isArray(signal)
      && (signal as Record<string, unknown>).artifactType === "setting_alignment",
    );
  }) as Array<Record<string, unknown>>;
  const hasSettingInvalid = settingSignals.some((signal) => signal.status === "invalid");
  const hasSettingRisk = settingSignals.some((signal) => signal.status === "risk");
  const settingAdvisoryOnly = hasSettingRisk && settingSignals.every((signal) => {
    if (signal.status === "valid") {
      return true;
    }
    if (signal.status !== "risk") {
      return false;
    }
    const reason = typeof signal.reason === "string" ? signal.reason : "";
    return reason.includes("advisory") || reason.includes("不阻断");
  }) && signals.every((signal) => {
    if (!signal || typeof signal !== "object" || Array.isArray(signal)) {
      return true;
    }
    const record = signal as Record<string, unknown>;
    if (record.artifactType === "setting_alignment") {
      return record.status === "risk" || record.status === "valid";
    }
    return record.status === "valid";
  });
  // 与主分类器一致：设定硬失败 / manual_gate 不被 defer 降级
  if (loop.recommendedAction === "manual_gate" || hasSettingInvalid) {
    return "blocking";
  }
  if (loop.terminalAction === "defer_and_continue") {
    // enforce 设定 risk（非 advisory-only）同样不可 defer 放行
    if (hasSettingRisk && !settingAdvisoryOnly) {
      return "blocking";
    }
    return "non_blocking_quality_debt";
  }
  if (loop.overallStatus === "valid" && loop.recommendedAction === "continue") {
    return "none";
  }
  if (Array.isArray(loop.blockingObligations) && loop.blockingObligations.length > 0) {
    return "blocking";
  }
  if (
    loop.overallStatus === "risk"
    && loop.recommendedAction === "continue"
  ) {
    // deferred timeline / advisory setting-only 等 continue 路径 → 非阻塞
    return "non_blocking_quality_debt";
  }
  if (loop.overallStatus === "risk" || loop.overallStatus === "invalid") {
    return "blocking";
  }
  return "none";
}

export function normalizeSettingAlignmentAssessment(
  raw: unknown,
): SettingAlignmentAssessment | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const parsed = settingAlignmentAssessmentSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
