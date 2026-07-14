/**
 * Pipeline 章批执行主路径（P2-1 从 NovelCorePipelineService 拆出）。
 * 行为与拆分前 executePipeline 一致：只搬迁，不改契约。
 * 通过 host 注入 updateJobSafe / schedule / runtime / abort map，避免循环依赖。
 */
import type { ReviewIssue } from "@ai-novel/shared/types/novel";
import {
  buildChapterQualityLoopAssessment,
  type ChapterQualityLoopAssessment,
} from "@ai-novel/shared/types/chapterQualityLoop";
import { prisma } from "../../db/prisma";
import { novelEventBus } from "../../events";
import { ChapterPlanJITService } from "./planning/ChapterPlanJITService";
import { NovelVolumeService } from "./volume/NovelVolumeService";
import { runWithLlmUsageTracking } from "../../llm/usageTracking";
import type { ChapterRuntimeCoordinator } from "./runtime/ChapterRuntimeCoordinator";
import { isChapterEmptyContentError } from "./runtime/chapterEmptyContentError";
import {
  logPipelineError,
  logPipelineInfo,
  logPipelineWarn,
  normalizeScore,
  type PipelinePayload,
  type PipelineRunOptions,
} from "./novelCoreShared";
import { createQualityReport } from "./novelCoreReviewService";
import { chapterQualityLoopService } from "./quality/ChapterQualityLoopService";
import { assessSettingAlignmentForQualityLoop } from "./quality/settingAlignmentPipelineHook";
import {
  buildGenreBeatBoardSnapshot,
  buildVolumeReplanQualityDebtGate,
  formatGenreBeatShortfallPauseReason,
  GENRE_BEAT_BOARD_WINDOW_SIZE,
  isBlockingReplanQualityDebt,
  noteQualityLoopPersistFailOpen,
  shouldPauseForGenreBeatShortfall,
  type GenreBeatChapterLabelSource,
} from "./quality/qualityDebtBoard";
import {
  formatPipelineJobAutoRetryMessage,
  isPipelineCancellationError,
  normalizeJobTransportAutoRetryCount,
  PIPELINE_JOB_AUTO_RETRY_RECOVERY_IN_PROCESS_TIMER,
  PIPELINE_JOB_TRANSPORT_AUTO_RETRY_DELAY_MS,
  PIPELINE_JOB_TRANSPORT_AUTO_RETRY_MAX,
  shouldAutoRetryPipelineJob,
} from "./pipelineJobAutoRetry";
import { buildPipelineJobAutoRequeueCasWhere } from "./pipelineJobTerminalGuard";
import {
  buildPipelineCurrentItemLabel,
  buildPipelineStageProgress,
  type PipelineActiveStage,
} from "./pipelineJobState";
import {
  PIPELINE_HEARTBEAT_INTERVAL_MS,
  PIPELINE_LEASE_TTL_MS,
  buildEmptyChapterDetail,
  buildQualityLoopRiskFlagsSnapshot,
  buildSkipCompletedChapterWhere,
  clampPipelineMaxRetries,
} from "./pipelineExecutionHelpers";

