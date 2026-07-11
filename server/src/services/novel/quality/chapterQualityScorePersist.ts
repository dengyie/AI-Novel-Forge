import type { QualityScore, ReviewIssue } from "@ai-novel/shared/types/novel";
import { prisma } from "../../../db/prisma";

/**
 * Chapter 列上的可运营分数字段（schema 已有，finalize 热路径历史上未写入）。
 * QualityScore 六维 → 四列拍平（schema 仅四列，repetition/engagement 只进 QualityReport）：
 * - qualityScore ← overall
 * - continuityScore ← coherence（连贯/连续）
 * - characterScore ← voice（角色声口/人物感；非独立「人物连续性」审计分，导出/看板勿当 character arc 分）
 * - pacingScore ← pacing
 *
 * 写路径所有权：
 * - finalize：writeReport=false，只更新 Chapter 列（含 retry 中间次）
 * - createQualityReport / manual review：writeReport=true，终态一行 QualityReport + 列
 */
export interface ChapterQualityScoreColumns {
  qualityScore: number;
  continuityScore: number;
  characterScore: number;
  pacingScore: number;
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function mapQualityScoreToChapterColumns(score: QualityScore): ChapterQualityScoreColumns {
  return {
    qualityScore: clampScore(score.overall),
    continuityScore: clampScore(score.coherence),
    characterScore: clampScore(score.voice),
    pacingScore: clampScore(score.pacing),
  };
}

export interface PersistChapterQualityScoresInput {
  novelId: string;
  chapterId: string;
  score: QualityScore;
  issues?: ReviewIssue[];
  /** 默认 true：同时写 QualityReport 行 */
  writeReport?: boolean;
}

/**
 * 把 QualityScore 拍平到 Chapter 列，并可选写入 QualityReport。
 * 失败由调用方决定是否 fail-open；本函数本身抛错。
 */
export async function persistChapterQualityScores(
  input: PersistChapterQualityScoresInput,
): Promise<ChapterQualityScoreColumns> {
  const columns = mapQualityScoreToChapterColumns(input.score);
  const writeReport = input.writeReport !== false;
  const issues = input.issues ?? [];

  await prisma.$transaction(async (tx) => {
    await tx.chapter.update({
      where: { id: input.chapterId },
      data: columns,
    });
    if (writeReport) {
      await tx.qualityReport.create({
        data: {
          novelId: input.novelId,
          chapterId: input.chapterId,
          coherence: clampScore(input.score.coherence),
          repetition: clampScore(input.score.repetition),
          pacing: clampScore(input.score.pacing),
          voice: clampScore(input.score.voice),
          engagement: clampScore(input.score.engagement),
          overall: clampScore(input.score.overall),
          issues: issues.length > 0 ? JSON.stringify(issues) : null,
        },
      });
    }
  });

  return columns;
}
