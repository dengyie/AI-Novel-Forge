import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type {
  AntiAiSeverity,
  StyleDetectionReport,
  StyleDetectionViolation,
} from "@ai-novel/shared/types/styleEngine";
import { runStructuredPrompt } from "../../prompting/core/promptRunner";
import { styleDetectionPrompt } from "../../prompting/prompts/style/style.prompts";
import {
  detectProseQuality,
  type ProseQualityFinding,
  type ProseQualityIssueCode,
} from "../novel/runtime/proseQuality/ProseQualityDetector";
import {
  buildFullStyleContractText,
  buildStyleContractMetaText,
  inferStyleIssueCategory,
  inferStyleViolationSource,
} from "./styleContractText";
import { StyleRuntimeResolver } from "./StyleRuntimeResolver";
import {
  buildAntiAiRuleCatalogText,
  buildAntiAiRuleDirectiveText,
  listPreviewAntiAiRules,
  mergeAntiAiRules,
} from "./antiAiPreviewRules";

interface DetectionInput {
  content: string;
  styleProfileId?: string;
  novelId?: string;
  chapterId?: string;
  taskStyleProfileId?: string;
  previewAntiAiRuleIds?: string[];
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
}

// 命中 ≥3 个不同规则即判定 AI 痕迹成簇（humanizer：clusters not isolated tells）。
const CLUSTERING_THRESHOLD = 3;
// 成簇时 LLM 若给出偏低 riskScore，用此下限兜底，确保成簇文本不被漏放。
const CLUSTERED_RISK_FLOOR = 45;
// PostGenerationStyleReview 首轮 rewrite 阈值 35；确定性 pronoun L0 必须能越过该门槛。
const PRONOUN_REWRITE_RISK_FLOOR_STACK = 55;
const PRONOUN_REWRITE_RISK_FLOOR_DENSITY = 45;
const PRONOUN_REWRITE_RISK_FLOOR_MIN = 40;

/** 映射进 style violations 的硬 pronoun L0（不含 soft density）。 */
export const HARD_PRONOUN_PROSE_CODES = [
  "prose_pronoun_subject_stack",
  "prose_pronoun_density",
] as const satisfies readonly ProseQualityIssueCode[];

const PRONOUN_L0_RULE_META: Record<
  (typeof HARD_PRONOUN_PROSE_CODES)[number],
  {
    ruleId: string;
    ruleName: string;
    ruleType: "forbidden";
  }
> = {
  prose_pronoun_subject_stack: {
    ruleId: "l0:prose_pronoun_subject_stack",
    ruleName: "禁止句首第三人称代词堆叠",
    ruleType: "forbidden",
  },
  prose_pronoun_density: {
    ruleId: "l0:prose_pronoun_density",
    ruleName: "句首第三人称代词密度过高",
    ruleType: "forbidden",
  },
};

function mapProseSeverityToAntiAi(severity: ProseQualityFinding["severity"]): AntiAiSeverity {
  if (severity === "low" || severity === "medium" || severity === "high") {
    return severity;
  }
  // prose critical → style high（AntiAiSeverity 无 critical）
  return "high";
}

/**
 * 将 L0 hard pronoun findings 映射为可改写 style violations。
 * soft density 不映射（不进 rewrite gate，仅 L0/qualityLoop 可观测）。
 */
export function mapPronounFindingsToStyleViolations(
  findings: ProseQualityFinding[],
): StyleDetectionViolation[] {
  const hard = findings.filter((finding) =>
    (HARD_PRONOUN_PROSE_CODES as readonly string[]).includes(finding.code),
  );
  // 同 code 多条 finding 合并为一条 violation（取最高 severity + 首条 excerpt）。
  const byCode = new Map<string, ProseQualityFinding>();
  for (const finding of hard) {
    const existing = byCode.get(finding.code);
    if (!existing) {
      byCode.set(finding.code, finding);
      continue;
    }
    const rank = (s: string) => (s === "critical" ? 3 : s === "high" ? 2 : s === "medium" ? 1 : 0);
    if (rank(finding.severity) > rank(existing.severity)) {
      byCode.set(finding.code, finding);
    }
  }
  return Array.from(byCode.values()).map((finding) => {
    const meta = PRONOUN_L0_RULE_META[finding.code as (typeof HARD_PRONOUN_PROSE_CODES)[number]];
    return {
      ruleId: meta.ruleId,
      ruleName: meta.ruleName,
      ruleType: meta.ruleType,
      severity: mapProseSeverityToAntiAi(finding.severity),
      source: "global_anti_ai" as const,
      issueCategory: "style_expression" as const,
      excerpt: finding.excerpt,
      reason: finding.message,
      suggestion: finding.fixSuggestion,
      canAutoRewrite: true,
    };
  });
}

