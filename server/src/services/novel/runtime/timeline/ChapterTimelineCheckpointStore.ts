import { prisma } from "../../../../db/prisma";
import {
  ARTIFACT_CHECKPOINT_RUNNING_STALE_MS,
  reclaimStaleRunningArtifactCheckpointsThrottled,
} from "../ChapterArtifactSyncCheckpointHygiene";

export type ChapterTimelineFinalizationMode = "stable" | "degraded";
export type TimelineFinalizationClaimStatus = "claimed" | "already_done" | "running";

interface TimelineCheckpointIdentity {
  novelId: string;
  chapterId: string;
  contentHash: string;
  syncMode: ChapterTimelineFinalizationMode;
}

interface TimelineCheckpointWrite extends TimelineCheckpointIdentity {
  sourceStage: string;
  metadata: Record<string, unknown>;
}

export class ChapterTimelineCheckpointStore {
  async findCurrentMode(input: Omit<TimelineCheckpointIdentity, "syncMode">): Promise<ChapterTimelineFinalizationMode | null> {
    await reclaimStaleRunningArtifactCheckpointsThrottled({ limit: 100 }).catch(() => 0);
    const row = await prisma.chapterArtifactSyncCheckpoint.findFirst({
      where: {
        novelId: input.novelId,
        chapterId: input.chapterId,
        contentHash: input.contentHash,
        artifactType: "timeline_finalization",
        syncMode: { in: ["stable", "degraded"] },
        status: "succeeded",
      },
      orderBy: [{ syncMode: "desc" }, { updatedAt: "desc" }],
      select: { syncMode: true },
    });
    return row?.syncMode === "stable" || row?.syncMode === "degraded" ? row.syncMode : null;
  }

  async markSucceeded(input: TimelineCheckpointWrite): Promise<void> {
    await prisma.chapterArtifactSyncCheckpoint.upsert({
      where: {
        novelId_chapterId_contentHash_artifactType_syncMode: {
          ...checkpointKey(input),
        },
      },
      create: {
        ...checkpointKey(input),
        status: "succeeded",
        sourceType: "chapter_runtime",
        sourceStage: input.sourceStage,
        metadataJson: JSON.stringify(input.metadata),
      },
      update: {
        status: "succeeded",
        sourceType: "chapter_runtime",
        sourceStage: input.sourceStage,
        metadataJson: JSON.stringify(input.metadata),
        updatedAt: new Date(),
      },
    });
  }

  async claim(input: TimelineCheckpointWrite): Promise<TimelineFinalizationClaimStatus> {
    const key = checkpointKey(input);
    const where = { novelId_chapterId_contentHash_artifactType_syncMode: key };
    const metadataJson = JSON.stringify(input.metadata);
    try {
      await prisma.chapterArtifactSyncCheckpoint.create({
        data: {
          ...key,
          status: "running",
          sourceType: "chapter_runtime",
          sourceStage: input.sourceStage,
          metadataJson,
        },
      });
      return "claimed";
    } catch {
      const existing = await prisma.chapterArtifactSyncCheckpoint.findUnique({
        where,
        select: { status: true, updatedAt: true },
      }).catch(() => null);
      if (existing?.status === "succeeded") return "already_done";

      const staleBefore = new Date(Date.now() - ARTIFACT_CHECKPOINT_RUNNING_STALE_MS);
      if (existing?.status === "running" && existing.updatedAt > staleBefore) return "running";
      if (existing?.status === "running") {
        await prisma.chapterArtifactSyncCheckpoint.updateMany({
          where: { ...key, status: "running", updatedAt: { lt: staleBefore } },
          data: {
            status: "failed",
            sourceType: "chapter_runtime",
            sourceStage: input.sourceStage,
            metadataJson: JSON.stringify({
              ...input.metadata,
              reason: "stale_running_before_reclaim",
              reclaimedAt: new Date().toISOString(),
            }),
            updatedAt: new Date(),
          },
        }).catch(() => null);
      }
      const claimed = await prisma.chapterArtifactSyncCheckpoint.updateMany({
        where: {
          ...key,
          OR: [{ status: { not: "running" } }, { updatedAt: { lt: staleBefore } }],
        },
        data: {
          status: "running",
          sourceType: "chapter_runtime",
          sourceStage: input.sourceStage,
          metadataJson,
          updatedAt: new Date(),
        },
      }).catch(() => ({ count: 0 }));
      return claimed.count > 0 ? "claimed" : "running";
    }
  }

  async markFailed(input: TimelineCheckpointWrite): Promise<void> {
    await prisma.chapterArtifactSyncCheckpoint.updateMany({
      where: { ...checkpointKey(input), status: "running" },
      data: {
        status: "failed",
        sourceType: "chapter_runtime",
        sourceStage: input.sourceStage,
        metadataJson: JSON.stringify(input.metadata),
        updatedAt: new Date(),
      },
    }).catch(() => null);
  }

  async markSuperseded(input: Omit<TimelineCheckpointIdentity, "syncMode"> & {
    expectedContentRevision: number;
    sourceStage: string;
  }): Promise<void> {
    const metadataJson = JSON.stringify({
      reason: "projection_superseded",
      superseded: true,
      expectedContentRevision: input.expectedContentRevision,
      sourceStage: input.sourceStage,
    });
    const key = checkpointKey({ ...input, syncMode: "stable" });
    await prisma.chapterArtifactSyncCheckpoint.upsert({
      where: { novelId_chapterId_contentHash_artifactType_syncMode: key },
      create: {
        ...key,
        status: "failed",
        sourceType: "chapter_runtime",
        sourceStage: input.sourceStage,
        metadataJson,
      },
      update: {
        status: "failed",
        sourceType: "chapter_runtime",
        sourceStage: input.sourceStage,
        metadataJson,
        updatedAt: new Date(),
      },
    }).catch(() => null);
  }
}

function checkpointKey(input: TimelineCheckpointIdentity) {
  return {
    novelId: input.novelId,
    chapterId: input.chapterId,
    contentHash: input.contentHash,
    artifactType: "timeline_finalization",
    syncMode: input.syncMode,
  };
}
