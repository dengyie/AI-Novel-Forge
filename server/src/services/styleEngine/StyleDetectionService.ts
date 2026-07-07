import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { StyleDetectionReport } from "@ai-novel/shared/types/styleEngine";
import { runStructuredPrompt } from "../../prompting/core/promptRunner";
import { styleDetectionPrompt } from "../../prompting/prompts/style/style.prompts";
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
export function applyClusteredRiskFloor(llmRiskScore: number, isClustered: boolean): number {
  const clamped = Math.max(0, Math.min(100, Math.round(llmRiskScore)));
  return isClustered ? Math.max(clamped, CLUSTERED_RISK_FLOOR) : clamped;
}

export class StyleDetectionService {
  private readonly resolver = new StyleRuntimeResolver();

  async check(input: DetectionInput): Promise<StyleDetectionReport> {
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
      return {
        riskScore: 0,
        summary: "当前没有可执行的写法检测约束，未执行写法违规检测。",
        violations: [],
        canAutoRewrite: false,
        appliedRuleIds,
      };
    }

    // 字面量快扫 + 聚类判定（humanizer：单点从宽、成簇从严）：
    //  - forbidden 规则命中任意 1 个即走 LLM（硬违禁，单点也要查）。
    //  - 命中 ≥阈值个不同规则（含 risk）判定为成簇，强制走 LLM 深检并给 riskScore 兜底。
    //  - forbidden 有字面量但 0 命中且未成簇 → 短路跳过 LLM 省成本。
    const clustering = computeAntiAiClustering(input.content, antiRules);
    const isClustered = clustering.isClustered;

    if (clustering.shouldSkipLlm) {
      console.debug("[style-detect] fast-scan:skip-llm, no literal forbidden pattern matched, no cluster");
      return {
        riskScore: 0,
        summary: "快扫未检出字面量违禁词，也未构成 AI 痕迹聚类，跳过 LLM 深度检测。",
        violations: [],
        canAutoRewrite: false,
        appliedRuleIds,
      };
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
    // 聚类兜底：成簇时即使 LLM 低估 riskScore，也抬到聚类下限，
    // 确保后续 rewrite gate（riskScore≥阈值）能被触发，堵住"整章各套一种 tell"漏检。
    const effectiveRiskScore = applyClusteredRiskFloor(parsed.riskScore ?? 0, isClustered);
    return {
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
  }
}
