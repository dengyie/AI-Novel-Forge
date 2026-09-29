import type { AudiobookQualityFlag } from "@ai-novel/shared/types/audiobook";
import { prisma } from "../../../../db/prisma";
import type { RunAudiobookPipelineResult } from "../../AudiobookPipelineService";
import { pruneChunkWavArtifacts } from "../../audiobookPaths";
import { buildQualityCompletionLabel, collectTaskQualityFlags, isWholeChapterNarratorFallback } from "../../diarize/diarizeQualityGate";
import { projectCurrentM4bJob } from "../../m4b";

/** Completes chapter production while preserving concurrent owned M4B settlement. */
export async function finalizeAudiobookTask(input: {
  taskId: string; generationToken: string; isContinueChild: boolean; result: RunAudiobookPipelineResult;
}): Promise<void> {
  const { taskId, generationToken, isContinueChild, result } = input;
  const annotationFallbackCount = result.annotations.filter(isWholeChapterNarratorFallback).length;
  const qualityFlags: AudiobookQualityFlag[] = collectTaskQualityFlags(result.annotations);
  const annotationSuffix = annotationFallbackCount > 0
    ? `；标注回退 ${annotationFallbackCount} 章`
    : qualityFlags.includes("cast_degraded")
      ? "；cast 降级"
      : "";
  const m4bSuffix = result.m4b.status === "ready"
    ? "，含 m4b"
    : result.m4b.status === "skipped"
      ? `；m4b 未生成（${result.m4b.reason ?? "skipped"}）`
      : result.m4b.status === "failed"
        ? `；m4b 失败（${result.m4b.reason ?? "failed"}）`
        : "";
  const m4bNote = result.m4b.status === "skipped"
    ? `m4b 未生成（${result.m4b.reason ?? "skipped"}）`
    : result.m4b.status === "failed"
      ? `m4b 失败（${result.m4b.reason ?? "failed"}）`
      : undefined;
  const currentItemLabel = buildQualityCompletionLabel({
    qualityFlags,
    narratorFallbackCount: annotationFallbackCount,
    m4bReady: result.m4b.status === "ready",
    m4bNote,
  });

  await prisma.$transaction(async (tx) => {
    const owned = await tx.audiobookTask.updateMany({
      where: { id: taskId, status: "running", cancelRequestedAt: null, m4bGenerationToken: generationToken },
      data: { m4bGenerationToken: generationToken },
    });
    if (!owned.count) return;
    // 成功后删 chunk，保留 chapter.wav / full-book.*；重合成会 wipe 整章再生成
    const chapterIdsForPrune = result.chapterAudioPaths.map((item) => item.chapterId);
    let chunksPruned = false;
    let prunedChunkFiles = 0;
    try {
      prunedChunkFiles = pruneChunkWavArtifacts(result.outputDir, chapterIdsForPrune);
      chunksPruned = true;
    } catch (pruneError) {
      chunksPruned = false;
      prunedChunkFiles = 0;
      console.warn(
        "[audiobook] pruneChunkWavArtifacts failed",
        taskId,
        pruneError instanceof Error ? pruneError.message : pruneError,
      );
    }

    // Continue children invalidated shared full-book artifacts under the
    // generation fence before pipeline reads. The child pipeline never
    // recreates them; reconcileParent alone rebuilds from the full chapter set.

    const resultJson = JSON.stringify({
      chapterIds: chapterIdsForPrune, completedChunks: result.completedChunks,
      qualityWarnings: result.qualityWarnings, qualityFlags,
      narratorFallbackChapterCount: annotationFallbackCount,
      castDegraded: qualityFlags.includes("cast_degraded"), chunksPruned, prunedChunkFiles,
      m4b: { status: result.m4b.status, path: result.m4b.relativePath,
        reason: result.m4b.reason ?? null, bytes: result.m4b.bytes ?? null,
        chapterCount: result.m4b.chapterCount ?? null },
    });
    const projection = await projectCurrentM4bJob(tx, {
      taskId, generationToken, resultJson, completedChapterCount: result.completedChapterCount,
    });
    await tx.audiobookTask.updateMany({
      where: {
        id: taskId,
        status: "running",
        cancelRequestedAt: null,
        m4bGenerationToken: generationToken,
      },
      data: {
        status: "succeeded",
        progress: 100,
        finishedAt: new Date(),
        currentStage: "finalizing",
        currentItemLabel,
        heartbeatAt: new Date(),
        completedChapterCount: result.completedChapterCount,
        outputDir: result.outputDir,
        // Continue children never publish the parent's full-book artifact.
        fullAudioPath: isContinueChild ? null : "full-book.wav",
        annotationsJson: JSON.stringify(result.annotations),
        resultJson,
        summary: `有声书完成：${result.completedChapterCount} 章，${result.completedChunks} 个音频块${annotationSuffix}${m4bSuffix}。`,
        error: null,
        ...projection,
      },
    });
  });
}
