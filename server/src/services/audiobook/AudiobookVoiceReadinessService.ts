import crypto from "node:crypto";
import fs from "node:fs";
import {
  type AudiobookVoicePlanApplyItem,
  type AudiobookVoicePlanStrategy,
  type AudiobookVoiceReadinessAssessInput,
  type AudiobookVoiceReadinessJob,
  type AudiobookVoiceReadinessJobItem,
  type AudiobookVoiceReadinessPrepareInput,
  type AudiobookVoiceReadinessPrepareResult,
  type AudiobookVoiceReadinessSummary,
  type AudiobookWorkspaceCharacter,
  type AudiobookWorkspaceBootstrapReadiness,
} from "@ai-novel/shared/types/audiobook";
import { prisma } from "../../db/prisma";
import { AppError } from "../../middleware/errorHandler";
import { audiobookVoiceAssetService } from "./AudiobookVoiceAssetService";
import {
  aggregateVoiceReadinessSummary,
  buildCharacterReadinessItem,
  toBootstrapReadiness,
} from "./characterVoiceReadiness";
import {
  buildCharacterVoicePreviewFingerprint,
  DEFAULT_CHARACTER_VOICE_PREVIEW_TEXT,
  resolveCharacterVoicePreviewStatus,
} from "./characterVoicePreview";

const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_JOBS = 200;

type InternalJob = AudiobookVoiceReadinessJob & {
  /** 仅进程内 */
  _attemptedVoiceApply?: boolean;
  _attemptedPreview?: boolean;
};

function nowIso(): string {
  return new Date().toISOString();
}

function sliceError(error: unknown, max = 200): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, max) || "未知错误";
}

