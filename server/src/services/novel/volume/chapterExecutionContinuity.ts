import { createHash } from "node:crypto";
import {
  aiChapterTaskSheetQualityAssessmentSchema,
  mapSemanticAssessmentToQualityGate,
  type AiChapterTaskSheetQualityAssessment,
  type ChapterExecutionContractQualityCandidate,
  type ChapterTaskSheetQualityGateResult,
} from "@ai-novel/shared/types/chapterTaskSheetQuality";
import { prisma } from "../../../db/prisma";
import { resolveLLMClientOptions } from "../../../llm/factory";
import { chapterTaskSheetQualityPrompt } from "../../../prompting/prompts/novel/volume/chapterTaskSheetQuality.prompts";
import {
  ChapterTaskSheetQualityGateService,
  type ChapterTaskSheetQualityGateOptions,
} from "./ChapterTaskSheetQualityGateService";

export interface ChapterExecutionContinuityReview {
  assessment: AiChapterTaskSheetQualityAssessment | null;
  result: ChapterTaskSheetQualityGateResult;
}

/**
 * 写前连续性核对（上游 2026-10-17「开写前协调章节规划与前文事实减少返工」移植）。
 *
 * 形状齐全、与章节表字段一致，只能证明合同可以被读取，不能证明仍承接上一章实际
 * 结果。对尚无正文的章节，在复用已有合同进入写作前，用现有任务单质量评估器核对
 * 一次前章正文语义；AI 要求修订时把结构化指导送回现有合同生成链（不添加额外生成
 * 循环），不可同步的结果保留给作者确认，不静默覆盖规划。已有正文的章节不重新检查。
 *
 * `chapter_execution_continuity:v1` 只缓存相同实际输入的 AI 结果。身份包括当前合同
 * （含前章完整正文）、模式、Prompt 版本与解析后的实际模型配置；调用方未显式给出
 * provider/model 时按默认路由解析身份（JIT 链路不透传模型身份，必须在此补齐，否则
 * 主热路径永远 miss）。解析失败（如未配置任何厂商）则退回不复用。
 * 该检查属于规划准备，不占正文审校/修文复验的额外请求额度，也不重置其记录。
 */
export async function reviewChapterExecutionContinuity(
  candidate: ChapterExecutionContractQualityCandidate,
  options: ChapterTaskSheetQualityGateOptions,
): Promise<ChapterExecutionContinuityReview | null> {
  const previous = candidate.previousChapterResult;
  if (!previous?.content?.trim()) {
    return null;
  }
  options.signal?.throwIfAborted();
  const mode = options.mode ?? "ai_copilot";
  // 身份用解析后的实际模型配置：调用方没给 provider/model（如 JIT 链路）时按默认
  // 路由解析；解析失败退回不复用（宁可重复审查，不可跨模型身份复用结论）。
  let identityModel: {
    provider: string;
    model: string;
    baseURL: string;
    temperature: number;
    maxTokens: number | null;
    requestProtocol: string;
    structuredStrategy: string | null;
  } | null = null;
  try {
    const resolved = await resolveLLMClientOptions(options.provider, {
      model: options.model,
      temperature: options.temperature ?? 0.1,
      taskType: "review",
      executionMode: "structured",
    });
    identityModel = {
      provider: String(resolved.provider),
      model: resolved.model,
      baseURL: resolved.baseURL,
      temperature: resolved.temperature,
      maxTokens: resolved.maxTokens ?? null,
      requestProtocol: String(resolved.requestProtocol),
      structuredStrategy: resolved.structuredStrategy ?? null,
    };
  } catch {
    identityModel = null;
  }
  const identity = createHash("sha256").update(JSON.stringify({
    mode,
    candidate,
    promptVersion: chapterTaskSheetQualityPrompt.version,
    model: identityModel,
  })).digest("hex");
  const key = {
    novelId: candidate.novelId,
    chapterId: candidate.chapterId,
    contentHash: identity,
    artifactType: "chapter_execution_continuity:v1",
    syncMode: "planning",
    contentRevision: 0,
  };
  const where = { novelId_chapterId_contentHash_artifactType_syncMode: key };
  const row = identityModel
    ? await prisma.chapterArtifactSyncCheckpoint.findUnique({ where, select: { status: true, metadataJson: true } })
    : null;
  let assessment: AiChapterTaskSheetQualityAssessment | undefined;
  if (row?.status === "succeeded") {
    try {
      assessment = aiChapterTaskSheetQualityAssessmentSchema.parse(JSON.parse(row.metadataJson ?? "null"));
    } catch {
      // 损坏的缓存永远不能作为规划复用的依据。
    }
  }
  let result: ChapterTaskSheetQualityGateResult | null = null;
  if (!assessment) {
    result = await new ChapterTaskSheetQualityGateService().evaluate(candidate, {
      ...options,
      mode,
      ...(identityModel
        ? {
          provider: identityModel.provider,
          model: identityModel.model,
          temperature: identityModel.temperature,
        }
        : {}),
      onEvaluated: (event) => {
        assessment = event.assessment;
      },
    });
    options.signal?.throwIfAborted();
    if (assessment && identityModel) {
      await prisma.chapterArtifactSyncCheckpoint.upsert({
        where,
        create: { ...key, status: "succeeded", metadataJson: JSON.stringify(assessment) },
        update: { status: "succeeded", metadataJson: JSON.stringify(assessment) },
      }).catch(() => undefined);
    }
  }
  options.signal?.throwIfAborted();
  if (!result) {
    if (!assessment) {
      throw new Error("本章规划未完成与前文的核对，请保留规划后重试。");
    }
    result = mapSemanticAssessmentToQualityGate(assessment, mode);
  }
  return {
    assessment: assessment ?? null,
    result,
  };
}
