import type {
  AudiobookTaskStatus,
  AudiobookWorkspaceNovelOverview,
  AudiobookWorkspaceOverviewLatestTask,
  AudiobookWorkspaceOverviewReadiness,
  AudiobookWorkspaceOverviewResult,
} from "@ai-novel/shared/types/audiobook";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { isMissingAudiobookTaskTableError } from "./audiobookErrors";
import { audiobookVoiceReadinessService } from "./AudiobookVoiceReadinessService";

const OVERVIEW_MAX_NOVELS = 50;

const TASK_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

type LatestTaskRow = {
  id: string;
  novelId: string;
  status: string;
  progress: number;
  resultJson: string | null;
  updatedAt: Date;
};

function asTaskStatus(raw: string): AudiobookTaskStatus {
  if (TASK_STATUSES.has(raw)) {
    return raw as AudiobookTaskStatus;
  }
  return "failed";
}

function parseM4bStatus(resultJson: string | null | undefined): string | null {
  if (!resultJson?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(resultJson) as { m4b?: { status?: string } };
    const status = parsed?.m4b?.status;
    if (status === "ready" || status === "skipped" || status === "failed") {
      return status;
    }
    return null;
  } catch {
    return null;
  }
}

function toOverviewReadiness(
  summary: ReturnType<typeof audiobookVoiceReadinessService.buildSummaryFromRows>,
): AudiobookWorkspaceOverviewReadiness {
  return {
    voiceOk: summary.voiceOk,
    voiceConfigured: summary.voiceConfigured,
    characterTotal: summary.characterTotal,
    previewReady: summary.previewReady,
    previewMissing: summary.previewMissing,
    previewStale: summary.previewStale,
    readyForWorkbench: summary.readyForWorkbench,
    narratorValid: summary.narrator.valid,
  };
}

/**
 * 每本小说仅取 updatedAt/id 最新 1 条任务（ROW_NUMBER）。
 * 禁止无界 findMany 全历史。
 */
async function loadLatestTasksByNovel(
  novelIds: string[],
): Promise<Map<string, AudiobookWorkspaceOverviewLatestTask>> {
  const latestTaskByNovel = new Map<string, AudiobookWorkspaceOverviewLatestTask>();
  if (novelIds.length === 0) {
    return latestTaskByNovel;
  }

  let taskRows: LatestTaskRow[] = [];
  try {
    taskRows = await prisma.$queryRaw<LatestTaskRow[]>(Prisma.sql`
      WITH ranked AS (
        SELECT
          id,
          "novelId",
          status,
          progress,
          "resultJson",
          "updatedAt",
          ROW_NUMBER() OVER (
            PARTITION BY "novelId"
            ORDER BY "updatedAt" DESC, id DESC
          ) AS rn
        FROM "AudiobookTask"
        WHERE "novelId" IN (${Prisma.join(novelIds)})
      )
      SELECT id, "novelId", status, progress, "resultJson", "updatedAt"
      FROM ranked
      WHERE rn = 1
    `);
  } catch (error) {
    if (!isMissingAudiobookTaskTableError(error)) {
      throw error;
    }
    return latestTaskByNovel;
  }

  for (const row of taskRows) {
    const updatedAt =
      row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : new Date(row.updatedAt).toISOString();
    latestTaskByNovel.set(row.novelId, {
      id: row.id,
      status: asTaskStatus(row.status),
      progress: Number(row.progress) || 0,
      // 不填 fullAudioReady：列表用 succeeded 弱提示（D 文档）
      m4bStatus: parseM4bStatus(row.resultJson),
      updatedAt,
    });
  }
  return latestTaskByNovel;
}

/**
 * 选书页 bulk 态势：一次 novels+characters 读库 + 每本 latest task（窗口函数）。
 * **禁止** per-id assess / 列表路径 probeRefAudio / 无界 tasks 全历史。
 */
export async function buildAudiobookWorkspaceOverview(
  novelIdsInput: string[],
): Promise<AudiobookWorkspaceOverviewResult> {
  const seen = new Set<string>();
  const orderedIds: string[] = [];
  for (const raw of novelIdsInput) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    orderedIds.push(id);
  }

  const truncated = orderedIds.length > OVERVIEW_MAX_NOVELS;
  const novelIds = truncated ? orderedIds.slice(0, OVERVIEW_MAX_NOVELS) : orderedIds;

  if (novelIds.length === 0) {
    return { items: [], truncated: truncated || undefined };
  }

  const novels = await prisma.novel.findMany({
    where: { id: { in: novelIds } },
    select: {
      id: true,
      audiobookNarratorVoice: true,
      audiobookNarratorStyle: true,
      characters: {
        select: {
          id: true,
          name: true,
          gender: true,
          castRole: true,
          ttsMode: true,
          ttsVoice: true,
          ttsStyle: true,
          ttsDesignPrompt: true,
          ttsRefAudioPath: true,
          ttsPreviewAudioPath: true,
          ttsPreviewSampleText: true,
          ttsPreviewFingerprint: true,
          ttsPreviewGeneratedAt: true,
        },
      },
    },
  });

  const novelById = new Map(novels.map((row) => [row.id, row]));
  const latestTaskByNovel = await loadLatestTasksByNovel(novelIds);

  const items: AudiobookWorkspaceNovelOverview[] = [];
  for (const novelId of novelIds) {
    const novel = novelById.get(novelId);
    if (!novel) {
      // 不可读 / 不存在：静默省略（防探测）
      continue;
    }

    let readiness: AudiobookWorkspaceOverviewReadiness | null = null;
    try {
      const summary = audiobookVoiceReadinessService.buildSummaryFromRows({
        novelId: novel.id,
        narratorVoice: novel.audiobookNarratorVoice,
        narratorStyle: novel.audiobookNarratorStyle,
        characters: novel.characters.map((character) => ({
          id: character.id,
          name: character.name,
          gender: character.gender,
          castRole: character.castRole,
          ttsMode: character.ttsMode,
          ttsVoice: character.ttsVoice,
          ttsStyle: character.ttsStyle,
          ttsDesignPrompt: character.ttsDesignPrompt,
          ttsRefAudioPath: character.ttsRefAudioPath,
          ttsPreviewAudioPath: character.ttsPreviewAudioPath,
          ttsPreviewSampleText: character.ttsPreviewSampleText,
          ttsPreviewFingerprint: character.ttsPreviewFingerprint,
          ttsPreviewGeneratedAt: character.ttsPreviewGeneratedAt?.toISOString() ?? null,
        })),
        skipRefAudioProbe: true,
      });
      readiness = toOverviewReadiness(summary);
    } catch {
      readiness = null;
    }

    items.push({
      novelId,
      readiness,
      latestTask: latestTaskByNovel.get(novelId) ?? null,
      activeReadinessJob: Boolean(audiobookVoiceReadinessService.getActiveJobId(novelId)),
    });
  }

  return {
    items,
    truncated: truncated || undefined,
  };
}

/** 单测钩：上限常量 */
export const AUDIOBOOK_WORKSPACE_OVERVIEW_MAX = OVERVIEW_MAX_NOVELS;
