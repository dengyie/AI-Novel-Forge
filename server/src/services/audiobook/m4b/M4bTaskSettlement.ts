import fs from "node:fs";
import type { Prisma } from "@prisma/client";
import type { AudiobookQualityFlag } from "@ai-novel/shared/types/audiobook";
import { buildQualityCompletionLabel } from "../diarize/diarizeQualityGate";

/** Caller must hold the task row lock before reading the owned job. */
export async function projectCurrentM4bJob(tx: Prisma.TransactionClient, input: {
  taskId: string;
  generationToken: string;
  resultJson: string | null;
  completedChapterCount: number;
}): Promise<{ resultJson?: string; currentItemLabel?: string; summary?: string }> {
  const job = await tx.m4bEncodingJob.findUnique({ where: { audiobookTaskId: input.taskId } });
  if (!job || job.generationToken !== input.generationToken) return {};
  let result: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(input.resultJson || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) result = parsed;
  } catch { /* Keep a readable terminal projection if old diagnostics are malformed. */ }
  const status = job.status === "completed" ? "ready" : job.status === "failed" ? "failed" : "encoding";
  const qualityFlags = Array.isArray(result.qualityFlags) ? result.qualityFlags as AudiobookQualityFlag[] : [];
  const narratorFallbackCount = typeof result.narratorFallbackChapterCount === "number" ? result.narratorFallbackChapterCount : 0;
  const note = status === "encoding" ? "m4b 后台封装中" : status === "failed" ? "m4b 封装失败，可重试" : undefined;
  const currentItemLabel = buildQualityCompletionLabel({ qualityFlags, narratorFallbackCount, m4bReady: status === "ready", m4bNote: note })
    + (note && !qualityFlags.length && narratorFallbackCount === 0 ? `；${note}` : "");
  result.m4b = {
    status, path: "full-book.m4b", reason: status === "failed" ? job.errorMessage : null,
    bytes: status === "ready" ? fs.statSync(job.outputM4bPath).size : null,
    chapterCount: input.completedChapterCount,
  };
  return {
    resultJson: JSON.stringify(result), currentItemLabel,
    summary: `有声书完成：${input.completedChapterCount} 章，${Number(result.completedChunks) || 0} 个音频块；${currentItemLabel}。`,
  };
}

export async function settleCurrentM4bTask(tx: Prisma.TransactionClient, taskId: string, generationToken: string): Promise<void> {
  const task = await tx.audiobookTask.findUniqueOrThrow({ where: { id: taskId } });
  const projection = await projectCurrentM4bJob(tx, { taskId, generationToken,
    resultJson: task.resultJson, completedChapterCount: task.completedChapterCount });
  // Before chapter finalization, keep its running-stage label and counts intact.
  await tx.audiobookTask.update({ where: { id: taskId },
    data: task.status === "running" ? { resultJson: projection.resultJson } : projection });
}
