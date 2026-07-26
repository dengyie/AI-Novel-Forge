/**
 * Pipeline 章批执行主路径（P2-1 从 NovelCorePipelineService 拆出）。
 * 行为与拆分前 executePipeline 一致：只搬迁，不改契约。
 * 通过 host 注入 updateJobSafe / schedule / runtime / abort map，避免循环依赖。
 */
import { prisma } from "../../../../db/prisma";
import { novelEventBus } from "../../../../events";
import { runWithLlmUsageTracking } from "../../../../llm/usageTracking";
import {
  logPipelineInfo,
  logPipelineWarn,
  type PipelinePayload,
  type PipelineRunOptions,
} from "../../novelCoreShared";
import {
  buildGenreBeatBoardSnapshot,
  buildVolumeReplanQualityDebtGate,
  formatGenreBeatShortfallPauseReason,
  GENRE_BEAT_BOARD_WINDOW_SIZE,
  shouldPauseForGenreBeatShortfall,
  type GenreBeatChapterLabelSource,
} from "../../quality/qualityDebtBoard";
import { ChapterPlanJITService } from "../../planning/ChapterPlanJITService";
import { normalizeJobTransportAutoRetryCount } from "../../pipelineJobAutoRetry";
import {
  buildPipelineJobLeaseOwnedCasWhere,
  buildPipelineJobSuccessTerminalCasWhere,
  classifyNonTerminalCasMiss,
  PIPELINE_LEASE_LOST_MESSAGE,
} from "../../pipelineJobTerminalGuard";
import { buildPipelineStageProgress } from "../../pipelineJobState";
import {
  PIPELINE_LEASE_TTL_MS,
  buildSkipCompletedChapterWhere,
  clampPipelineMaxRetries,
} from "../../pipelineExecutionHelpers";
import { NovelVolumeService } from "../../volume/NovelVolumeService";
import {
  executePipelineChapter,
  type PipelineExecuteHost,
} from "./PipelineChapterExecution";
import { projectPipelineChapterQuality } from "../quality/PipelineChapterQualityPolicy";
import { applyPipelineReplanPolicy } from "../quality/PipelineReplanPolicy";
import { recoverPipelineJob } from "../recovery/PipelineJobRecoveryPolicy";

export type { PipelineExecuteHost } from "./PipelineChapterExecution";

