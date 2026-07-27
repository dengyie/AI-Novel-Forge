/**
 * Volume Readiness act + verify：
 * per chapter 分发真 review / light|heavy repair / polish（经 coordinator），再 re-assess。
 * 严禁 skip_quality；严禁 autoReview=false 假通过。
 */

import { volumeReadinessConfig } from "../../../config/volumeReadiness";
import { getSharedNovelServices } from "../application/sharedNovelServices";
import type { RepairOptions } from "../novelCoreShared";
import {
  buildPadReviewIssuesFromContent,
  buildSeedReviewIssuesFromPlanReasons,
} from "./volumeReadinessPadIssues";
import {
  appendVolumeReadinessChapterResult,
  getCompletedChapterIds,
  getVolumeReadinessRun,
  registerVolumeReadinessRunCancelHook,
  releaseNovelRunFlight,
  tryClaimNovelRunFlight,
  updateVolumeReadinessRun,
  type VolumeReadinessChapterOutcome,
  type VolumeReadinessRunRecord,
} from "./volumeReadinessRunStore";
import { volumeReadinessService } from "./VolumeReadinessService";
import {
  summarizeReadinessPlans,
  type VolumeReadinessVerdict,
} from "./volumeReadinessPolicy";
import { chapterReviewStatusReconciler } from "./readiness/application/ChapterReviewStatusReconciler";
import {
  countIncompleteAttemptsForChapter,
  createChapterTimeoutClock,
  drainRepairStream,
  estimateLlmCallsForAction,
  isChapterLockConflictMessage,
  isRetryableReadinessOutcome,
  loadChapterContent,
  mapRepairOutcomeFromFrames,
  type RepairStreamHandle,
} from "./readiness/application/VolumeReadinessExecutionSupport";

export {
  countIncompleteAttemptsForChapter,
  isChapterLockConflictMessage,
  mapRepairOutcome,
  mapRepairOutcomeFromFrames,
} from "./readiness/application/VolumeReadinessExecutionSupport";

export class VolumeReadinessExecutor {
  /**
   * 执行 run（可 fire-and-forget）。
   * dryRun：只写 dry_run outcome，零副作用。
   * resume：跳过 results 中已有 terminal outcome 的章。
   * wall 预算跨 resume 累加（wallMsUsed）。
   */
  async execute(runId: string): Promise<VolumeReadinessRunRecord> {
    const initial = getVolumeReadinessRun(runId);
    if (!initial) {
      throw new Error(`readiness run not found: ${runId}`);
    }
    if (initial.status === "completed" || initial.status === "cancelled" || initial.status === "failed") {
      return initial;
    }
    if (initial.cancelRequested) {
      return updateVolumeReadinessRun(runId, {
        status: "cancelled",
        finishedAt: new Date().toISOString(),
      }) ?? initial;
    }

    const priorWallMsGuard = typeof initial.wallMsUsed === "number" ? initial.wallMsUsed : 0;
    const deadlineMsGuard = initial.budget.maxWallMinutes * 60 * 1000;
    if (!initial.dryRun && priorWallMsGuard > 0 && priorWallMsGuard >= deadlineMsGuard) {
      const usedMin = Math.ceil(priorWallMsGuard / 60_000);
      console.warn("[volume.readiness] refuse execute: wall already exhausted", {
        runId,
        novelId: initial.novelId,
        wallMsUsed: priorWallMsGuard,
        maxWallMinutes: initial.budget.maxWallMinutes,
      });
      return updateVolumeReadinessRun(runId, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error:
          `wall already exhausted (used ~${usedMin}m ≥ maxWallMinutes=${initial.budget.maxWallMinutes}m); ` +
          `resume with higher budget.maxWallMinutes`,
        wallMsUsed: priorWallMsGuard,
      }) ?? initial;
    }

    if (!initial.dryRun) {
      const claimed = tryClaimNovelRunFlight(initial.novelId, runId);
      if (!claimed) {
        const liveSame = getVolumeReadinessRun(runId);
        console.warn("[volume.readiness] execute skipped: flight busy", {
          runId,
          novelId: initial.novelId,
          ourStatus: liveSame?.status ?? initial.status,
        });
        return liveSame ?? initial;
      }
    }

    updateVolumeReadinessRun(runId, {
      status: "running",
      startedAt: initial.startedAt ?? new Date().toISOString(),
    });

