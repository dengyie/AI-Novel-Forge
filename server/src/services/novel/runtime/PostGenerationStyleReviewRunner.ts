import type {
  GenerationContextPackage,
  RuntimeStyleDetectionReport,
} from "@ai-novel/shared/types/chapterRuntime";
import { StyleDetectionService } from "../../styleEngine/StyleDetectionService";
import { StyleRewriteService } from "../../styleEngine/StyleRewriteService";
import type { ChapterRuntimeRequestInput } from "./chapterRuntimeSchema";
import {
  DEFAULT_SECOND_ROUND_THRESHOLD,
  PostGenerationStyleReviewPolicyResolver,
} from "./PostGenerationStyleReviewPolicyResolver";

// 首轮改写触发阈值：detect 后 riskScore 达到此值且有可改写项才启动首轮改写。
const FIRST_ROUND_REWRITE_THRESHOLD = 35;

export interface StyleReviewResult {
  // 首轮入口检测报告，描述改写前原始正文的 AI 味。
  report: RuntimeStyleDetectionReport | null;
  // 最终交付正文的残留检测报告（改写后重检的结果）。未改写或未重检时为 null。
  // 调用方若要记录"交付章节的真实 AI 味"，应优先读此字段而非 report。
  residualReport: RuntimeStyleDetectionReport | null;
  autoRewritten: boolean;
  originalContent: string | null;
  finalContent: string;
}

export interface PostGenerationStyleReviewInput {
  novelId: string;
  chapterId: string;
  request: ChapterRuntimeRequestInput;
  contextPackage: GenerationContextPackage;
  content: string;
}

interface PostGenerationStyleReviewRunnerDeps {
  styleDetectionService?: Pick<StyleDetectionService, "check">;
  styleRewriteService?: Pick<StyleRewriteService, "rewrite">;
  postGenerationStyleReviewPolicyResolver?: Pick<PostGenerationStyleReviewPolicyResolver, "resolve">;
}

export class PostGenerationStyleReviewRunner {
  private readonly deps: Required<PostGenerationStyleReviewRunnerDeps>;

  constructor(deps: PostGenerationStyleReviewRunnerDeps = {}) {
    this.deps = {
      styleDetectionService: deps.styleDetectionService ?? new StyleDetectionService(),
      styleRewriteService: deps.styleRewriteService ?? new StyleRewriteService(),
      postGenerationStyleReviewPolicyResolver: deps.postGenerationStyleReviewPolicyResolver
        ?? new PostGenerationStyleReviewPolicyResolver(),
    };
  }

