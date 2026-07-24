/**
 * Volume Readiness act + verify：
 * per chapter 分发真 review / light|heavy repair / polish（经 coordinator），再 re-assess。
 * 严禁 skip_quality；严禁 autoReview=false 假通过。
 */

import type { BaseMessageChunk } from "@langchain/core/messages";
import { volumeReadinessConfig } from "../../../config/volumeReadiness";
import { prisma } from "../../../db/prisma";
import { getSharedNovelServices } from "../application/sharedNovelServices";
import type { RepairOptions } from "../novelCoreShared";
import {
  buildPadReviewIssuesFromContent,
} from "./volumeReadinessPadIssues";
import {
  appendVolumeReadinessChapterResult,
  getCompletedChapterIds,
  getVolumeReadinessRun,
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

interface RepairStatusFrame {
  type?: string;
  status?: string;
  phase?: string;
  message?: string;
}

const INCOMPLETE_OUTCOMES = new Set<VolumeReadinessChapterOutcome>([
  "re_review_incomplete",
  "repair_incomplete",
  "polish_incomplete",
]);

/**
 * 从 repair finalize 的 writeFrame 收集 outcome（fail-closed）。
 * 优先级：message 语义（discard/plateau/lock）→ completed 帧 status → message adopt。
 * adopt 但 status=failed（未过门 / 副作用失败）→ repair_incomplete（可 resume 重试）。
 */
export function mapRepairOutcomeFromFrames(
  frames: RepairStatusFrame[],
): { outcome: VolumeReadinessChapterOutcome; message: string | null } {
  const completedFrames = frames.filter((frame) => frame.phase === "completed");
  const completed = completedFrames.length > 0
    ? completedFrames[completedFrames.length - 1]
    : [...frames].reverse().find((frame) => typeof frame.message === "string");
  const fromFrames = frames.map((f) => f.message).filter(Boolean).join(" ");
  const message = (completed?.message ?? fromFrames) || null;
  const text = (message ?? "").toLowerCase();
  const frameStatus = typeof completed?.status === "string"
    ? completed.status.toLowerCase()
    : "";

  if (text.includes("plateau") || text.includes("平台")) {
    return { outcome: "repair_plateau", message };
  }
  if (
    text.includes("discard")
    || text.includes("未采纳")
    || text.includes("rejected")
    || text.includes("保持 baseline")
  ) {
    return { outcome: "repair_discarded", message };
  }
  if (text.includes("lock") || text.includes("锁") || text.includes("并发")) {
    return { outcome: "skipped_locked", message };
  }

  const looksAdopted = text.includes("已采纳")
    || text.includes("adopt")
    || (text.includes("采纳") && !text.includes("未采纳"));

  if (looksAdopted) {
    // F9：adopt 流程结束但未达质量门 / artifacts 失败 → status failed
    if (frameStatus === "failed") {
      return { outcome: "repair_incomplete", message };
    }
    if (frameStatus === "succeeded" || frameStatus === "") {
      // succeeded 或旧帧无 status：全绿 adopt
      if (
        text.includes("仍有问题")
        || text.includes("待继续")
        || text.includes("同步失败")
        || text.includes("needs_repair")
      ) {
        return { outcome: "repair_incomplete", message };
      }
      return { outcome: "repair_adopted", message };
    }
    // 其它 status 保守 incomplete
    return { outcome: "repair_incomplete", message };
  }

  if (frameStatus === "failed") {
    return { outcome: "failed", message: message ?? "repair frame status=failed" };
  }
  if (frameStatus === "succeeded") {
    return { outcome: "repair_adopted", message: message ?? "repair succeeded" };
  }

  if (!message || !message.trim()) {
    return { outcome: "failed", message: message ?? "repair finished without status frame" };
  }
  // 有 message 但不认识 → fail-closed
  return { outcome: "failed", message };
}

/** 兼容旧 mapRepairOutcome(string) 调用面；未知默认 failed（不再默认 adopt）。 */
export function mapRepairOutcome(message: string | null | undefined): VolumeReadinessChapterOutcome {
  return mapRepairOutcomeFromFrames([{ message: message ?? undefined, phase: "completed" }]).outcome;
}

/**
 * 同章 incomplete 累计次数。
 * results 同章只保留最后一条，故读 attemptCount（缺省 incomplete → 1）。
 */
export function countIncompleteAttemptsForChapter(
  results: Array<{
    chapterId: string;
    outcome: VolumeReadinessChapterOutcome;
    attemptCount?: number;
  }>,
  chapterId: string,
): number {
  for (let i = results.length - 1; i >= 0; i -= 1) {
    const result = results[i];
    if (result.chapterId !== chapterId) {
      continue;
    }
    if (INCOMPLETE_OUTCOMES.has(result.outcome)) {
      return typeof result.attemptCount === "number" && result.attemptCount > 0
        ? result.attemptCount
        : 1;
    }
    return 0;
  }
  return 0;
}

async function drainRepairStream(input: {
  stream: AsyncIterable<BaseMessageChunk>;
  onDone: (
    fullContent: string,
    helpers: { writeFrame: (payload: unknown) => void },
  ) => Promise<void>;
  signal?: AbortSignal;
}): Promise<{ fullContent: string; frames: RepairStatusFrame[] }> {
  let fullContent = "";
  const frames: RepairStatusFrame[] = [];
  for await (const chunk of input.stream) {
    if (input.signal?.aborted) {
      break;
    }
    const text = typeof chunk.content === "string"
      ? chunk.content
      : Array.isArray(chunk.content)
        ? chunk.content.map((part) => (typeof part === "string" ? part : "")).join("")
        : "";
    fullContent += text;
  }
  await input.onDone(fullContent, {
    writeFrame: (payload: unknown) => {
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        frames.push(payload as RepairStatusFrame);
      }
    },
  });
  return { fullContent, frames };
}