    const sessionStartedMs = Date.now();
    const priorWallMs = typeof initial.wallMsUsed === "number" ? initial.wallMsUsed : 0;
    let llmCallsUsed = initial.llmCallsUsed;
    let heavyRewritesUsed = initial.heavyRewritesUsed;
    let chaptersActed = initial.chaptersActed;
    const novelService = getSharedNovelServices();
    const deadlineMs = initial.budget.maxWallMinutes * 60 * 1000;
    const maxIncomplete = volumeReadinessConfig.maxIncompleteRetries;
    const doneChapterIds = getCompletedChapterIds(initial);
    const actedChapterIds = new Set(doneChapterIds);

    const wallUsedMs = (): number => priorWallMs + (Date.now() - sessionStartedMs);
    const perChapterTimeoutMs = volumeReadinessConfig.perChapterTimeoutMs;
    const heartbeatMs = volumeReadinessConfig.wallHeartbeatMs;
    let wallHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

    try {
      wallHeartbeatTimer = setInterval(() => {
        updateVolumeReadinessRun(runId, { wallMsUsed: wallUsedMs() });
      }, heartbeatMs);
      wallHeartbeatTimer.unref?.();

      for (const planItem of initial.plan) {
        const live = getVolumeReadinessRun(runId);
        if (!live || live.cancelRequested) {
          updateVolumeReadinessRun(runId, {
            status: "cancelled",
            finishedAt: new Date().toISOString(),
            llmCallsUsed,
            heavyRewritesUsed,
            chaptersActed,
            wallMsUsed: wallUsedMs(),
          });
          break;
        }

        if (doneChapterIds.has(planItem.chapterId)) {
          actedChapterIds.add(planItem.chapterId);
          continue;
        }

        if (!initial.dryRun) {
          const preClock = createChapterTimeoutClock(
            Math.max(0, deadlineMs - wallUsedMs()),
            perChapterTimeoutMs,
          );
          try {
            const preReport = await preClock.race(
              () => volumeReadinessService.assess(initial.novelId, {
                fromOrder: planItem.chapterOrder,
                toOrder: planItem.chapterOrder,
                refresh: false,
              }),
              "pre-assess",
            );
            const pre = preReport.chapters.find((c) => c.chapterId === planItem.chapterId);
            if (pre?.verdict === "publish_ready") {
              appendVolumeReadinessChapterResult(runId, {
                chapterId: planItem.chapterId,
                chapterOrder: planItem.chapterOrder,
                title: planItem.title,
                verdictBefore: planItem.verdict,
                verdictAfter: "publish_ready",
                outcome: "already_done",
                message: `pre-assess publish_ready（plan 原 verdict=${planItem.verdict}，跳过动作）`,
                startedAt: new Date().toISOString(),
                finishedAt: new Date().toISOString(),
              }, { llmCallsUsed, heavyRewritesUsed, chaptersActed });
              updateVolumeReadinessRun(runId, { wallMsUsed: wallUsedMs() });
              actedChapterIds.add(planItem.chapterId);
              continue;
            }
          } catch {
            // A stale pre-assessment must not block the planned action.
          } finally {
            preClock.dispose();
          }
        }

        const incompleteAttempts = countIncompleteAttemptsForChapter(
          live.results,
          planItem.chapterId,
        );
        if (incompleteAttempts >= maxIncomplete) {
          appendVolumeReadinessChapterResult(runId, {
            chapterId: planItem.chapterId,
            chapterOrder: planItem.chapterOrder,
            title: planItem.title,
            verdictBefore: planItem.verdict,
            verdictAfter: null,
            outcome: "kept",
            message: `attempt×${incompleteAttempts} ≥ maxIncompleteRetries=${maxIncomplete}；转人工（勿 resume 空转）`,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            attemptCount: incompleteAttempts,
          }, { llmCallsUsed, heavyRewritesUsed, chaptersActed });
          actedChapterIds.add(planItem.chapterId);
          continue;
        }

        if (wallUsedMs() > deadlineMs) {
          for (const item of initial.plan) {
            if (actedChapterIds.has(item.chapterId) || doneChapterIds.has(item.chapterId)) {
              continue;
            }
            appendVolumeReadinessChapterResult(runId, {
              chapterId: item.chapterId,
              chapterOrder: item.chapterOrder,
              title: item.title,
              verdictBefore: item.verdict,
              verdictAfter: null,
              outcome: "budget_skipped",
              message: `wall time budget ${initial.budget.maxWallMinutes}m exhausted (used ~${Math.ceil(wallUsedMs() / 60000)}m incl. prior resume)`,
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
            }, { llmCallsUsed, heavyRewritesUsed, chaptersActed });
            actedChapterIds.add(item.chapterId);
          }
          break;
        }

        if (chaptersActed >= initial.budget.maxChapters) {
          appendVolumeReadinessChapterResult(runId, {
            chapterId: planItem.chapterId,
            chapterOrder: planItem.chapterOrder,
            title: planItem.title,
            verdictBefore: planItem.verdict,
            verdictAfter: null,
            outcome: "budget_skipped",
            message: `maxChapters=${initial.budget.maxChapters}`,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          }, { llmCallsUsed, heavyRewritesUsed, chaptersActed });
          actedChapterIds.add(planItem.chapterId);
          continue;
        }

        const estimated = estimateLlmCallsForAction(planItem.verdict);
        if (llmCallsUsed + estimated > initial.budget.maxLlmCalls && estimated > 0) {
          appendVolumeReadinessChapterResult(runId, {
            chapterId: planItem.chapterId,
            chapterOrder: planItem.chapterOrder,
            title: planItem.title,
            verdictBefore: planItem.verdict,
            verdictAfter: null,
            outcome: "budget_skipped",
            message: `maxLlmCalls=${initial.budget.maxLlmCalls} (need ~${estimated}, used ${llmCallsUsed})`,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          }, { llmCallsUsed, heavyRewritesUsed, chaptersActed });
          actedChapterIds.add(planItem.chapterId);
          continue;
        }

        if (initial.dryRun) {
          appendVolumeReadinessChapterResult(runId, {
            chapterId: planItem.chapterId,
            chapterOrder: planItem.chapterOrder,
            title: planItem.title,
            verdictBefore: planItem.verdict,
            verdictAfter: planItem.verdict,
            outcome: "dry_run",
            message: planItem.reasons.join("；"),
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          });
          actedChapterIds.add(planItem.chapterId);
          continue;
        }

        const chapterStartedAt = new Date().toISOString();
        let outcome: VolumeReadinessChapterOutcome = "failed";
        let message: string | null = null;
        let verdictAfter: VolumeReadinessVerdict | null = null;
        let attemptCount: number | undefined;

        let chapterClock: ReturnType<typeof createChapterTimeoutClock> | null = null;
        let unregisterCancelHook: (() => void) | null = null;
        try {
          const remainingWallMs = Math.max(0, deadlineMs - wallUsedMs());
          if (remainingWallMs <= 0) {
            throw new Error("readiness chapter aborted: wall budget exhausted before step");
          }
          chapterClock = createChapterTimeoutClock(remainingWallMs, perChapterTimeoutMs);
          const clock = chapterClock;
          unregisterCancelHook = registerVolumeReadinessRunCancelHook(
            runId,
            () => clock.abort("run cancel requested"),
          );

          if (planItem.verdict === "needs_re_review") {
            updateVolumeReadinessRun(runId, {
              llmCallsUsed,
              heavyRewritesUsed,
              chaptersActed,
              wallMsUsed: wallUsedMs(),
            });
            llmCallsUsed += estimateLlmCallsForAction("needs_re_review");
            chaptersActed += 1;
            await clock.race(
              () => novelService.reviewChapter(initial.novelId, planItem.chapterId, {
                skipPayoffLedgerSync: true,
                signal: clock.signal,
              }),
              "reviewChapter",
            );
            outcome = "re_reviewed";
            message = "true review executed (dual gate)";
          } else if (planItem.verdict === "needs_patch" || planItem.verdict === "needs_heavy") {
            if (planItem.verdict === "needs_heavy") {
              if (heavyRewritesUsed >= initial.budget.maxHeavyRewrites) {
                outcome = "budget_skipped";
                message = `maxHeavyRewrites=${initial.budget.maxHeavyRewrites}`;
                appendVolumeReadinessChapterResult(runId, {
                  chapterId: planItem.chapterId,
                  chapterOrder: planItem.chapterOrder,
                  title: planItem.title,
                  verdictBefore: planItem.verdict,
                  verdictAfter: null,
                  outcome,
                  message,
                  startedAt: chapterStartedAt,
                  finishedAt: new Date().toISOString(),
                }, { llmCallsUsed, heavyRewritesUsed, chaptersActed });
                actedChapterIds.add(planItem.chapterId);
                continue;
              }
            }

            const repairMode: NonNullable<RepairOptions["repairMode"]> = planItem.verdict === "needs_heavy"
              ? "heavy_repair"
              : "light_repair";

            const padHits = typeof planItem.signals?.padHitCount === "number"
              ? planItem.signals.padHitCount
              : 0;
            const styleOk = planItem.signals?.styleClear !== false;
            const l0Ok = planItem.signals?.l0Clear !== false;
            const injectPadOnly = repairMode === "light_repair"
              && padHits > 0
              && styleOk
              && l0Ok;

            let padIssueCount = 0;
            const repairOptions: RepairOptions = { repairMode, signal: clock.signal };
            if (injectPadOnly) {
              const content = await loadChapterContent(planItem.chapterId);
              const padIssues = buildPadReviewIssuesFromContent(content);
              padIssueCount = padIssues.length;
              if (padIssues.length > 0) {
                repairOptions.reviewIssues = padIssues;
              }
            }
            if (!repairOptions.reviewIssues || repairOptions.reviewIssues.length === 0) {
              const seedIssues = buildSeedReviewIssuesFromPlanReasons(planItem.reasons);
              if (seedIssues.length > 0) {
                repairOptions.reviewIssues = seedIssues;
              }
            }

            updateVolumeReadinessRun(runId, {
              llmCallsUsed,
              heavyRewritesUsed,
              chaptersActed,
              wallMsUsed: wallUsedMs(),
            });
            llmCallsUsed += estimateLlmCallsForAction(planItem.verdict);
            chaptersActed += 1;
            if (repairMode === "heavy_repair") {
              heavyRewritesUsed += 1;
            }
            const streamResult = await clock.race<RepairStreamHandle>(
              () => novelService.createRepairStream(
                initial.novelId,
                planItem.chapterId,
                repairOptions,
              ) as Promise<RepairStreamHandle>,
              "createRepairStream",
            );
            const drained = await clock.race(
              () => drainRepairStream({
                stream: streamResult.stream,
                onDone: streamResult.onDone,
                signal: clock.signal,
              }),
              "drainRepairStream",
            );
            const mapped = mapRepairOutcomeFromFrames(drained.frames);
            outcome = mapped.outcome;
            message = mapped.message
              ?? `repairMode=${repairMode}${padIssueCount > 0 ? ` padIssues=${padIssueCount}` : ""}`;
            if (padIssueCount > 0 && message && !message.includes("padIssues")) {
              message = `${message} | padIssues=${padIssueCount}`;
            }
          } else if (planItem.verdict === "needs_polish") {
            llmCallsUsed += estimateLlmCallsForAction("needs_polish");
            chaptersActed += 1;
            await clock.race(
              () => novelService.runPipelineChapter(
                initial.novelId,
                planItem.chapterId,
                { runMode: "polish", signal: clock.signal },
              ),
              "runPipelineChapter(polish)",
            );
            outcome = "polished";
            message = "pipeline polish (skip writer, finalize dual gate)";
          } else if (planItem.verdict === "needs_manual") {
            outcome = "kept";
            message = "manual only — no auto action";
          } else {
            outcome = "kept";
            message = "publish_ready kept";
          }

          const report = await clock.race(
            () => volumeReadinessService.assess(initial.novelId, {
              fromOrder: planItem.chapterOrder,
              toOrder: planItem.chapterOrder,
              refresh: false,
            }),
            "assess",
          );
          const after = report.chapters.find((c) => c.chapterId === planItem.chapterId);
          const reviewedSignals = after?.signals;
          verdictAfter = after?.verdict ?? null;

          const reconciliation = await chapterReviewStatusReconciler.reconcile({
            novelId: initial.novelId,
            chapterId: planItem.chapterId,
            chapterOrder: planItem.chapterOrder,
            outcome,
            verdictAfter,
            signals: reviewedSignals,
            message,
            runWithDeadline: (operation, label) => clock.race(operation, label),
          });
          verdictAfter = reconciliation.verdictAfter;
          message = reconciliation.message;

          if (
            outcome === "re_reviewed"
            && (verdictAfter === "needs_heavy" || verdictAfter === "needs_patch")
            && initial.actionFilter.includes(verdictAfter)
          ) {
            const chainVerdict: "needs_heavy" | "needs_patch" = verdictAfter;
            const chainMode: NonNullable<RepairOptions["repairMode"]> = chainVerdict === "needs_heavy"
              ? "heavy_repair"
              : "light_repair";
            const heavyBlocked = chainMode === "heavy_repair"
              && heavyRewritesUsed >= initial.budget.maxHeavyRewrites;
            const chainEstimated = estimateLlmCallsForAction(chainVerdict);
            const llmBlocked = llmCallsUsed + chainEstimated > initial.budget.maxLlmCalls;
            const wallBlocked = wallUsedMs() > deadlineMs;

            if (!heavyBlocked && !llmBlocked && !wallBlocked) {
              const padHitsChain = typeof planItem.signals?.padHitCount === "number"
                ? planItem.signals.padHitCount
                : 0;
              const styleOkChain = planItem.signals?.styleClear !== false;
              const l0OkChain = planItem.signals?.l0Clear !== false;
              const injectPadOnlyChain = chainMode === "light_repair"
                && padHitsChain > 0
                && styleOkChain
                && l0OkChain;

              let padIssueCountChain = 0;
              const repairOptionsChain: RepairOptions = { repairMode: chainMode, signal: clock.signal };
              if (injectPadOnlyChain) {
                const contentChain = await loadChapterContent(planItem.chapterId);
                const padIssuesChain = buildPadReviewIssuesFromContent(contentChain);
                padIssueCountChain = padIssuesChain.length;
                if (padIssuesChain.length > 0) {
                  repairOptionsChain.reviewIssues = padIssuesChain;
                }
              }
              if (!repairOptionsChain.reviewIssues || repairOptionsChain.reviewIssues.length === 0) {
                const chainReasons = (typeof after?.reasons !== "undefined" && Array.isArray(after.reasons))
                  ? after.reasons
                  : planItem.reasons;
                const seedChain = buildSeedReviewIssuesFromPlanReasons(chainReasons);
                if (seedChain.length > 0) {
                  repairOptionsChain.reviewIssues = seedChain;
                }
              }

              updateVolumeReadinessRun(runId, {
                llmCallsUsed,
                heavyRewritesUsed,
                chaptersActed,
                wallMsUsed: wallUsedMs(),
              });

              llmCallsUsed += chainEstimated;
              if (chainMode === "heavy_repair") {
                heavyRewritesUsed += 1;
              }
              const chainStream = await clock.race<RepairStreamHandle>(
                () => novelService.createRepairStream(
                  initial.novelId,
                  planItem.chapterId,
                  repairOptionsChain,
                ) as Promise<RepairStreamHandle>,
                "chain.createRepairStream",
              );
              const chainDrained = await clock.race(
                () => drainRepairStream({
                  stream: chainStream.stream,
                  onDone: chainStream.onDone,
                  signal: clock.signal,
                }),
                "chain.drainRepairStream",
              );
              const chainMapped = mapRepairOutcomeFromFrames(chainDrained.frames);
              outcome = chainMapped.outcome;
              const chainSuffix = padIssueCountChain > 0
                ? ` padIssues=${padIssueCountChain}`
                : "";
              const chainMsg = chainMapped.message ? ` | ${chainMapped.message}` : "";
              message = `re_review→${chainMode}${chainSuffix}${chainMsg}`;

              try {
                const chainReport = await clock.race(
                  () => volumeReadinessService.assess(initial.novelId, {
                    fromOrder: planItem.chapterOrder,
                    toOrder: planItem.chapterOrder,
                    refresh: false,
                  }),
                  "chain.assess",
                );
                const chainAfter = chainReport.chapters.find(
                  (c) => c.chapterId === planItem.chapterId,
                );
                verdictAfter = chainAfter?.verdict ?? verdictAfter;
              } catch {
                // Keep the pre-repair verdict when the final assessment is unavailable.
              }
            } else {
              const blockers: string[] = [];
              if (heavyBlocked) {
                blockers.push(`heavy=${heavyRewritesUsed}/${initial.budget.maxHeavyRewrites}`);
              }
              if (llmBlocked) {
                blockers.push(`llm=${llmCallsUsed}+${chainEstimated}>${initial.budget.maxLlmCalls}`);
              }
              if (wallBlocked) {
                blockers.push("wall exhausted");
              }
              message = `${message ?? "re_reviewed"} | chain→${chainVerdict} blocked: ${blockers.join(", ")}`;
            }
          }

          if (
            verdictAfter != null
            && verdictAfter !== "publish_ready"
            && (outcome === "polished" || outcome === "repair_adopted" || outcome === "re_reviewed")
          ) {
            if (outcome === "polished") {
              outcome = "polish_incomplete";
              message = `${message ?? "polish"} → verdictAfter=${verdictAfter}`;
            } else if (outcome === "repair_adopted") {
              outcome = "repair_incomplete";
              message = `${message ?? "repair"} → verdictAfter=${verdictAfter}`;
            } else if (outcome === "re_reviewed") {
              outcome = "re_review_incomplete";
              message = `${message ?? "re_review"} → verdictAfter=${verdictAfter}`;
            }
          }
          if (outcome === "re_reviewed" && verdictAfter == null) {
            outcome = "re_review_incomplete";
            message = `${message ?? "re_review"} → verdictAfter=null (assess missing)`;
          }
          if (outcome === "polished" && verdictAfter == null) {
            outcome = "polish_incomplete";
            message = `${message ?? "polish"} → verdictAfter=null (assess missing)`;
          }

        } catch (error) {
          outcome = "failed";
          message = error instanceof Error ? error.message : String(error);
          if (isChapterLockConflictMessage(message)) {
            outcome = "skipped_locked";
          }
        } finally {
          unregisterCancelHook?.();
          unregisterCancelHook = null;
          chapterClock?.dispose();
          chapterClock = null;
        }

        if (isRetryableReadinessOutcome(outcome)) {
          attemptCount = incompleteAttempts + 1;
          if (attemptCount >= maxIncomplete) {
            message = `${message ?? outcome}｜attempt×${attemptCount} 达 maxIncompleteRetries=${maxIncomplete}，后续 resume 将 kept/人工`;
          }
        }

        appendVolumeReadinessChapterResult(runId, {
          chapterId: planItem.chapterId,
          chapterOrder: planItem.chapterOrder,
          title: planItem.title,
          verdictBefore: planItem.verdict,
          verdictAfter,
          outcome,
          message,
          startedAt: chapterStartedAt,
          finishedAt: new Date().toISOString(),
          ...(typeof attemptCount === "number" ? { attemptCount } : {}),
        }, { llmCallsUsed, heavyRewritesUsed, chaptersActed });
        actedChapterIds.add(planItem.chapterId);
      }

      const finalLive = getVolumeReadinessRun(runId);
      if (finalLive?.cancelRequested && finalLive.status !== "completed") {
        return updateVolumeReadinessRun(runId, {
          status: "cancelled",
          finishedAt: new Date().toISOString(),
          llmCallsUsed,
          heavyRewritesUsed,
          chaptersActed,
          wallMsUsed: wallUsedMs(),
        }) ?? finalLive;
      }

      let finalSummary = initial.planSummary;
      if (!initial.dryRun) {
        try {
          const finalReport = await volumeReadinessService.assess(initial.novelId, {
            volumeOrder: initial.volumeOrder,
            fromOrder: initial.fromOrder,
            toOrder: initial.toOrder,
            refresh: false,
          });
          finalSummary = finalReport.summary;
        } catch {
          finalSummary = summarizeReadinessPlans(initial.plan);
        }
      }

      return updateVolumeReadinessRun(runId, {
        status: "completed",
        finishedAt: new Date().toISOString(),
        finalSummary,
        llmCallsUsed,
        heavyRewritesUsed,
        chaptersActed,
        wallMsUsed: wallUsedMs(),
      }) ?? getVolumeReadinessRun(runId)!;
    } catch (error) {
      return updateVolumeReadinessRun(runId, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
        llmCallsUsed,
        heavyRewritesUsed,
        chaptersActed,
        wallMsUsed: wallUsedMs(),
      }) ?? getVolumeReadinessRun(runId)!;
    } finally {
      if (wallHeartbeatTimer) {
        clearInterval(wallHeartbeatTimer);
        wallHeartbeatTimer = null;
      }
      if (!initial.dryRun) {
        releaseNovelRunFlight(initial.novelId, runId);
      }
    }
  }
}

export const volumeReadinessExecutor = new VolumeReadinessExecutor();