  async run(input: PostGenerationStyleReviewInput): Promise<StyleReviewResult> {
    // 先做无 IO 的短路：没有 styleContext 就无可审内容，直接返回，避免空跑 policy
    // resolve 的 prisma 查询（finalize 路径里无 styleContext 的场景不应触发 DB 读）。
    if (!input.contextPackage.styleContext?.compiledBlocks) {
      return this.noRewriteResult(null, input.content);
    }

    const policy = await this.deps.postGenerationStyleReviewPolicyResolver.resolve(input.novelId).catch(() => ({
      enabled: true,
      // resolve 失败时保守退回单轮，避免 fallback 路径意外触发二轮改写增加成本。
      secondRoundEnabled: false,
      secondRoundThreshold: DEFAULT_SECOND_ROUND_THRESHOLD,
    }));
    if (!policy.enabled) {
      return this.noRewriteResult(null, input.content);
    }

    let report: RuntimeStyleDetectionReport | null = null;
    try {
      report = await this.detect(input, input.content);
    } catch {
      return this.noRewriteResult(null, input.content);
    }

    const rewritableIssues = report.violations.filter((item) => item.canAutoRewrite && item.suggestion.trim());
    const shouldAutoRewrite = report.canAutoRewrite
      && rewritableIssues.length > 0
      && report.riskScore >= FIRST_ROUND_REWRITE_THRESHOLD;

    if (!shouldAutoRewrite) {
      return this.noRewriteResult(report, input.content);
    }

    // 首轮改写。
    const firstRoundContent = await this.rewriteOnce(input, rewritableIssues);
    if (firstRoundContent == null) {
      return this.noRewriteResult(report, input.content);
    }

    // 双轮自审：对首轮产物再检测一次，只有残留 AI 味仍偏高时才追加第二轮改写。
    // 借鉴 humanizer 的 draft → "还有什么像 AI" → final 流程。渠道慢/控成本时
    // policy.secondRoundEnabled=false 直接退回单轮。硬上限两轮，防无限循环。
    // finalContent / residualReport 始终指向"当前采纳的交付内容及其检测分"。
    let finalContent = firstRoundContent;
    let residualReport: RuntimeStyleDetectionReport | null = null;
    if (policy.secondRoundEnabled) {
      const firstResidual = await this.detect(input, firstRoundContent).catch(() => null);
      residualReport = firstResidual;

      if (firstResidual) {
        const residualIssues = firstResidual.violations.filter(
          (item) => item.canAutoRewrite && item.suggestion.trim(),
        );
        const shouldSecondRound = firstResidual.canAutoRewrite
          && residualIssues.length > 0
          && firstResidual.riskScore >= policy.secondRoundThreshold;

        if (shouldSecondRound) {
          const secondRoundContent = await this.rewriteOnce(
            { ...input, content: firstRoundContent },
            residualIssues,
          );
          if (secondRoundContent != null) {
            // 质量回退门：二轮产物必须重检确认 riskScore 真的低于首轮残留才采纳，
            // 否则保留首轮，避免二轮改写把内容改差（保障"不降低质量"）。
            // 二轮重检失败（LLM 出错）时保守回退首轮，不赌未验证的产物。
            const secondResidual = await this.detect(input, secondRoundContent).catch(() => null);
            if (secondResidual && secondResidual.riskScore < firstResidual.riskScore) {
              finalContent = secondRoundContent;
              residualReport = secondResidual;
            }
          }
        }
      }
    }

    const autoRewritten = finalContent.trim() !== input.content.trim();
    return {
      report,
      residualReport: autoRewritten ? residualReport : null,
      autoRewritten,
      originalContent: autoRewritten ? input.content : null,
      finalContent: autoRewritten ? finalContent : input.content,
    };
  }

  // 未发生改写的统一返回：finalContent 为原文，residualReport 为 null。
  private noRewriteResult(
    report: RuntimeStyleDetectionReport | null,
    content: string,
  ): StyleReviewResult {
    return {
      report,
      residualReport: null,
      autoRewritten: false,
      originalContent: null,
      finalContent: content,
    };
  }

  // 对给定正文跑一次风格检测。
  private async detect(
    input: PostGenerationStyleReviewInput,
    content: string,
  ): Promise<RuntimeStyleDetectionReport> {
    return this.deps.styleDetectionService.check({
      content,
      novelId: input.novelId,
      chapterId: input.chapterId,
      taskStyleProfileId: input.request.taskStyleProfileId,
      provider: input.request.provider,
      model: input.request.model,
      temperature: 0.2,
    });
  }

  // 执行一次改写；成功返回非空改写正文，失败或产物为空返回 null。
  private async rewriteOnce(
    input: PostGenerationStyleReviewInput,
    issues: RuntimeStyleDetectionReport["violations"],
  ): Promise<string | null> {
    try {
      const rewritten = await this.deps.styleRewriteService.rewrite({
        content: input.content,
        novelId: input.novelId,
        chapterId: input.chapterId,
        taskStyleProfileId: input.request.taskStyleProfileId,
        issues: issues.map((item) => ({
          ruleName: item.ruleName,
          excerpt: item.excerpt,
          suggestion: item.suggestion,
        })),
        provider: input.request.provider,
        model: input.request.model,
        temperature: Math.min(input.request.temperature ?? 0.5, 0.7),
      });
      const trimmed = rewritten.content.trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }
}