/** 有 hard pronoun violations 时抬 risk，保证 ≥35 可进 PostGenerationStyleReview 首轮。 */
export function computePronounRiskFloor(violations: StyleDetectionViolation[]): number {
  if (violations.length === 0) {
    return 0;
  }
  let floor = PRONOUN_REWRITE_RISK_FLOOR_MIN;
  for (const violation of violations) {
    if (violation.ruleId === "l0:prose_pronoun_subject_stack") {
      floor = Math.max(floor, PRONOUN_REWRITE_RISK_FLOOR_STACK);
    }
    if (violation.ruleId === "l0:prose_pronoun_density") {
      floor = Math.max(floor, PRONOUN_REWRITE_RISK_FLOOR_DENSITY);
    }
  }
  return Math.max(0, Math.min(100, floor));
}

/** 非 pronoun 的 high/critical prose 痕迹抬 residual floor（开篇 dual-gate 用）。 */
const PROSE_RESIDUAL_FLOOR_CRITICAL = 50;
const PROSE_RESIDUAL_FLOOR_HIGH = 40;
const HARD_PRONOUN_CODE_SET = new Set<string>(HARD_PRONOUN_PROSE_CODES);

/**
 * 从 prose findings 投影「非 pronoun」确定性 residual floor。
 * 不含 pronoun（stack/density/soft）——那些走 computePronounRiskFloor。
 * high → 40；critical → 50；无高危 → 0。
 */
export function computeDeterministicProseResidualRiskFloor(
  findings: ReadonlyArray<{ code: string; severity: string }>,
): number {
  let floor = 0;
  for (const finding of findings) {
    if (
      HARD_PRONOUN_CODE_SET.has(finding.code)
      || finding.code === "prose_pronoun_density_soft"
    ) {
      continue;
    }
    if (finding.severity === "critical") {
      floor = Math.max(floor, PROSE_RESIDUAL_FLOOR_CRITICAL);
    } else if (finding.severity === "high") {
      floor = Math.max(floor, PROSE_RESIDUAL_FLOOR_HIGH);
    }
  }
  return Math.max(0, Math.min(100, floor));
}

/**
 * repair / manual-review 路径的确定性 residual：
 * max(pronounFloor, non-pronoun high/critical prose floor)。
 * 不调 LLM；开篇 residual≥35 可挡 completed；中盘仅 residual 仍 styleClear true。
 */
export function computeDeterministicResidualRiskScore(content: string): number {
  const report = detectProseQuality(content);
  const pronounFloor = computePronounRiskFloor(
    mapPronounFindingsToStyleViolations(report.findings),
  );
  const proseFloor = computeDeterministicProseResidualRiskFloor(report.findings);
  return Math.max(pronounFloor, proseFloor);
}

/**
 * 把确定性 pronoun violations 合并进 detection report。
 * 覆盖 empty-contract / shouldSkipLlm 短路：无 LLM 时仍可产出 rewritable violations + 抬 risk。
 */
export function mergePronounIntoDetectionReport(
  base: StyleDetectionReport,
  pronounViolations: StyleDetectionViolation[],
): StyleDetectionReport {
  if (pronounViolations.length === 0) {
    return base;
  }
  const existingIds = new Set(base.violations.map((item) => item.ruleId));
  const extra = pronounViolations.filter((item) => !existingIds.has(item.ruleId));
  // 已有同 ruleId（LLM 也报了）时仍抬 risk，但不再重复 violation。
  const violations = extra.length > 0 ? [...base.violations, ...extra] : base.violations;
  const riskScore = Math.max(base.riskScore, computePronounRiskFloor(pronounViolations));
  const canAutoRewrite =
    base.canAutoRewrite
    || violations.some((item) => item.canAutoRewrite && item.suggestion.trim());
  const appliedRuleIds = Array.from(new Set([
    ...base.appliedRuleIds,
    ...pronounViolations.map((item) => item.ruleId),
  ]));
  let summary = base.summary?.trim() ?? "";
  if (extra.length > 0) {
    const pronounNote = "检出句首第三人称代词堆叠或密度过高，需改写。";
    summary = summary ? `${summary}；另${pronounNote}` : pronounNote;
  }
  return {
    riskScore,
    summary,
    violations,
    canAutoRewrite,
    appliedRuleIds,
  };
}