export async function executePipelineJob(
  host: PipelineExecuteHost,
  jobId: string,
  novelId: string,
  options: PipelineRunOptions,
): Promise<void> {
  const maxRetries = clampPipelineMaxRetries(options.maxRetries);
  const qualityThreshold = options.qualityThreshold ?? 75;
  const existingJob = await prisma.generationJob.findUnique({
    where: { id: jobId },
    select: {
      startedAt: true,
      completedCount: true,
      totalCount: true,
      retryCount: true,
      payload: true,
    },
  });
  const persistedPayload = host.parsePipelinePayload(existingJob?.payload);
  const runtimePayload: PipelinePayload = {
    provider: persistedPayload.provider ?? options.provider,
    model: persistedPayload.model ?? options.model,
    temperature: persistedPayload.temperature ?? options.temperature ?? 0.8,
    controlPolicy: persistedPayload.controlPolicy ?? options.controlPolicy,
    workflowTaskId: persistedPayload.workflowTaskId ?? options.workflowTaskId,
    taskStyleProfileId: persistedPayload.taskStyleProfileId ?? options.taskStyleProfileId,
    maxRetries: clampPipelineMaxRetries(persistedPayload.maxRetries ?? options.maxRetries),
    runMode: persistedPayload.runMode ?? options.runMode ?? "fast",
    autoReview: persistedPayload.autoReview ?? options.autoReview ?? true,
    autoRepair: persistedPayload.autoRepair ?? options.autoRepair ?? true,
    skipCompleted: persistedPayload.skipCompleted ?? options.skipCompleted ?? true,
    qualityThreshold: persistedPayload.qualityThreshold ?? options.qualityThreshold,
    repairMode: persistedPayload.repairMode ?? options.repairMode ?? "light_repair",
    artifactSyncMode: persistedPayload.artifactSyncMode ?? options.artifactSyncMode ?? "adaptive",
    settingQualityMode: persistedPayload.settingQualityMode ?? options.settingQualityMode ?? "off",
    jobTransportAutoRetryCount: normalizeJobTransportAutoRetryCount(
      persistedPayload.jobTransportAutoRetryCount,
    ),
  };
  const directorTelemetryTask = runtimePayload.workflowTaskId
    ? await prisma.novelWorkflowTask.findUnique({
      where: { id: runtimePayload.workflowTaskId },
      select: {
        lane: true,
        directorRun: {
          select: { id: true },
        },
      },
    }).catch(() => null)
    : null;
  const shouldRecordDirectorTelemetry = directorTelemetryTask?.lane === "auto_director";
  let totalRetryCount = Math.max(existingJob?.retryCount ?? 0, 0);
  const qualityAlertDetails = [...(persistedPayload.qualityAlertDetails ?? [])];
  const replanAlertDetails = [...(persistedPayload.replanAlertDetails ?? [])];
  const genreBeatAlertDetails = [...(persistedPayload.genreBeatAlertDetails ?? [])];
  const recoverableRepairDetails = [...(persistedPayload.recoverableRepairDetails ?? [])];

  try {
    await runWithLlmUsageTracking({
      generationJobId: jobId,
      workflowTaskId: runtimePayload.workflowTaskId,
      directorTelemetry: shouldRecordDirectorTelemetry,
      novelId: shouldRecordDirectorTelemetry ? novelId : null,
      directorRunId: shouldRecordDirectorTelemetry
        ? directorTelemetryTask?.directorRun?.id ?? runtimePayload.workflowTaskId ?? null
        : null,
    }, async () => {
      await host.updateJobSafe(jobId, {
        status: "running",
        error: null,
        pendingManualRecovery: false,
        startedAt: existingJob?.startedAt ?? new Date(),
        heartbeatAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + PIPELINE_LEASE_TTL_MS),
        currentStage: "generating_chapters",
        // running 行永不带 finishedAt：即便先前竞态分支误写过 finishedAt，此处显式清零，
        // 保住 watchdog/startup-resume 的 finishedAt:null 可恢复谓词，杜绝 crash 后僵尸不可见。
        finishedAt: null,
      });
      logPipelineInfo("任务开始执行", {
        jobId,
        novelId,
        range: `${options.startOrder}-${options.endOrder}`,
        maxRetries,
      });

      const [novel, chapters] = await Promise.all([
        prisma.novel.findUnique({ where: { id: novelId } }),
        prisma.chapter.findMany({
          where: {
            novelId,
            order: { gte: options.startOrder, lte: options.endOrder },
            ...(options.skipCompleted
              ? buildSkipCompletedChapterWhere()
              : {}),
          },
          orderBy: { order: "asc" },
        }),
      ]);
      if (!novel) {
        throw new Error("任务执行失败：小说或章节不存在");
      }
      if (chapters.length === 0) {
        // 任务创建后异步执行期间，区间内章节可能已被审稿/质量循环标记为完成或 defer_and_continue，
        // 被 skipCompleted 过滤为空。这不是硬故障——抛与创建路径一致的 sentinel，让导演自动执行
        // 的 isNoChaptersToGenerateError 兜底识别并推进 range，而非把任务卡在 failed。
        const stats = await prisma.chapter.aggregate({
          where: { novelId },
          _min: { order: true },
          _max: { order: true },
        });
        const minOrder = stats._min.order ?? 1;
        const maxOrder = stats._max.order ?? 1;
        throw new Error(`指定区间内没有可生成的章节。当前可用章节范围为第 ${minOrder} 章到第 ${maxOrder} 章。`);
      }

      logPipelineInfo("任务加载完成", {
        jobId,
        novelId,
        title: novel.title,
        chapterCount: chapters.length,
      });

      const totalCount = Math.max(existingJob?.totalCount ?? 0, chapters.length, 1);
      const storedCompleted = Math.min(Math.max(existingJob?.completedCount ?? 0, 0), totalCount);
      const filteredCompletedCount = runtimePayload.skipCompleted
        ? Math.max(0, totalCount - chapters.length)
        : 0;
      const remainingStartIndex = Math.min(
        Math.max(0, storedCompleted - filteredCompletedCount),
        chapters.length,
      );
      let completed = storedCompleted;
      const chaptersToProcess = chapters.slice(remainingStartIndex);

      // job 运行范围 replan 质量债：启动时 seed 一次，章内只更新内存，避免每章扫库。
      // 覆盖整段 options.startOrder–endOrder（含 skipCompleted 过滤掉的历史章）。
      const rangeDebtRows = await prisma.chapter.findMany({
        where: {
          novelId,
          order: { gte: options.startOrder, lte: options.endOrder },
        },
        select: { id: true, order: true, riskFlags: true },
        orderBy: { order: "asc" },
      });
      const rangeDebtByChapterId = new Map(
        rangeDebtRows.map((row) => [row.id, { order: row.order, riskFlags: row.riskFlags }]),
      );
      const evaluateRangeReplanGate = () =>
        buildVolumeReplanQualityDebtGate({
          chapters: Array.from(rangeDebtByChapterId.values()),
          startOrder: options.startOrder,
          endOrder: options.endOrder,
        });

      // 品类主配额（前 N 章满窗 shortfall）熔断：启动 seed；窗内章完成后从 DB 重读 title/taskSheet/summary。
      // 未满窗只观测不熔断；sceneDiversity.recommendForce 永不触发本门。
      // 原因写入 genreBeatAlertDetails（≠ replanAlertDetails），notice=PIPELINE_GENRE_BEAT_SHORTFALL。
      const genreBeatWindowSize = GENRE_BEAT_BOARD_WINDOW_SIZE;
      const genreBeatFraming = {
        sellingPoint: novel.bookSellingPoint ?? null,
        competingFeel: novel.competingFeel ?? null,
        first30ChapterPromise: novel.first30ChapterPromise ?? null,
      };
      const genreBeatLabelSelect = {
        id: true,
        order: true,
        title: true,
        taskSheet: true,
        chapterSummary: { select: { summary: true } },
      } as const;
      const mapGenreBeatLabelRow = (row: {
        id: string;
        order: number;
        title: string | null;
        taskSheet: string | null;
        chapterSummary: { summary: string | null } | null;
      }): GenreBeatChapterLabelSource & { id: string } => ({
        id: row.id,
        order: row.order,
        title: row.title,
        taskSheet: row.taskSheet,
        summary: row.chapterSummary?.summary ?? null,
      });
      const genreBeatSeedRows = await prisma.chapter.findMany({
        where: {
          novelId,
          order: { lte: genreBeatWindowSize },
        },
        orderBy: { order: "asc" },
        take: genreBeatWindowSize,
        select: genreBeatLabelSelect,
      });
      const genreBeatByChapterId = new Map<string, GenreBeatChapterLabelSource & { id: string }>(
        genreBeatSeedRows.map((row) => [row.id, mapGenreBeatLabelRow(row)]),
      );
      const evaluateGenreBeatGate = () => {
        const snapshot = buildGenreBeatBoardSnapshot({
          framing: genreBeatFraming,
          chapters: Array.from(genreBeatByChapterId.values()),
          windowSize: genreBeatWindowSize,
        });
        return {
          snapshot,
          shouldPause: shouldPauseForGenreBeatShortfall(snapshot),
        };
      };
      const refreshGenreBeatLabelFromDb = async (chapterId: string, chapterOrder: number) => {
        if (chapterOrder > genreBeatWindowSize) {
          return;
        }
        const row = await prisma.chapter.findUnique({
          where: { id: chapterId },
          select: genreBeatLabelSelect,
        });
        if (!row) {
          return;
        }
        genreBeatByChapterId.set(row.id, mapGenreBeatLabelRow(row));
      };
      const recordGenreBeatPause = (snapshot: ReturnType<typeof buildGenreBeatBoardSnapshot>, lastChapterOrder?: number | null) => {
        const detail = formatGenreBeatShortfallPauseReason(snapshot, {
          lastChapterOrder: lastChapterOrder ?? null,
        });
        if (!genreBeatAlertDetails.includes(detail)) {
          genreBeatAlertDetails.push(detail);
        }
        logPipelineWarn("品类主配额满窗 shortfall 熔断，停止后续章节流水线", {
          jobId,
          order: lastChapterOrder ?? null,
          windowSize: snapshot.coverage.windowSize,
          labeledChapterCount: snapshot.coverage.labeledChapterCount,
          meetsPrimaryQuota: snapshot.coverage.meetsPrimaryQuota,
          shortfalls: snapshot.coverage.shortfalls,
        });
      };

      // Phase 3：JIT 预取服务（N+1 章执行预取）
      const prefetchVolumeService = new NovelVolumeService();
      const prefetchJITService = new ChapterPlanJITService({
        ensureChapterExecutionContract: (nId, cId, opts) =>
          prefetchVolumeService.ensureChapterExecutionContract(nId, cId, opts),
      });
      const isAutopilotMode = runtimePayload.controlPolicy?.advanceMode === "full_book_autopilot";
      // B3：卷工作区一次加载，供设定对齐注入 functionIds/功能表。
      // enforce 下加载失败 → fail-closed（unavailable assessment），禁止当「无债」放行。
      let settingAlignmentVolumeDocument: Awaited<ReturnType<NovelVolumeService["getVolumes"]>> | null = null;
      let settingAlignmentWorkspaceUnavailableReason: string | null = null;
      const settingQualityMode = runtimePayload.settingQualityMode ?? "off";
      if (settingQualityMode === "advisory" || settingQualityMode === "enforce") {
        try {
          settingAlignmentVolumeDocument = await prefetchVolumeService.getVolumes(novelId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          settingAlignmentWorkspaceUnavailableReason = `卷工作区加载失败，设定对齐上下文不可用：${message}`;
          logPipelineWarn(settingAlignmentWorkspaceUnavailableReason, {
            jobId,
            novelId,
            settingQualityMode,
            failClosed: settingQualityMode === "enforce",
            error: message,
          });
          settingAlignmentVolumeDocument = null;
        }
      }

      // 进环前：窗已 complete 且 primary shortfall 时直接停，避免 startOrder>window 时再白写一章。
      {
        const genreGateBeforeLoop = evaluateGenreBeatGate();
        if (genreGateBeforeLoop.shouldPause) {
          recordGenreBeatPause(genreGateBeforeLoop.snapshot, null);
          const finalStatus: "succeeded" = "succeeded";
          // CAS：仅 running 且本进程持租约且未请求 cancel 才允许写 succeeded；
          // count=0 说明并发 cancel 已入库、被推离 running 或本进程已丢租约（另一进程接管）。
          // 后两者按已丢租约处理：外层 CAS 复检若 DB 带 cancelRequestedAt → 抛 PIPELINE_CANCELLED
          // 走 cancelled 收口；否则抛 PIPELINE_LEASE_LOST 静默早退。
          const genreBeatCasWhere = buildPipelineJobSuccessTerminalCasWhere(jobId, host.leaseOwner);
          const casResult = await prisma.generationJob.updateMany({
            where: genreBeatCasWhere,
            data: {
              status: finalStatus,
              error: null,
              heartbeatAt: null,
              currentStage: null,
              currentItemKey: null,
              currentItemLabel: null,
              cancelRequestedAt: null,
              finishedAt: new Date(),
              payload: host.stringifyPipelinePayload({
                ...runtimePayload,
                qualityAlertDetails,
                replanAlertDetails,
                genreBeatAlertDetails,
                recoverableRepairDetails,
                // 终态清零：避免成功/熔断暂停后 UI 仍显示瞬时重试预算
                jobTransportAutoRetryCount: 0,
              }),
            },
          });
          if (casResult.count === 0) {
            // 区分 cancel vs lease-lost：带 cancelRequestedAt → cancelled 收口；否则 lease-lost。
            const latest = await prisma.generationJob.findUnique({
              where: { id: jobId },
              select: { status: true, cancelRequestedAt: true },
            });
            if (latest?.cancelRequestedAt || latest?.status === "cancelled") {
              throw new Error("PIPELINE_CANCELLED");
            }
            throw new Error(PIPELINE_LEASE_LOST_MESSAGE);
          }
          logPipelineInfo("任务执行结束", {
            jobId,
            status: finalStatus,
            qualityAlertCount: qualityAlertDetails.length,
            genreBeatAlertCount: genreBeatAlertDetails.length,
            stopReason: "genre_beat_shortfall_before_loop",
          });
          void novelEventBus.emit({
            type: "pipeline:completed",
            payload: { novelId, jobId, status: finalStatus },
          }).catch(() => {});
          return;
        }
      }
      for (let chapterIndex = 0; chapterIndex < chaptersToProcess.length; chapterIndex++) {
        const chapter = chaptersToProcess[chapterIndex];
        const chapterResult = await executePipelineChapter({
          host,
          jobId,
          novelId,
          chapter,
          completedCount: completed,
          totalCount,
          maxRetries,
          qualityThreshold,
          runtimePayload,
          qualityAlertDetails,
          recoverableRepairDetails,
        });
        totalRetryCount += chapterResult.retryCountUsed;
        const qualityProjection = await projectPipelineChapterQuality({
          jobId,
          novelId,
          chapter,
          chapterResult,
          runtimePayload,
          settingQualityMode,
          settingAlignmentVolumeDocument,
          settingAlignmentWorkspaceUnavailableReason,
          volumeService: prefetchVolumeService,
          rangeDebtByChapterId,
          startOrder: options.startOrder,
          endOrder: options.endOrder,
        });
        const final = qualityProjection.final;
        settingAlignmentVolumeDocument = qualityProjection.settingAlignmentVolumeDocument;

        if (chapterResult.reviewExecuted && !chapterResult.pass) {
          qualityAlertDetails.push(
            `第${chapter.order}章（coherence=${final.score.coherence}, repetition=${final.score.repetition}, engagement=${final.score.engagement}）`,
          );
          logPipelineWarn("章节最终未达标", {
            jobId,
            order: chapter.order,
            score: final.score,
          });
        }

        let shouldStopAfterCurrentChapter = applyPipelineReplanPolicy({
          jobId,
          chapterOrder: chapter.order,
          recommendation: chapterResult.runtimePackage?.replanRecommendation,
          rangeGate: evaluateRangeReplanGate(),
          qualityAlertDetails,
          replanAlertDetails,
        });

        // 品类主配额满窗 shortfall 熔断（与 replan gate / diversity soft-force 解耦）。
        // 原因进 genreBeatAlertDetails，不进 replanAlertDetails。
        if (!shouldStopAfterCurrentChapter) {
          const genreGate = evaluateGenreBeatGate();
          if (genreGate.shouldPause) {
            recordGenreBeatPause(genreGate.snapshot, chapter.order);
            shouldStopAfterCurrentChapter = true;
          }
        }

        // Phase 3：N+1 章 JIT 预取
        // 当前章 finalize 完成后（factLedger 已写入），后台触发下一章的 task sheet 生成。
        // fire-and-forget：预取失败不影响当前流水线，下一章正式组装时会重试。
        const nextChapter = chaptersToProcess[chapterIndex + 1];
        if (nextChapter && isAutopilotMode) {
          void prefetchJITService.ensureExecutionReady(novelId, nextChapter.id).catch((error) => {
            logPipelineInfo("N+1 JIT 预取失败（非阻断，下一章将在组装时重试）", {
              jobId,
              nextChapterId: nextChapter.id,
              nextChapterOrder: nextChapter.order,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }

        completed += 1;
        // owner-CAS：per-chapter 进度写只允许持租进程回写。旧进程残留若仍在章循环里，
        // 到这里 count=0 → 立即抛 lease-lost，避免旧进程写脏 completedCount / payload。
        const progressCasResult = await prisma.generationJob.updateMany({
          where: buildPipelineJobLeaseOwnedCasWhere(jobId, host.leaseOwner),
          data: {
            completedCount: completed,
            progress: Number((completed / totalCount).toFixed(4)),
            retryCount: totalRetryCount,
            heartbeatAt: new Date(),
            payload: host.stringifyPipelinePayload({
              ...runtimePayload,
              qualityAlertDetails,
              replanAlertDetails,
              genreBeatAlertDetails,
              recoverableRepairDetails,
            }),
          },
        });
        if (progressCasResult.count === 0) {
          // lease enabled → lease-lost；lease disabled → 并发已离开 running，cancel 收口补终态。
          const progressMiss = classifyNonTerminalCasMiss(host.leaseOwner);
          throw new Error(progressMiss.sentinel === "lease-lost" ? PIPELINE_LEASE_LOST_MESSAGE : "PIPELINE_CANCELLED");
        }
        logPipelineInfo("任务进度更新", {
          jobId,
          completed,
          total: totalCount,
          progress: Number((completed / totalCount).toFixed(4)),
          retryCount: totalRetryCount,
        });
        if (shouldStopAfterCurrentChapter) {
          logPipelineWarn("章节触发熔断，已停止后续章节流水线", {
            jobId,
            order: chapter.order,
            remaining: Math.max(0, totalCount - completed),
            replanAlertCount: replanAlertDetails.length,
            genreBeatAlertCount: genreBeatAlertDetails.length,
          });
          break;
        }
      }

      // 循环退出后终写前复检 cancel：心跳轮询把 chapterAbort abort 掉，最后一章 finally 仍
      // 可能走完落库，若不复检就会盖 succeeded 吞掉取消请求。命中则抛 PIPELINE_CANCELLED
      // 交外层 cancel 收口分支。
      await host.ensurePipelineNotCancelled(jobId);

      const finalStatus: "succeeded" = "succeeded";
      // finalizing 心跳：CAS 附带 leaseOwner，count=0 → 本进程已丢租约，抛 lease-lost 早退。
      const finalizingHeartbeat = await prisma.generationJob.updateMany({
        where: buildPipelineJobLeaseOwnedCasWhere(jobId, host.leaseOwner),
        data: {
          heartbeatAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + PIPELINE_LEASE_TTL_MS),
          currentStage: "finalizing",
          currentItemKey: null,
          currentItemLabel: "正在收尾章节流水线任务",
          progress: buildPipelineStageProgress({
            completedCount: completed,
            totalCount,
            stage: "finalizing",
          }),
        },
      });
      if (finalizingHeartbeat.count === 0) {
        // lease enabled → lease-lost；lease disabled → 并发已离开 running，cancel 收口补终态。
        const finalizingMiss = classifyNonTerminalCasMiss(host.leaseOwner);
        throw new Error(finalizingMiss.sentinel === "lease-lost" ? PIPELINE_LEASE_LOST_MESSAGE : "PIPELINE_CANCELLED");
      }
      // CAS：仅 running 且未请求 cancel 才写 succeeded；count=0 → cancel 已入库、已推离 running
      // 或本进程已丢租约（另一进程接管）。与 ensurePipelineNotCancelled 复检互补：前者截断已
      // 入库的 cancel，CAS 兜底 finalizing→终写期间的窄窗竞态与 lease 转手。count=0 时若 DB
      // 已带 cancelRequestedAt → cancelled 分支；否则视为 lease-lost，静默早退不写终态。
      const finalCasResult = await prisma.generationJob.updateMany({
        where: buildPipelineJobSuccessTerminalCasWhere(jobId, host.leaseOwner),
        data: {
          status: finalStatus,
          error: null,
          heartbeatAt: null,
          currentStage: null,
          currentItemKey: null,
          currentItemLabel: null,
          cancelRequestedAt: null,
          finishedAt: new Date(),
          payload: host.stringifyPipelinePayload({
            ...runtimePayload,
            qualityAlertDetails,
            replanAlertDetails,
            genreBeatAlertDetails,
            recoverableRepairDetails,
            // 终态清零：避免成功后 payload 残留自动重试计数
            jobTransportAutoRetryCount: 0,
          }),
        },
      });
      if (finalCasResult.count === 0) {
        // 区分 cancel vs lease-lost / 已终态（同 genre-beat 路径 396-405 的口径）：
        //   - cancelRequestedAt 已设 / status 已 cancelled → cancel 收口（throw PIPELINE_CANCELLED）
        //   - lease enabled 且未终态 → 另一进程接管租约 → lease-lost 静默早退（不盖新 owner）
        //   - lease disabled 且未 cancel：成功 CAS 未命中只可能是并发已离开 running（auto-requeue
        //     排回 queued / 兜底已终态化 / 或并发 cancel 的极窄读窗）。此时另一端已处置本 job，
        //     抛 lease-lost 静默早退（裸 update 会盖掉对方写好的终态），不再追加 cancelled。
        // 不能无条件抛 PIPELINE_CANCELLED：否则会用裸 update（无 status 守卫）写 cancelled，
        // 覆盖对方正在跑或已写好的终态，造成"盖新 owner 进度"的僵尸窗口。
        const finalLatest = await prisma.generationJob.findUnique({
          where: { id: jobId },
          select: { status: true, cancelRequestedAt: true },
        });
        if (finalLatest?.cancelRequestedAt || finalLatest?.status === "cancelled") {
          throw new Error("PIPELINE_CANCELLED");
        }
        throw new Error(PIPELINE_LEASE_LOST_MESSAGE);
      }
      logPipelineInfo("任务执行结束", {
        jobId,
        status: finalStatus,
        qualityAlertCount: qualityAlertDetails.length,
        genreBeatAlertCount: genreBeatAlertDetails.length,
      });
      void novelEventBus.emit({
        type: "pipeline:completed",
        payload: { novelId, jobId, status: finalStatus },
      }).catch(() => {});
    });
  } catch (error) {
    await recoverPipelineJob({
      error,
      host,
      jobId,
      novelId,
      options,
      runtimePayload,
      totalRetryCount,
      qualityAlertDetails,
      replanAlertDetails,
      genreBeatAlertDetails,
      recoverableRepairDetails,
    });
  }
}