/** executePipeline 对服务实例的最小依赖（便于单测 mock / 避免上帝文件）。 */
export interface PipelineExecuteHost {
  parsePipelinePayload(payload: string | null | undefined): PipelinePayload;
  stringifyPipelinePayload(input: PipelinePayload): string | null;
  updateJobSafe(jobId: string, data: Record<string, unknown>): Promise<void>;
  ensurePipelineNotCancelled(jobId: string): Promise<void>;
  schedulePipelineExecution(jobId: string, novelId: string, options: PipelineRunOptions): void;
  chapterRuntimeCoordinator: ChapterRuntimeCoordinator;
  activeChapterAborts: Map<string, AbortController>;
}

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

      // 进环前：窗已 complete 且 primary shortfall 时直接停，避免 startOrder>window 时再白写一章。
      {
        const genreGateBeforeLoop = evaluateGenreBeatGate();
        if (genreGateBeforeLoop.shouldPause) {
          recordGenreBeatPause(genreGateBeforeLoop.snapshot, null);
          const finalStatus: "succeeded" = "succeeded";
          await host.updateJobSafe(jobId, {
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
          });
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
        await host.ensurePipelineNotCancelled(jobId);

        let final = { score: normalizeScore({}), issues: [] as ReviewIssue[] };
        let shouldStopAfterCurrentChapter = false;
        const currentItemLabel = buildPipelineCurrentItemLabel({
          completedCount: completed,
          totalCount,
          chapterOrder: chapter.order,
          title: chapter.title,
        });
        let activeStage: PipelineActiveStage = "generating_chapters";
        const applyChapterStage = async (stage: PipelineActiveStage) => {
          activeStage = stage;
          await host.updateJobSafe(jobId, {
            heartbeatAt: new Date(),
            currentStage: stage,
            currentItemKey: chapter.id,
            currentItemLabel,
            progress: buildPipelineStageProgress({
              completedCount: completed,
              totalCount,
              stage,
            }),
          });
        };

        await applyChapterStage("generating_chapters");
        logPipelineInfo("开始处理章节", {
          jobId,
          chapterId: chapter.id,
          order: chapter.order,
          hasDraft: Boolean((chapter.content ?? "").trim()),
        });

        const chapterAbort = new AbortController();
        host.activeChapterAborts.set(jobId, chapterAbort);
        const heartbeatTimer = setInterval(() => {
          void host.updateJobSafe(jobId, {
            heartbeatAt: new Date(),
            leaseExpiresAt: new Date(Date.now() + PIPELINE_LEASE_TTL_MS),
            currentStage: activeStage,
            currentItemKey: chapter.id,
            currentItemLabel,
            progress: buildPipelineStageProgress({
              completedCount: completed,
              totalCount,
              stage: activeStage,
            }),
          });
          // 心跳间隙轮询取消（跨进程/无 live map 时的兜底）
          void host.ensurePipelineNotCancelled(jobId).catch((error) => {
            if (!chapterAbort.signal.aborted) {
              chapterAbort.abort(
                error instanceof Error ? error : new Error("PIPELINE_CANCELLED"),
              );
            }
          });
        }, PIPELINE_HEARTBEAT_INTERVAL_MS);
        heartbeatTimer.unref?.();

        const chapterResult = await host.chapterRuntimeCoordinator.runPipelineChapter(
          novelId,
          chapter.id,
          {
            provider: runtimePayload.provider,
            model: runtimePayload.model,
            temperature: runtimePayload.temperature,
            taskStyleProfileId: runtimePayload.taskStyleProfileId,
            controlPolicy: runtimePayload.controlPolicy,
            maxRetries,
            autoReview: runtimePayload.autoReview,
            autoRepair: runtimePayload.autoRepair,
            qualityThreshold,
            repairMode: runtimePayload.repairMode,
            artifactSyncMode: runtimePayload.artifactSyncMode,
            signal: chapterAbort.signal,
          },
          {
            onCheckCancelled: () => host.ensurePipelineNotCancelled(jobId),
            onStageChange: async (stage) => {
              await applyChapterStage(stage);
            },
            onEmptyContent: async (event) => {
              const detail = buildEmptyChapterDetail(chapter);
              const meta = {
                jobId,
                workflowTaskId: runtimePayload.workflowTaskId,
                novelId,
                chapterId: chapter.id,
                chapterOrder: chapter.order,
                provider: runtimePayload.provider,
                model: runtimePayload.model,
                runMode: runtimePayload.runMode,
                emptyAttempt: event.attempt,
                willRetry: event.willRetry,
                contentLength: event.contentLength,
                rawContentLength: event.rawContentLength,
                source: event.error.details.source,
              };
              if (event.willRetry) {
                logPipelineWarn("章节生成未返回正文，正在重试当前章", meta);
                return;
              }
              if (!qualityAlertDetails.includes(detail)) {
                qualityAlertDetails.push(detail);
              }
              logPipelineError("章节生成连续未返回正文，已暂停流水线", meta);
            },
            onWriterTransportRetry: async (event) => {
              const meta = {
                jobId,
                workflowTaskId: runtimePayload.workflowTaskId,
                novelId,
                chapterId: chapter.id,
                chapterOrder: chapter.order,
                provider: runtimePayload.provider,
                model: runtimePayload.model,
                runMode: runtimePayload.runMode,
                transportAttempt: event.attempt,
                willRetry: event.willRetry,
                message: event.message,
              };
              if (event.willRetry) {
                logPipelineWarn("章节生成瞬时传输失败，正在整章重试", meta);
                return;
              }
              logPipelineError("章节生成瞬时传输失败已耗尽重试，任务将失败", meta);
            },
          },
        ).finally(() => {
          clearInterval(heartbeatTimer);
          const current = host.activeChapterAborts.get(jobId);
          if (current === chapterAbort) {
            host.activeChapterAborts.delete(jobId);
          }
        });

        totalRetryCount += chapterResult.retryCountUsed;
        final = { score: chapterResult.score, issues: chapterResult.issues };
        if (chapterResult.recoverableRepairFailure) {
          recoverableRepairDetails.push(
            `第${chapter.order}章需要后续修复：${chapterResult.recoverableRepairFailure.message}`,
          );
          logPipelineWarn("章节局部修复未安全应用，已记录并继续后续章节", {
            jobId,
            order: chapter.order,
            reason: chapterResult.recoverableRepairFailure.message,
            failureTypes: chapterResult.recoverableRepairFailure.failureTypes,
          });
        }
        if (chapterResult.reviewExecuted) {
          await createQualityReport(novelId, chapter.id, final.score, final.issues);
          const assessmentSource = chapterResult.retryCountUsed > 0 ? "repair_recheck" : "pipeline_review";
          const assessmentTerminalAction = chapterResult.pass ? null : "defer_and_continue";
          // B3：mode=off 时 null；advisory|enforce 规则段归并 qualityLoop（详情写 settingAlignment）
          let settingAlignment = null as ReturnType<typeof assessSettingAlignmentForQualityLoop>;
          try {
            const finalContent = chapterResult.runtimePackage?.draft?.content
              ?? chapter.content
              ?? "";
            settingAlignment = assessSettingAlignmentForQualityLoop({
              novelId,
              chapterId: chapter.id,
              chapterOrder: chapter.order,
              content: typeof finalContent === "string" ? finalContent : "",
              mode: runtimePayload.settingQualityMode ?? "off",
              contextPackage: chapterResult.runtimePackage?.context ?? null,
              mustAvoid: chapterResult.runtimePackage?.context?.chapter?.mustAvoid
                ?? null,
            });
          } catch (error) {
            logPipelineWarn("设定对齐规则段评估失败，跳过 setting signal", {
              jobId,
              novelId,
              chapterId: chapter.id,
              chapterOrder: chapter.order,
              error: error instanceof Error ? error.message : String(error),
            });
            settingAlignment = null;
          }
          // 先构建 assessment 供 fail-open 内存并计；DB 成功后再以同源结果更新。
          const memoryAssessment = buildChapterQualityLoopAssessment({
            chapterId: chapter.id,
            chapterOrder: chapter.order,
            score: final.score,
            issues: final.issues,
            runtimePackage: chapterResult.runtimePackage,
            settingAlignment,
          });
          let assessmentForMemory: ChapterQualityLoopAssessment = memoryAssessment;
          // fail-open 时 catch 内已 set 同源 snapshot；成功路径在下方 set
          let rangeDebtSeededFromFailOpen = false;
          try {
            assessmentForMemory = await chapterQualityLoopService.recordAssessment({
              novelId,
              chapterId: chapter.id,
              chapterOrder: chapter.order,
              score: final.score,
              issues: final.issues,
              runtimePackage: chapterResult.runtimePackage,
              source: assessmentSource,
              terminalAction: assessmentTerminalAction,
              taskId: runtimePayload.workflowTaskId,
              qualityDebtAttribution: chapterResult.qualityDebtAttribution ?? null,
              settingAlignment,
            });
          } catch (error) {
            // P2-2：DB 失败 fail-open——内存仍并计 gate；日志+进程计数避免静默该停未持久化
            const memoryRiskFlags = buildQualityLoopRiskFlagsSnapshot(
              assessmentForMemory,
              assessmentSource,
              assessmentTerminalAction,
              settingAlignment,
            );
            // assessment 本体即可判 replan blocking，避免 JSON 往返
            const chapterBlocksReplanGate = isBlockingReplanQualityDebt(
              assessmentForMemory as unknown as Record<string, unknown>,
            );
            const failOpenMetrics = noteQualityLoopPersistFailOpen({
              chapterId: chapter.id,
              jobId,
              chapterBlocksReplanGate,
            });
            // 预估写入后的范围 gate（与下方 set 同源）
            const projectedRows = Array.from(rangeDebtByChapterId.entries())
              .filter(([id]) => id !== chapter.id)
              .map(([, row]) => row)
              .concat([{
                order: chapter.order,
                riskFlags: memoryRiskFlags,
              }]);
            const projectedGate = buildVolumeReplanQualityDebtGate({
              chapters: projectedRows,
              startOrder: options.startOrder,
              endOrder: options.endOrder,
            });
            logPipelineError("记录章节质量闭环状态失败", {
              jobId,
              novelId,
              chapterId: chapter.id,
              chapterOrder: chapter.order,
              failOpen: true,
              qualityLoopPersistFailed: true,
              chapterBlocksReplanGate,
              memoryRootCauseCode: assessmentForMemory.rootCauseCode ?? null,
              memoryRecommendedAction: assessmentForMemory.recommendedAction,
              projectedBlockingReplanCount: projectedGate.blockingReplanCount,
              projectedShouldPause: projectedGate.shouldPause,
              failOpenTotal: failOpenMetrics.total,
              failOpenBlockingReplanMemoryCount: failOpenMetrics.blockingReplanMemoryCount,
              // 运维：进程内计数，重启清零；扫日志字段 failOpen=true
              failOpenScope: "process_local",
              error: error instanceof Error ? error.message : String(error),
            });
            rangeDebtByChapterId.set(chapter.id, {
              order: chapter.order,
              riskFlags: memoryRiskFlags,
            });
            rangeDebtSeededFromFailOpen = true;
          }
          if (!rangeDebtSeededFromFailOpen) {
            rangeDebtByChapterId.set(chapter.id, {
              order: chapter.order,
              riskFlags: buildQualityLoopRiskFlagsSnapshot(
                assessmentForMemory,
                assessmentSource,
                assessmentTerminalAction,
                settingAlignment,
              ),
            });
          }
        }

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

        const replanRecommendation = chapterResult.runtimePackage?.replanRecommendation;
        if (replanRecommendation?.recommended) {
          const impactedOrders = replanRecommendation.affectedChapterOrders?.length
            ? `影响章节=${replanRecommendation.affectedChapterOrders.join(",")}`
            : `锚点章节=${replanRecommendation.anchorChapterOrder ?? chapter.order}`;
          const detail = `第${chapter.order}章${replanRecommendation.action === "stop_for_replan" ? "需要重规划" : "建议局部处理"}（${impactedOrders}；原因=${replanRecommendation.triggerReason ?? replanRecommendation.reason}）`;
          if (replanRecommendation.action === "stop_for_replan") {
            replanAlertDetails.push(detail);
            shouldStopAfterCurrentChapter = true;
          } else if (!qualityAlertDetails.includes(detail)) {
            qualityAlertDetails.push(detail);
          }
        }

        // 窗内章：从 DB 重读 title/taskSheet/summary（禁止用 job 启动时的 chapter 快照覆盖）。
        await refreshGenreBeatLabelFromDb(chapter.id, chapter.order);

        // job 运行范围 replan 质量债熔断：内存计数达阈值则停止后续章（不每章扫库）。
        if (!shouldStopAfterCurrentChapter) {
          const volumeGate = evaluateRangeReplanGate();
          if (volumeGate.shouldPause) {
            const detail = volumeGate.reason ?? "运行范围内 replan 质量债已达熔断阈值。";
            if (!replanAlertDetails.includes(detail)) {
              replanAlertDetails.push(detail);
            }
            shouldStopAfterCurrentChapter = true;
            logPipelineWarn("运行范围 replan 质量债熔断，停止后续章节流水线", {
              jobId,
              order: chapter.order,
              blockingReplanCount: volumeGate.blockingReplanCount,
              threshold: volumeGate.threshold,
              scope: volumeGate.scope,
              startOrder: volumeGate.startOrder,
              endOrder: volumeGate.endOrder,
            });
          }
        }

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
        await host.updateJobSafe(jobId, {
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
        });
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

      const finalStatus: "succeeded" = "succeeded";
      await host.updateJobSafe(jobId, {
        heartbeatAt: new Date(),
        currentStage: "finalizing",
        currentItemKey: null,
        currentItemLabel: "正在收尾章节流水线任务",
        progress: buildPipelineStageProgress({
          completedCount: completed,
          totalCount,
          stage: "finalizing",
        }),
      });
      await host.updateJobSafe(jobId, {
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
      });
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
    // 取消文案 / AbortError 统一落 cancelled，禁止 auto-requeue（见 isPipelineCancellationError）。
    if (isPipelineCancellationError(error)) {
      await host.updateJobSafe(jobId, {
        status: "cancelled",
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
          jobTransportAutoRetryCount: 0,
        }),
      });
      void novelEventBus.emit({
        type: "pipeline:completed",
        payload: { novelId, jobId, status: "cancelled" },
      }).catch(() => {});
      return;
    }

    const message = error instanceof Error ? error.message : "流水线执行失败";
    if (isChapterEmptyContentError(error)) {
      logPipelineError("任务因章节空正文失败", {
        jobId,
        novelId,
        provider: runtimePayload.provider,
        model: runtimePayload.model,
        runMode: runtimePayload.runMode,
        workflowTaskId: runtimePayload.workflowTaskId,
        source: error.details.source,
        contentLength: error.details.trimmedLength,
        rawContentLength: error.details.rawLength,
      });
    }

    // 章节内 empty/transport 重试耗尽后仍瞬时失败：同 job 有限次 requeue（skipCompleted 保已写章）。
    // 取消/AbortError/业务错误不 requeue。预算见 PIPELINE_JOB_TRANSPORT_AUTO_RETRY_MAX。
    const usedJobAutoRetry = normalizeJobTransportAutoRetryCount(
      runtimePayload.jobTransportAutoRetryCount,
    );
    if (shouldAutoRetryPipelineJob({
      error,
      usedCount: usedJobAutoRetry,
      maxCount: PIPELINE_JOB_TRANSPORT_AUTO_RETRY_MAX,
    })) {
      const nextCount = usedJobAutoRetry + 1;
      const retryMessage = formatPipelineJobAutoRetryMessage({
        originalMessage: message,
        nextCount,
        maxCount: PIPELINE_JOB_TRANSPORT_AUTO_RETRY_MAX,
      });
      const requeuePayload: PipelinePayload = {
        ...runtimePayload,
        qualityAlertDetails,
        replanAlertDetails,
        genreBeatAlertDetails,
        recoverableRepairDetails,
        jobTransportAutoRetryCount: nextCount,
      };
      // CAS：仅 running 且 cancelRequestedAt 仍 null 才 requeue，避免取消竞态清掉 cancel 并再排队
      let requeued = false;
      try {
        const result = await prisma.generationJob.updateMany({
          where: buildPipelineJobAutoRequeueCasWhere(jobId),
          data: {
            status: "queued",
            error: retryMessage,
            finishedAt: null,
            heartbeatAt: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            currentStage: "queued",
            currentItemKey: null,
            currentItemLabel: null,
            pendingManualRecovery: false,
            retryCount: totalRetryCount,
            payload: host.stringifyPipelinePayload(requeuePayload),
          },
        });
        requeued = result.count > 0;
      } catch (requeueError) {
        logPipelineWarn("任务自动重试写库失败", {
          jobId,
          novelId,
          error: requeueError instanceof Error ? requeueError.message : String(requeueError),
        });
        requeued = false;
      }
      if (!requeued) {
        // 可能已 cancel 或离开 running：若仍请求取消则收口 cancelled，否则落 failed
        const latest = await prisma.generationJob.findUnique({
          where: { id: jobId },
          select: { status: true, cancelRequestedAt: true },
        });
        if (latest?.cancelRequestedAt || latest?.status === "cancelled") {
          await host.updateJobSafe(jobId, {
            status: "cancelled",
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
              jobTransportAutoRetryCount: 0,
            }),
          });
          void novelEventBus.emit({
            type: "pipeline:completed",
            payload: { novelId, jobId, status: "cancelled" },
          }).catch(() => {});
          return;
        }
        if (latest?.status === "queued" || latest?.status === "succeeded" || latest?.status === "failed") {
          // 并发路径已处理，不再二次写
          return;
        }
        await host.updateJobSafe(jobId, {
          status: "failed",
          error: message,
          finishedAt: new Date(),
          payload: host.stringifyPipelinePayload({
            ...runtimePayload,
            qualityAlertDetails,
            replanAlertDetails,
            genreBeatAlertDetails,
            recoverableRepairDetails,
            jobTransportAutoRetryCount: usedJobAutoRetry,
          }),
        });
        logPipelineError("任务执行异常（自动重试 CAS 未命中）", {
          jobId,
          novelId,
          message,
          jobTransportAutoRetryCount: usedJobAutoRetry,
          latestStatus: latest?.status ?? null,
        });
        void novelEventBus.emit({
          type: "pipeline:completed",
          payload: { novelId, jobId, status: "failed" },
        }).catch(() => {});
        return;
      }
      // 字段与 resume 路径对齐：jobTransportAutoRetryCount + recoveryPath + maxCount
      logPipelineWarn("任务瞬时失败，排队自动重试", {
        jobId,
        novelId,
        jobTransportAutoRetryCount: nextCount,
        maxCount: PIPELINE_JOB_TRANSPORT_AUTO_RETRY_MAX,
        delayMs: PIPELINE_JOB_TRANSPORT_AUTO_RETRY_DELAY_MS,
        recoveryPath: PIPELINE_JOB_AUTO_RETRY_RECOVERY_IN_PROCESS_TIMER,
        message,
      });
      const resumeOptions: PipelineRunOptions = {
        startOrder: options.startOrder,
        endOrder: options.endOrder,
        controlPolicy: requeuePayload.controlPolicy,
        workflowTaskId: requeuePayload.workflowTaskId,
        taskStyleProfileId: requeuePayload.taskStyleProfileId,
        maxRetries: clampPipelineMaxRetries(requeuePayload.maxRetries),
        runMode: requeuePayload.runMode,
        autoReview: requeuePayload.autoReview,
        autoRepair: requeuePayload.autoRepair,
        skipCompleted: requeuePayload.skipCompleted ?? true,
        qualityThreshold: requeuePayload.qualityThreshold,
        repairMode: requeuePayload.repairMode,
        artifactSyncMode: requeuePayload.artifactSyncMode,
        provider: requeuePayload.provider,
        model: requeuePayload.model,
        temperature: requeuePayload.temperature,
      };
      // 必须 defer：当前仍在 schedulePipelineExecution 的 activeJobIds 保护期内，
      // 同步再调 schedule 会被 activeJobIds.has 直接跳过，job 卡在 queued。
      // 进程若在 delay 内退出：timer 丢失，靠 resumePending / stale watchdog 拾起
      // （queued + count 已落库；见 pipelineJobAutoRetry 契约）。
      const delayMs = PIPELINE_JOB_TRANSPORT_AUTO_RETRY_DELAY_MS;
      setTimeout(() => {
        host.schedulePipelineExecution(jobId, novelId, resumeOptions);
      }, delayMs).unref?.();
      return;
    }

    await host.updateJobSafe(jobId, {
      status: "failed",
      error: message,
      finishedAt: new Date(),
      payload: host.stringifyPipelinePayload({
        ...runtimePayload,
        qualityAlertDetails,
        replanAlertDetails,
        genreBeatAlertDetails,
        recoverableRepairDetails,
        jobTransportAutoRetryCount: usedJobAutoRetry,
      }),
    });
    logPipelineError("任务执行异常", {
      jobId,
      novelId,
      message,
      jobTransportAutoRetryCount: usedJobAutoRetry,
    });
    void novelEventBus.emit({
      type: "pipeline:completed",
      payload: { novelId, jobId, status: "failed" },
    }).catch(() => {});
  }
}