/** 对正文跑 L0 detect 并只取 hard pronoun → style violations。 */
export function collectPronounStyleViolations(content: string): StyleDetectionViolation[] {
  const prose = detectProseQuality(content);
  return mapPronounFindingsToStyleViolations(prose.findings);
}

interface ClusteringScanRule {
  id: string;
  type: string;
  enabled: boolean;
  detectPatterns: string[];
}

export interface ClusteringScanResult {
  // forbidden 规则里含字面量（非正则）的模式总数。
  forbiddenLiteralPatternCount: number;
  // 是否命中任意 forbidden 字面量模式。
  hasForbiddenLiteralHit: boolean;
  // 命中字面量的不同规则数（含 forbidden 与 risk）。
  clusteredHitCount: number;
  // 命中规则数是否达到聚类阈值。
  isClustered: boolean;
  // 是否应短路跳过 LLM：forbidden 有字面量但 0 命中且未成簇。
  shouldSkipLlm: boolean;
}

function isLiteralPattern(pattern: string): boolean {
  return !/[\\^$.*+?()[\]{}|]/.test(pattern);
}

// 字面量快扫的聚类判定纯函数（humanizer 聚类思想）：单点从宽、成簇从严。
// 抽成纯函数便于单测覆盖"整章各套一种 tell"的漏检边界。
export function computeAntiAiClustering(content: string, rules: ClusteringScanRule[]): ClusteringScanResult {
  const scannableRules = rules.filter(
    (rule) => (rule.type === "forbidden" || rule.type === "risk") && rule.enabled,
  );
  const forbiddenRules = scannableRules.filter((rule) => rule.type === "forbidden");
  const forbiddenLiteralPatterns = forbiddenRules.flatMap((rule) => rule.detectPatterns.filter(isLiteralPattern));
  const hasForbiddenLiteralHit = forbiddenLiteralPatterns.some((pattern) => content.includes(pattern));

  const clusteredRuleIds = scannableRules
    .filter((rule) => rule.detectPatterns.some(
      (pattern) => isLiteralPattern(pattern) && content.includes(pattern),
    ))
    .map((rule) => rule.id);
  const clusteredHitCount = new Set(clusteredRuleIds).size;
  const isClustered = clusteredHitCount >= CLUSTERING_THRESHOLD;

  return {
    forbiddenLiteralPatternCount: forbiddenLiteralPatterns.length,
    hasForbiddenLiteralHit,
    clusteredHitCount,
    isClustered,
    shouldSkipLlm: forbiddenLiteralPatterns.length > 0 && !hasForbiddenLiteralHit && !isClustered,
  };
}

// 聚类兜底：成簇时把 LLM 的 riskScore 抬到下限，防 LLM 低估导致漏放。
// 仅当 LLM 也确实报了 violations 才兜底——否则"3 个字面量作为常用词合法出现、
// 但 LLM 判定文本干净（0 violations）"会被错误抬到 45，产生自相矛盾报告并触发无谓改写。
export function applyClusteredRiskFloor(
  llmRiskScore: number,
  isClustered: boolean,
  hasViolations: boolean,
): number {
  const clamped = Math.max(0, Math.min(100, Math.round(llmRiskScore)));
  return isClustered && hasViolations ? Math.max(clamped, CLUSTERED_RISK_FLOOR) : clamped;
}

export class StyleDetectionService {
  private readonly resolver = new StyleRuntimeResolver();

