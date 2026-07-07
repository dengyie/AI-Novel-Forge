import type {
  GenerationContextPackage,
  RuntimeStyleDetectionReport,
} from "@ai-novel/shared/types/chapterRuntime";
import { StyleDetectionService } from "../../styleEngine/StyleDetectionService";
import { StyleRewriteService } from "../../styleEngine/StyleRewriteService";
import type { ChapterRuntimeRequestInput } from "./chapterRuntimeSchema";
import { PostGenerationStyleReviewPolicyResolver } from "./PostGenerationStyleReviewPolicyResolver";

// 首轮改写触发阈值：detect 后 riskScore 达到此值且有可改写项才启动首轮改写。
const FIRST_ROUND_REWRITE_THRESHOLD = 35;

export interface StyleReviewResult {
  report: RuntimeStyleDetectionReport | null;
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
    const policy = await this.deps.postGenerationStyleReviewPolicyResolver.resolve(input.novelId).catch(() => ({
      enabled: true,
    }));
    if (!policy.enabled) {
      return {
        report: null,
        autoRewritten: false,
        originalContent: null,
        finalContent: input.content,
      };
    }

    if (!input.contextPackage.styleContext?.compiledBlocks) {
      return {
        report: null,
        autoRewritten: false,
        originalContent: null,
        finalContent: input.content,
      };
    }

    let report: RuntimeStyleDetectionReport | null = null;
    try {
      report = await this.deps.styleDetectionService.check({
        content: input.content,
        novelId: input.novelId,
        chapterId: input.chapterId,
        taskStyleProfileId: input.request.taskStyleProfileId,
        provider: input.request.provider,
        model: input.request.model,
        temperature: 0.2,
      });
    } catch {
      return {
        report: null,
        autoRewritten: false,
        originalContent: null,
        finalContent: input.content,
      };
    }

    const rewritableIssues = report.violations.filter((item) => item.canAutoRewrite && item.suggestion.trim());
    const shouldAutoRewrite = report.canAutoRewrite
      && rewritableIssues.length > 0
      && report.riskScore >= FIRST_ROUND_REWRITE_THRESHOLD;

    if (!shouldAutoRewrite) {
      return {
        report,
        autoRewritten: false,
        originalContent: null,
        finalContent: input.content,
      };
    }

    // 首轮改写。
    const firstRoundContent = await this.rewriteOnce(input, rewritableIssues);
    if (firstRoundContent == null) {
      return {
        report,
        autoRewritten: false,
        originalContent: null,
        finalContent: input.content,
      };
    }

    // 双轮自审：对首轮产物再检测一次，只有残留 AI 味仍偏高时才追加第二轮改写。
    // 借鉴 humanizer 的 draft → "还有什么像 AI" → final 流程。渠道慢/控成本时
    // policy.secondRoundEnabled=false 直接退回单轮。硬上限两轮，防无限循环。
    let finalContent = firstRoundContent;
    let residualReport: RuntimeStyleDetectionReport | null = null;
    if (policy.secondRoundEnabled) {
      residualReport = await this.deps.styleDetectionService.check({
        content: firstRoundContent,
        novelId: input.novelId,
        chapterId: input.chapterId,
        taskStyleProfileId: input.request.taskStyleProfileId,
        provider: input.request.provider,
        model: input.request.model,
        temperature: 0.2,
      }).catch(() => null);

      if (residualReport) {
        const residualIssues = residualReport.violations.filter(
          (item) => item.canAutoRewrite && item.suggestion.trim(),
        );
        const shouldSecondRound = residualReport.canAutoRewrite
          && residualIssues.length > 0
          && residualReport.riskScore >= policy.secondRoundThreshold;

        if (shouldSecondRound) {
          const secondRoundContent = await this.rewriteOnce(
            { ...input, content: firstRoundContent },
            residualIssues,
          );
          if (secondRoundContent != null) {
            finalContent = secondRoundContent;
          }
        }
      }
    }

    const autoRewritten = finalContent.trim() !== input.content.trim();
    return {
      report,
      autoRewritten,
      originalContent: autoRewritten ? input.content : null,
      finalContent: autoRewritten ? finalContent : input.content,
    };
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
