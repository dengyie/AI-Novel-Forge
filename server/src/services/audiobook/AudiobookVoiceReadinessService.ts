import crypto from "node:crypto";
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
import {
  resolveVoiceReadinessJobTerminalStatus,
  resolveVoiceReadinessPreviewProgress,
  resolveVoiceReadinessProgressWeights,
} from "./voiceReadinessJobLogic";
import { probeVoiceRefAudioOk } from "./voiceRefPath";

const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_JOBS = 200;
/** 预订占位前缀：await 期间同步占用 activeByNovel，防止 TOCTOU 双 job */
const RESERVE_PREFIX = "reserve:";

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
  return probeVoiceRefAudioOk(pathValue);
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
    // 预订占位：prepare 的 await 窗口内视为已有活跃任务
    if (jobId.startsWith(RESERVE_PREFIX)) {
      return jobId.slice(RESERVE_PREFIX.length) || jobId;
    }
    const job = this.jobs.get(jobId);
    if (!job || (job.status !== "queued" && job.status !== "running")) {
      this.activeByNovel.delete(novelId);
      return null;
    }
    return jobId;
  }

  /**
   * 同步预订 novel 槽位（在任何 await 之前调用）。
   * 成功返回 reserved jobId；已有活跃任务返回 null。
   */
  private tryReserveNovel(novelId: string): string | null {
    const existing = this.getActiveJobId(novelId);
    if (existing) {
      return null;
    }
    const id = crypto.randomUUID();
    this.activeByNovel.set(novelId, `${RESERVE_PREFIX}${id}`);
    return id;
  }

  private releaseReservation(novelId: string, reservedId: string): void {
    const current = this.activeByNovel.get(novelId);
    if (current === `${RESERVE_PREFIX}${reservedId}`) {
      this.activeByNovel.delete(novelId);
    }
  }

  getJob(jobId: string): AudiobookVoiceReadinessJob | null {
    this.gcJobs();
    const job = this.jobs.get(jobId);
    if (job) {
      return this.publicJob(job);
    }
    // prepare 预订窗口：job 尚未写入 Map，但 id 已对外（409 activeJobId）；返回合成 queued 避免前端 404 丢跟踪
    for (const [novelId, active] of this.activeByNovel) {
      if (active === `${RESERVE_PREFIX}${jobId}`) {
        const createdAt = nowIso();
        return {
          id: jobId,
          novelId,
          status: "queued",
          progress: 0,
          currentCharacterId: null,
          currentCharacterName: null,
          currentLabel: "准备中",
          createdAt,
          updatedAt: createdAt,
          startedAt: null,
          finishedAt: null,
          cancelRequested: false,
          options: {
            fillMissingVoice: true,
            generatePreview: true,
            regenerateStale: true,
            planStrategy: "auto",
          },
          items: [],
          summary: null,
          lastError: null,
        };
      }
    }
    return null;
  }

  cancelJob(novelId: string, jobId: string): AudiobookVoiceReadinessJob {
    const job = this.jobs.get(jobId);
    if (job) {
      if (job.novelId !== novelId) {
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
    // 预订窗口内取消：释放槽位并返回合成 cancelled
    const reserved = this.activeByNovel.get(novelId);
    if (reserved === `${RESERVE_PREFIX}${jobId}`) {
      this.activeByNovel.delete(novelId);
      const createdAt = nowIso();
      return {
        id: jobId,
        novelId,
        status: "cancelled",
        progress: 100,
        currentCharacterId: null,
        currentCharacterName: null,
        currentLabel: "已取消",
        createdAt,
        updatedAt: createdAt,
        startedAt: null,
        finishedAt: createdAt,
        cancelRequested: true,
        options: {
          fillMissingVoice: true,
          generatePreview: true,
          regenerateStale: true,
          planStrategy: "auto",
        },
        items: [],
        summary: { appliedVoice: 0, generatedPreview: 0, skipped: 0, failed: 0 },
        lastError: null,
      };
    }
    throw new AppError("就绪任务不存在。", 404);
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
            ttsVoiceAssetId: true,
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
        ttsVoiceAssetId: character.ttsVoiceAssetId,
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
        | "ttsVoiceAssetId"
        | "ttsPreviewAudioPath"
        | "ttsPreviewSampleText"
        | "ttsPreviewFingerprint"
        | "ttsPreviewGeneratedAt"
      >
    >;
    /**
     * 列表态势：clone 有 path 时视为 ref 可用，**不**逐文件 probe。
     * 项目页 assess 保持默认 false（精确态）。
     */
    skipRefAudioProbe?: boolean;
  }): AudiobookVoiceReadinessSummary {
    const skipProbe = input.skipRefAudioProbe === true;
    const items = input.characters.map((character) => {
      const previewStatus = resolvePreviewStatusForRow(character);
      const mode = character.ttsMode?.trim() || "preset";
      let refAudioOk: boolean | null = null;
      if (mode === "clone") {
        const hasPath = Boolean(character.ttsRefAudioPath?.trim());
        if (skipProbe) {
          refAudioOk = hasPath ? true : null;
        } else if (hasPath) {
          refAudioOk = probeRefAudioOk(character.ttsRefAudioPath);
        }
      }
      return buildCharacterReadinessItem({
        characterId: character.id,
        characterName: character.name,
        castRole: character.castRole,
        gender: character.gender,
        ttsMode: character.ttsMode,
        ttsVoice: character.ttsVoice,
        ttsDesignPrompt: character.ttsDesignPrompt,
        ttsRefAudioPath: character.ttsRefAudioPath,
        ttsVoiceAssetId: character.ttsVoiceAssetId,
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

    // 同步预订：必须在任何 await 之前，关闭 TOCTOU 双 job 窗口
    const reservedId = this.tryReserveNovel(novelId);
    if (!reservedId) {
      const activeId = this.getActiveJobId(novelId);
      throw new AppError(
        "该小说已有进行中的音色就绪任务，请等待或取消后再试。",
        409,
        {
          code: "READINESS_JOB_ACTIVE" as const,
          activeJobId: activeId ?? "unknown",
        },
      );
    }

    try {
      // 校验小说存在
      const exists = await prisma.novel.findUnique({
        where: { id: novelId },
        select: { id: true },
      });
      if (!exists) {
        throw new AppError("小说不存在。", 404);
      }

      const characterIds = normalizeCharacterIds(input.characterIds);
      const rawCandidates = input.candidatesPerCharacter;
      const candidatesPerCharacter =
        rawCandidates == null || Number.isNaN(Number(rawCandidates))
          ? 3
          : Math.max(1, Math.min(5, Math.floor(Number(rawCandidates))));
      const options = {
        fillMissingVoice: input.fillMissingVoice !== false,
        generatePreview: input.generatePreview !== false,
        regenerateStale: input.regenerateStale !== false,
        planStrategy: (input.planStrategy ?? "auto") as AudiobookVoicePlanStrategy,
        characterIds,
        previewText: input.previewText?.trim() || undefined,
        candidatesPerCharacter,
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

      const id = reservedId;
      const createdAt = nowIso();
      // await 之后：若预订已被 cancel 释放（或被其它路径抢占），不再晋升
      const stillReserved = this.activeByNovel.get(novelId) === `${RESERVE_PREFIX}${reservedId}`;
      if (!stillReserved) {
        const cancelledJob: InternalJob = {
          id,
          novelId,
          status: "cancelled",
          progress: 100,
          currentCharacterId: null,
          currentCharacterName: null,
          currentLabel: "已取消",
          createdAt,
          updatedAt: createdAt,
          startedAt: null,
          finishedAt: createdAt,
          cancelRequested: true,
          options,
          items: items.map((item) => ({ ...item, status: "skipped" })),
          summary: { appliedVoice: 0, generatedPreview: 0, skipped: items.length, failed: 0 },
          lastError: null,
        };
        this.jobs.set(id, cancelledJob);
        return { job: this.publicJob(cancelledJob) };
      }

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

      // noop：两阶段都关 — 不占 active 槽
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
        this.releaseReservation(novelId, reservedId);
        return { job: this.publicJob(job) };
      }

      this.jobs.set(id, job);
      // 把预订升级为真实 job id（同 id，去掉 reserve: 前缀）
      this.activeByNovel.set(novelId, id);
      this.queue.push(id);
      void this.pump();
      return { job: this.publicJob(job) };
    } catch (error) {
      this.releaseReservation(novelId, reservedId);
      throw error;
    }
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

    const { weightVoice, weightPreview } = resolveVoiceReadinessProgressWeights({
      fillMissingVoice: job.options.fillMissingVoice,
      generatePreview: job.options.generatePreview,
    });

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
              {
                text: job.options.previewText,
                candidates: job.options.candidatesPerCharacter ?? 3,
                autoAdoptWinner: true,
              },
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

          job.progress = resolveVoiceReadinessPreviewProgress({
            weightVoice,
            weightPreview,
            completedCount: i + 1,
            total: targets.length,
          });
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

      job.status = resolveVoiceReadinessJobTerminalStatus({
        cancelRequested: job.cancelRequested,
        failed,
        appliedVoice,
        generatedPreview,
        attemptedVoiceApply,
        attemptedPreview,
      });
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