/**
 * light_repair ≈ 2 次 LLM 等价；heavy_repair 流式 + baseline/candidate evaluateOnly ≈ 3。
 * review 计 1。用于预算，非精确 token 计量。
 */
function estimateLlmCallsForAction(verdict: VolumeReadinessVerdict): number {
  if (verdict === "needs_re_review") {
    return 1;
  }
  if (verdict === "needs_patch") {
    return 2;
  }
  if (verdict === "needs_polish") {
    // polish：跳过 writer，走 finalize/风格/双门，约 1–2 次 LLM
    return 2;
  }
  if (verdict === "needs_heavy") {
    return 3;
  }
  return 0;
}

async function loadChapterContent(chapterId: string): Promise<string> {
  try {
    const row = await prisma.chapter.findUnique({
      where: { id: chapterId },
      select: { content: true },
    });
    return row?.content ?? "";
  } catch {
    return "";
  }
}

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

    // live run：同 novel 单 flight
    if (!initial.dryRun) {
      const claimed = tryClaimNovelRunFlight(initial.novelId, runId);
      if (!claimed) {
        return updateVolumeReadinessRun(runId, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: "another live readiness run is active for this novel",
        }) ?? initial;
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

    try {
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
          // resume：不重复动作；不刷 already_done 除非 results 里缺该章（防御）
          actedChapterIds.add(planItem.chapterId);
          continue;
        }

        // incomplete 次数达上限 → 不再自动动作，记 kept（人工）
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
            message: `incomplete×${incompleteAttempts} ≥ maxIncompleteRetries=${maxIncomplete}；转人工（勿 resume 空转）`,
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
            });
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

        try {
          if (planItem.verdict === "needs_re_review") {
            await novelService.reviewChapter(initial.novelId, planItem.chapterId, {});
            llmCallsUsed += estimateLlmCallsForAction("needs_re_review");
            chaptersActed += 1;
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

            // pad 定向：仅当垫长是主因时注入 reviewIssues（会覆盖 resolveRepairIssues 的
            // fallback review）。style/l0 未清时不注入，以免丢掉其它 issue。
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
            const repairOptions: RepairOptions = { repairMode };
            if (injectPadOnly) {
              const content = await loadChapterContent(planItem.chapterId);
              const padIssues = buildPadReviewIssuesFromContent(content);
              padIssueCount = padIssues.length;
              if (padIssues.length > 0) {
                repairOptions.reviewIssues = padIssues;
              }
            }

            const streamResult = await novelService.createRepairStream(
              initial.novelId,
              planItem.chapterId,
              repairOptions,
            );
            const drained = await drainRepairStream({
              stream: streamResult.stream,
              onDone: streamResult.onDone,
            });
            llmCallsUsed += estimateLlmCallsForAction(planItem.verdict);
            chaptersActed += 1;
            if (repairMode === "heavy_repair") {
              heavyRewritesUsed += 1;
            }
            const mapped = mapRepairOutcomeFromFrames(drained.frames);
            outcome = mapped.outcome;
            message = mapped.message
              ?? `repairMode=${repairMode}${padIssueCount > 0 ? ` padIssues=${padIssueCount}` : ""}`;
            if (padIssueCount > 0 && message && !message.includes("padIssues")) {
              message = `${message} | padIssues=${padIssueCount}`;
            }
          } else if (planItem.verdict === "needs_polish") {
            // 已有正文：runMode=polish 跳过 writer，只走风格/验收/L0/双门 finalize
            await novelService.runPipelineChapter(
              initial.novelId,
              planItem.chapterId,
              { runMode: "polish" },
            );
            llmCallsUsed += estimateLlmCallsForAction("needs_polish");
            chaptersActed += 1;
            // outcome 暂记 polished；下面 re-assess 后若未 publish_ready 降为 polish_incomplete
            outcome = "polished";
            message = "pipeline polish (skip writer, finalize dual gate)";
          } else if (planItem.verdict === "needs_manual") {
            outcome = "kept";
            message = "manual only — no auto action";
          } else {
            outcome = "kept";
            message = "publish_ready kept";
          }

          const report = await volumeReadinessService.assess(initial.novelId, {
            fromOrder: planItem.chapterOrder,
            toOrder: planItem.chapterOrder,
            refresh: false,
          });
          const after = report.chapters.find((c) => c.chapterId === planItem.chapterId);
          verdictAfter = after?.verdict ?? null;

          // outcome 以 re-assess 为准：动作跑了但未 publish_ready → incomplete（可 resume）
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
              // 真 review 后仍未 completed/全绿：记 incomplete 可 resume（常见双门未过）
              outcome = "re_review_incomplete";
              message = `${message ?? "re_review"} → verdictAfter=${verdictAfter}`;
            }
          }

          if (INCOMPLETE_OUTCOMES.has(outcome)) {
            attemptCount = incompleteAttempts + 1;
            if (attemptCount >= maxIncomplete) {
              message = `${message ?? outcome}｜incomplete×${attemptCount} 达 maxIncompleteRetries=${maxIncomplete}，后续 resume 将 kept/人工`;
            }
          }
        } catch (error) {
          outcome = "failed";
          message = error instanceof Error ? error.message : String(error);
          const lower = message.toLowerCase();
          if (lower.includes("lock") || lower.includes("并发") || lower.includes("in progress")) {
            outcome = "skipped_locked";
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
      if (!initial.dryRun) {
        releaseNovelRunFlight(initial.novelId, runId);
      }
    }
  }
}

export const volumeReadinessExecutor = new VolumeReadinessExecutor();
