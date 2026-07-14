import type {
  AiChapterTaskSheetQualityAssessment,
  ChapterExecutionContractQualityCandidate,
  ChapterTaskSheetQualityGateResult,
  ChapterTaskSheetQualityMode,
} from "@ai-novel/shared/types/chapterTaskSheetQuality";
import {
  assessChapterExecutionContractShape,
  formatChapterTaskSheetQualityFailure,
  mapSemanticAssessmentToQualityGate,
} from "@ai-novel/shared/types/chapterTaskSheetQuality";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { runStructuredPrompt } from "../../../prompting/core/promptRunner";
import {
  chapterTaskSheetQualityPrompt,
} from "../../../prompting/prompts/novel/volume/chapterTaskSheetQuality.prompts";

export interface ChapterTaskSheetQualityGateOptions {
  mode?: ChapterTaskSheetQualityMode;
  /**
   * 设定对齐质量模式（B4）。缺省 off：模板语义规则只 advisory。
   * enforce 时 cognitive_nailing / 缺选择 / 缺现场可升 high 阻断。
   */
  settingQualityMode?: "off" | "advisory" | "enforce";
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
  taskId?: string;
  entrypoint?: string;
  signal?: AbortSignal;
}

export type ChapterTaskSheetSemanticAssessor = (input: {
  candidate: ChapterExecutionContractQualityCandidate;
  mode: ChapterTaskSheetQualityMode;
  options: ChapterTaskSheetQualityGateOptions;
}) => Promise<AiChapterTaskSheetQualityAssessment>;

function normalizeQualityMode(mode?: ChapterTaskSheetQualityMode): ChapterTaskSheetQualityMode {
  return mode ?? "ai_copilot";
}

function ensureFailureResult(result: ChapterTaskSheetQualityGateResult): ChapterTaskSheetQualityGateResult {
  if (!result.canEnterExecution) {
    return result;
  }
  return {
    ...result,
    status: "passed",
  };
}

export class ChapterTaskSheetQualityGateError extends Error {
  constructor(readonly result: ChapterTaskSheetQualityGateResult) {
    super(formatChapterTaskSheetQualityFailure(result));
    this.name = "ChapterTaskSheetQualityGateError";
  }
}

export class ChapterTaskSheetQualityGateService {
  constructor(private readonly semanticAssessor?: ChapterTaskSheetSemanticAssessor) {}

  async evaluate(
    candidate: ChapterExecutionContractQualityCandidate,
    options: ChapterTaskSheetQualityGateOptions = {},
  ): Promise<ChapterTaskSheetQualityGateResult> {
    const mode = normalizeQualityMode(options.mode);
    // B4：模板语义规则（钉认知/选择/现场）在 shape 阶段先跑；severity 随 qualityMode/settingQualityMode 升降
    const shapeResult = assessChapterExecutionContractShape(candidate, {
      qualityMode: mode,
      settingQualityMode: options.settingQualityMode,
    });
    if (!shapeResult.canEnterExecution) {
      return shapeResult;
    }

    const assessment = this.semanticAssessor
      ? await this.semanticAssessor({ candidate, mode, options })
      : await this.runSemanticAssessment(candidate, mode, options);
    return ensureFailureResult(mapSemanticAssessmentToQualityGate(assessment, mode));
  }

  async assertCanEnterExecution(
    candidate: ChapterExecutionContractQualityCandidate,
    options: ChapterTaskSheetQualityGateOptions = {},
  ): Promise<ChapterTaskSheetQualityGateResult> {
    const result = await this.evaluate(candidate, options);
    if (!result.canEnterExecution) {
      throw new ChapterTaskSheetQualityGateError(result);
    }
    return result;
  }

  private async runSemanticAssessment(
    candidate: ChapterExecutionContractQualityCandidate,
    mode: ChapterTaskSheetQualityMode,
    options: ChapterTaskSheetQualityGateOptions,
  ): Promise<AiChapterTaskSheetQualityAssessment> {
    const generated = await runStructuredPrompt({
      asset: chapterTaskSheetQualityPrompt,
      promptInput: {
        candidate,
        mode,
      },
      options: {
        provider: options.provider,
        model: options.model,
        temperature: options.temperature ?? 0.1,
        taskId: options.taskId,
        entrypoint: options.entrypoint,
        novelId: candidate.novelId,
        volumeId: candidate.volumeId ?? undefined,
        chapterId: candidate.chapterId,
        stage: "chapter_task_sheet_quality",
        itemKey: "chapter_detail_bundle",
        scope: "chapter_detail",
        triggerReason: "chapter_task_sheet_quality_gate",
        signal: options.signal,
      },
    });
    return generated.output;
  }
}