  async check(input: DetectionInput): Promise<StyleDetectionReport> {
    // 确定性 pronoun L0 必须在所有 early-return 之前收集：empty contract / shouldSkipLlm
    // 短路也不能漏掉句首他/她堆叠（deep review T2 must-fix）。
    const pronounViolations = collectPronounStyleViolations(input.content);

    const resolved = await this.resolver.resolve({
      styleProfileId: input.styleProfileId,
      novelId: input.novelId,
      chapterId: input.chapterId,
      taskStyleProfileId: input.taskStyleProfileId,
    });
    const previewRules = await listPreviewAntiAiRules(input.previewAntiAiRuleIds);
    const existingRuleIds = new Set(resolved.antiAiRules.map((rule) => rule.id));
    const extraPreviewRules = previewRules.filter((rule) => !existingRuleIds.has(rule.id));
    const antiRules = mergeAntiAiRules(resolved.antiAiRules, previewRules);
    const appliedRuleIds = antiRules.map((rule) => rule.id);
    const contract = resolved.context.compiledBlocks?.contract ?? null;
    const styleContractText = [
      buildFullStyleContractText(contract),
      buildAntiAiRuleDirectiveText(extraPreviewRules),
    ].filter(Boolean).join("\n\n");
    const styleContractMetaText = buildStyleContractMetaText(contract);
    const antiRuleCatalogText = buildAntiAiRuleCatalogText(antiRules);

    if (!styleContractText && antiRules.length === 0) {
      return mergePronounIntoDetectionReport({
        riskScore: 0,
        summary: "当前没有可执行的写法检测约束，未执行写法违规检测。",
        violations: [],
        canAutoRewrite: false,
        appliedRuleIds,
      }, pronounViolations);
    }

    // 字面量快扫 + 聚类判定（humanizer：单点从宽、成簇从严）：
    //  - forbidden 规则命中任意 1 个即走 LLM（硬违禁，单点也要查）。
    //  - 命中 ≥阈值个不同规则（含 risk）判定为成簇，强制走 LLM 深检并给 riskScore 兜底。
    //  - forbidden 有字面量但 0 命中且未成簇 → 短路跳过 LLM 省成本。
    //  注意：短路后仍 merge pronoun；不得因 shouldSkipLlm 把 hard pronoun 清成 risk 0。
    const clustering = computeAntiAiClustering(input.content, antiRules);
    const isClustered = clustering.isClustered;

    if (clustering.shouldSkipLlm) {
      console.debug("[style-detect] fast-scan:skip-llm, no literal forbidden pattern matched, no cluster");
      return mergePronounIntoDetectionReport({
        riskScore: 0,
        summary: "快扫未检出字面量违禁词，也未构成 AI 痕迹聚类，跳过 LLM 深度检测。",
        violations: [],
        canAutoRewrite: false,
        appliedRuleIds,
      }, pronounViolations);
    }

    const result = await runStructuredPrompt({
      asset: styleDetectionPrompt,
      promptInput: {
        styleContractText: styleContractText || "none",
        styleContractMetaText: styleContractMetaText || "none",
        antiRuleCatalogText: antiRuleCatalogText || "none",
        content: input.content,
      },
      options: {
        provider: input.provider,
        model: input.model,
        temperature: input.temperature ?? 0.2,
      },
    });
    const parsed = result.output;
    // 聚类兜底：成簇且 LLM 也报了 violations 时，即使 LLM 低估 riskScore，也抬到聚类下限，
    // 确保后续 rewrite gate（riskScore≥阈值）能被触发，堵住"整章各套一种 tell"漏检。
    const hasViolations = (parsed.violations ?? []).length > 0;
    const effectiveRiskScore = applyClusteredRiskFloor(parsed.riskScore ?? 0, isClustered, hasViolations);
    const llmReport: StyleDetectionReport = {
      riskScore: effectiveRiskScore,
      summary: parsed.summary ?? "",
      violations: (parsed.violations ?? []).map((item) => {
        const matchedRule = antiRules.find((rule) => rule.id === item.ruleId || rule.name === item.ruleName);
        const ruleId = matchedRule?.id ?? item.ruleId ?? item.ruleName;
        const ruleType = matchedRule?.type ?? item.ruleType;
        const source = inferStyleViolationSource(ruleId, contract);
        return {
          ruleId,
          ruleName: matchedRule?.name ?? item.ruleName,
          ruleType,
          severity: matchedRule?.severity ?? item.severity,
          source,
          issueCategory: inferStyleIssueCategory({
            issueCategory: item.issueCategory,
            source,
            ruleType,
          }),
          excerpt: item.excerpt,
          reason: item.reason,
          suggestion: item.suggestion,
          canAutoRewrite: matchedRule?.autoRewrite ?? item.canAutoRewrite,
        };
      }),
      canAutoRewrite: Boolean(parsed.canAutoRewrite ?? (parsed.violations ?? []).some((item) => item.canAutoRewrite)),
      appliedRuleIds,
    };
    return mergePronounIntoDetectionReport(llmReport, pronounViolations);
  }
}