function probeRefAudioOk(pathValue?: string | null): boolean | null {
  const refPath = pathValue?.trim() || "";
  if (!refPath) {
    return null;
  }
  if (refPath.includes("..") || refPath.includes("\0")) {
    return false;
  }
  try {
    if (!fs.existsSync(refPath)) {
      return false;
    }
    const stat = fs.statSync(refPath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function resolvePreviewStatusForRow(character: {
  ttsMode?: string | null;
  ttsVoice?: string | null;
  ttsStyle?: string | null;
  ttsDesignPrompt?: string | null;
  ttsRefAudioPath?: string | null;
  ttsPreviewAudioPath?: string | null;
  ttsPreviewSampleText?: string | null;
  ttsPreviewFingerprint?: string | null;
}) {
  const sampleForFingerprint =
    character.ttsPreviewSampleText?.trim() || DEFAULT_CHARACTER_VOICE_PREVIEW_TEXT;
  const currentFingerprint = buildCharacterVoicePreviewFingerprint(character, sampleForFingerprint);
  return resolveCharacterVoicePreviewStatus({
    audioPath: character.ttsPreviewAudioPath,
    fingerprint: character.ttsPreviewFingerprint,
    currentFingerprint,
  });
}

function normalizeCharacterIds(raw?: string[]): string[] | undefined {
  if (!raw?.length) {
    return undefined;
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of raw) {
    const trimmed = id?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= 200) {
      break;
    }
  }
  return out.length ? out : undefined;
}

export class AudiobookVoiceReadinessService {
  private readonly jobs = new Map<string, InternalJob>();

  private readonly activeByNovel = new Map<string, string>();

  private readonly queue: string[] = [];

  private processing = false;

  getActiveJobId(novelId: string): string | null {
    const jobId = this.activeByNovel.get(novelId);
    if (!jobId) {
      return null;
    }
    const job = this.jobs.get(jobId);
    if (!job || (job.status !== "queued" && job.status !== "running")) {
      this.activeByNovel.delete(novelId);
      return null;
    }
    return jobId;
  }

  getJob(jobId: string): AudiobookVoiceReadinessJob | null {
    this.gcJobs();
    const job = this.jobs.get(jobId);
    return job ? this.publicJob(job) : null;
  }

  cancelJob(novelId: string, jobId: string): AudiobookVoiceReadinessJob {
    const job = this.jobs.get(jobId);
    if (!job || job.novelId !== novelId) {
      throw new AppError("就绪任务不存在。", 404);
    }
    if (job.status === "queued" || job.status === "running") {
      job.cancelRequested = true;
      job.updatedAt = nowIso();
      if (job.status === "queued") {
        this.finalizeCancelledQueued(job);
      }
    }
    return this.publicJob(job);
  }

  async assess(
    novelId: string,
    input: AudiobookVoiceReadinessAssessInput = {},
  ): Promise<AudiobookVoiceReadinessSummary> {
    const novel = await prisma.novel.findUnique({
      where: { id: novelId },
      select: {
        id: true,
        audiobookNarratorVoice: true,
        audiobookNarratorStyle: true,
        characters: {
          orderBy: { createdAt: "asc" },
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
    if (!novel) {
      throw new AppError("小说不存在。", 404);
    }

    const filterIds = normalizeCharacterIds(input.characterIds);
    const filterSet = filterIds ? new Set(filterIds) : null;
    const characters = filterSet
      ? novel.characters.filter((item) => filterSet.has(item.id))
      : novel.characters;

    return this.buildSummaryFromRows({
      novelId: novel.id,
      narratorVoice: novel.audiobookNarratorVoice,
      narratorStyle: novel.audiobookNarratorStyle,
      characters: characters.map((character) => ({
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
    });
  }

  buildSummaryFromRows(input: {
    novelId: string;
    narratorVoice?: string | null;
    narratorStyle?: string | null;
    characters: Array<
      Pick<
        AudiobookWorkspaceCharacter,
        | "id"
        | "name"
        | "gender"
        | "castRole"
        | "ttsMode"
        | "ttsVoice"
        | "ttsStyle"
        | "ttsDesignPrompt"
        | "ttsRefAudioPath"
        | "ttsPreviewAudioPath"
        | "ttsPreviewSampleText"
        | "ttsPreviewFingerprint"
        | "ttsPreviewGeneratedAt"
      >
    >;
  }): AudiobookVoiceReadinessSummary {
    const items = input.characters.map((character) => {
      const previewStatus = resolvePreviewStatusForRow(character);
      const mode = character.ttsMode?.trim() || "preset";
      const refAudioOk = mode === "clone" && character.ttsRefAudioPath?.trim()
        ? probeRefAudioOk(character.ttsRefAudioPath)
        : null;
      return buildCharacterReadinessItem({
        characterId: character.id,
        characterName: character.name,
        castRole: character.castRole,
        gender: character.gender,
        ttsMode: character.ttsMode,
        ttsVoice: character.ttsVoice,
        ttsDesignPrompt: character.ttsDesignPrompt,
        ttsRefAudioPath: character.ttsRefAudioPath,
        refAudioOk,
        previewStatus,
        previewGeneratedAt: character.ttsPreviewGeneratedAt ?? null,
      });
    });

    return aggregateVoiceReadinessSummary({
      novelId: input.novelId,
      narratorVoice: input.narratorVoice,
      narratorStyle: input.narratorStyle,
      items,
    });
  }

  toBootstrapReadiness(
    summary: AudiobookVoiceReadinessSummary,
    activeReadinessJobId?: string | null,
  ): AudiobookWorkspaceBootstrapReadiness {
    return toBootstrapReadiness(summary, activeReadinessJobId);
  }

  async prepare(
    novelId: string,
    input: AudiobookVoiceReadinessPrepareInput = {},
  ): Promise<AudiobookVoiceReadinessPrepareResult> {
    this.gcJobs();

    const activeId = this.getActiveJobId(novelId);
    if (activeId) {
      throw new AppError(
        "该小说已有进行中的音色就绪任务，请等待或取消后再试。",
        409,
        {
          code: "READINESS_JOB_ACTIVE" as const,
          activeJobId: activeId,
        },
      );
    }

    // 校验小说存在
    const exists = await prisma.novel.findUnique({
      where: { id: novelId },
      select: { id: true },
    });
    if (!exists) {
      throw new AppError("小说不存在。", 404);
    }

    const characterIds = normalizeCharacterIds(input.characterIds);
    const options = {
      fillMissingVoice: input.fillMissingVoice !== false,
      generatePreview: input.generatePreview !== false,
      regenerateStale: input.regenerateStale !== false,
      planStrategy: (input.planStrategy ?? "auto") as AudiobookVoicePlanStrategy,
      characterIds,
      previewText: input.previewText?.trim() || undefined,
    };

    const snap = await this.assess(novelId, { characterIds });
    const items: AudiobookVoiceReadinessJobItem[] = snap.items.map((item) => ({
      characterId: item.characterId,
      characterName: item.characterName,
      status: "pending",
      phase: "idle",
      error: null,
      previewStatusAfter: null,
    }));

    const id = crypto.randomUUID();
    const createdAt = nowIso();
    const job: InternalJob = {
      id,
      novelId,
      status: "queued",
      progress: 0,
      currentCharacterId: null,
      currentCharacterName: null,
      currentLabel: "排队中",
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      finishedAt: null,
      cancelRequested: false,
      options,
      items,
      summary: null,
      lastError: null,
    };

    // noop：两阶段都关
    if (!options.fillMissingVoice && !options.generatePreview) {
      job.status = "succeeded";
      job.progress = 100;
      job.finishedAt = createdAt;
      job.currentLabel = "无需操作";
      job.summary = { appliedVoice: 0, generatedPreview: 0, skipped: 0, failed: 0 };
      for (const item of job.items) {
        item.status = "skipped";
      }
      this.jobs.set(id, job);
      return { job: this.publicJob(job) };
    }

    this.jobs.set(id, job);
    this.activeByNovel.set(novelId, id);
    this.queue.push(id);
    void this.pump();
    return { job: this.publicJob(job) };
  }

  private publicJob(job: InternalJob): AudiobookVoiceReadinessJob {
    const {
      _attemptedVoiceApply: _a,
      _attemptedPreview: _b,
      ...rest
    } = job;
    return {
      ...rest,
      items: job.items.map((item) => ({ ...item })),
      options: { ...job.options, characterIds: job.options.characterIds?.slice() },
      summary: job.summary ? { ...job.summary } : null,
    };
  }

  private finalizeCancelledQueued(job: InternalJob): void {
    job.status = "cancelled";
    job.progress = 100;
    job.finishedAt = nowIso();
    job.currentLabel = "已取消";
    for (const item of job.items) {
      if (item.status === "pending" || item.status === "running") {
        item.status = "skipped";
      }
    }
    job.summary = {
      appliedVoice: 0,
      generatedPreview: 0,
      skipped: job.items.filter((item) => item.status === "skipped").length,
      failed: 0,
    };
    if (this.activeByNovel.get(job.novelId) === job.id) {
      this.activeByNovel.delete(job.novelId);
    }
  }

  private async pump(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const jobId = this.queue.shift();
        if (!jobId) {
          break;
        }
        const job = this.jobs.get(jobId);
        if (!job || job.status !== "queued") {
          continue;
        }
        if (job.cancelRequested) {
          this.finalizeCancelledQueued(job);
          continue;
        }
        await this.runJob(job);
      }
    } finally {
      this.processing = false;
    }
  }

  private findItem(job: InternalJob, characterId: string): AudiobookVoiceReadinessJobItem | undefined {
    return job.items.find((item) => item.characterId === characterId);
  }

  private async runJob(job: InternalJob): Promise<void> {
    job.status = "running";
    job.startedAt = nowIso();
    job.updatedAt = job.startedAt;
    job.currentLabel = "开始就绪任务";

    let appliedVoice = 0;
    let generatedPreview = 0;
    let skipped = 0;
    let failed = 0;
    let attemptedVoiceApply = false;
    let attemptedPreview = false;

    const weightVoice = job.options.fillMissingVoice ? 15 : 0;
    const weightPreview = job.options.generatePreview
      ? (job.options.fillMissingVoice ? 85 : 100)
      : 0;

    try {
      if (job.options.fillMissingVoice && !job.cancelRequested) {
        job.currentLabel = "规划并写入缺失音色";
        job.updatedAt = nowIso();
        const suggest = await audiobookVoiceAssetService.suggest(job.novelId, {
          onlyMissing: true,
          strategy: job.options.planStrategy,
          characterIds: job.options.characterIds,
        });
        attemptedVoiceApply = suggest.items.length > 0;

        if (attemptedVoiceApply && !job.cancelRequested) {
          const applyItems: AudiobookVoicePlanApplyItem[] = suggest.items.map((item) => ({
            characterId: item.characterId,
            ttsMode: item.ttsMode,
            ttsVoice: item.ttsVoice,
            ttsStyle: item.ttsStyle,
            ttsDesignPrompt: item.ttsDesignPrompt,
            speakerAliases: item.speakerAliases,
          }));
          const result = await audiobookVoiceAssetService.apply(job.novelId, {
            items: applyItems,
            overwrite: false,
          });
          appliedVoice += result.applied.length;

          const willPreview = job.options.generatePreview;
          for (const applied of result.applied) {
            const item = this.findItem(job, applied.characterId);
            if (!item) {
              continue;
            }
            item.phase = "voice";
            item.status = willPreview ? "running" : "succeeded";
            item.error = null;
          }
          for (const skip of result.skipped) {
            const item = this.findItem(job, skip.characterId);
            if (!item) {
              continue;
            }
            if (item.status === "pending") {
              item.phase = "voice";
              item.status = "skipped";
              item.error = skip.reason;
            }
          }
        }

        job.progress = job.options.generatePreview ? weightVoice : 100;
        job.updatedAt = nowIso();
      }

      if (job.options.generatePreview && !job.cancelRequested) {
        const snap = await this.assess(job.novelId, {
          characterIds: job.options.characterIds,
        });
        const targets = snap.items.filter(
          (item) =>
            item.voiceBindingStatus === "configured"
            && (item.previewStatus === "missing"
              || (item.previewStatus === "stale" && job.options.regenerateStale)),
        );
        attemptedPreview = targets.length > 0;

        const targetIds = new Set(targets.map((item) => item.characterId));
        for (const snapItem of snap.items) {
          const item = this.findItem(job, snapItem.characterId);
          if (!item) {
            continue;
          }
          if (targetIds.has(snapItem.characterId)) {
            continue;
          }
          if (item.status === "pending") {
            if (snapItem.voiceBindingStatus !== "configured") {
              item.status = "skipped";
              item.phase = "preview";
              item.error = snapItem.action === "manual_clone"
                ? "clone 需人工上传参考音频"
                : (snapItem.reason || "音色未就绪，跳过试听生成");
              skipped += 1;
            } else if (snapItem.previewStatus === "ready") {
              item.status = "skipped";
              item.phase = "preview";
              item.previewStatusAfter = "ready";
              skipped += 1;
            } else if (snapItem.previewStatus === "stale" && !job.options.regenerateStale) {
              item.status = "skipped";
              item.phase = "preview";
              item.previewStatusAfter = "stale";
              item.error = "stale 未开启重新生成";
              skipped += 1;
            }
          } else if (
            item.status === "running"
            && item.phase === "voice"
            && snapItem.voiceBindingStatus === "configured"
            && snapItem.previewStatus === "ready"
          ) {
            // voice 已写完且 preview 已 ready：无需再 generate
            item.status = "succeeded";
            item.previewStatusAfter = "ready";
          }
        }

        for (let i = 0; i < targets.length; i += 1) {
          if (job.cancelRequested) {
            break;
          }
          const target = targets[i]!;
          const item = this.findItem(job, target.characterId);
          job.currentCharacterId = target.characterId;
          job.currentCharacterName = target.characterName;
          job.currentLabel = `生成试听：${target.characterName}`;
          job.updatedAt = nowIso();
          if (item) {
            item.phase = "preview";
            item.status = "running";
            item.error = null;
          }

          try {
            await audiobookVoiceAssetService.generateCharacterPreview(
              job.novelId,
              target.characterId,
              { text: job.options.previewText },
            );
            generatedPreview += 1;
            if (item) {
              item.status = "succeeded";
              item.previewStatusAfter = "ready";
              item.error = null;
            }
          } catch (error) {
            failed += 1;
            if (item) {
              item.status = "failed";
              item.error = sliceError(error);
            }
            job.lastError = sliceError(error);
          }

          job.progress = Math.min(
            100,
            weightVoice + Math.round(((i + 1) / Math.max(targets.length, 1)) * weightPreview),
          );
          job.updatedAt = nowIso();
        }
      }

      // cancel 间隙：剩余 pending → skipped
      if (job.cancelRequested) {
        for (const item of job.items) {
          if (item.status === "pending" || item.status === "running") {
            item.status = "skipped";
            skipped += 1;
          }
        }
      } else {
        for (const item of job.items) {
          if (item.status === "pending") {
            item.status = "skipped";
            skipped += 1;
          }
        }
      }

      // 终态计数以 item 最终状态为准（避免双重计数）
      const finalFailed = job.items.filter((item) => item.status === "failed").length;
      const finalSkipped = job.items.filter((item) => item.status === "skipped").length;
      failed = finalFailed;
      skipped = finalSkipped;

      job.summary = {
        appliedVoice,
        generatedPreview,
        skipped,
        failed,
      };

      if (job.cancelRequested) {
        job.status = "cancelled";
      } else if (
        failed > 0
        && appliedVoice === 0
        && generatedPreview === 0
        && (attemptedVoiceApply || attemptedPreview)
      ) {
        job.status = "failed";
      } else {
        job.status = "succeeded";
      }
    } catch (error) {
      job.status = "failed";
      job.lastError = sliceError(error);
      job.summary = {
        appliedVoice,
        generatedPreview,
        skipped,
        failed: failed + 1,
      };
      console.warn(
        `[audiobook-voice-readiness] job ${job.id} novel=${job.novelId} failed: ${job.lastError}`,
      );
    }

    job.progress = 100;
    job.finishedAt = nowIso();
    job.updatedAt = job.finishedAt;
    job.currentLabel = job.status === "cancelled"
      ? "已取消"
      : job.status === "failed"
        ? "就绪失败"
        : "就绪完成";
    job.currentCharacterId = null;
    job.currentCharacterName = null;

    if (this.activeByNovel.get(job.novelId) === job.id) {
      this.activeByNovel.delete(job.novelId);
    }

    console.info(
      `[audiobook-voice-readiness] job ${job.id} novel=${job.novelId} status=${job.status} appliedVoice=${job.summary?.appliedVoice ?? 0} generatedPreview=${job.summary?.generatedPreview ?? 0} failed=${job.summary?.failed ?? 0} skipped=${job.summary?.skipped ?? 0}`,
    );
  }

  private gcJobs(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.status === "queued" || job.status === "running") {
        continue;
      }
      const finished = job.finishedAt ? Date.parse(job.finishedAt) : Date.parse(job.updatedAt);
      if (Number.isFinite(finished) && now - finished > JOB_TTL_MS) {
        this.jobs.delete(id);
      }
    }
    if (this.jobs.size <= MAX_JOBS) {
      return;
    }
    const finished = [...this.jobs.entries()]
      .filter(([, job]) => job.status !== "queued" && job.status !== "running")
      .sort((a, b) => Date.parse(a[1].updatedAt) - Date.parse(b[1].updatedAt));
    while (this.jobs.size > MAX_JOBS && finished.length > 0) {
      const [id] = finished.shift()!;
      this.jobs.delete(id);
    }
  }
}

export const audiobookVoiceReadinessService = new AudiobookVoiceReadinessService();
