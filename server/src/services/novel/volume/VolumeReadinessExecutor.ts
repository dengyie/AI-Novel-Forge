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

/** createRepairStream 返回形状（NovelApplicationMethod 是 any，经 race 会 widen 成 unknown） */
interface RepairStreamHandle {
  stream: AsyncIterable<BaseMessageChunk>;
  onDone: (
    fullContent: string,
    helpers: { writeFrame: (payload: unknown) => void },
  ) => Promise<void>;
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
 *
 * #7：adopt/discard 分类只认 frame.message 来自 **completed 帧**——旧实现在对没有
 * completed 帧时用任意带 message 的帧回退匹配，可能把 finalizing 阶段"修复稿已生成，
 * 正在评估是否采纳"里的"采纳"误判成 adopt（候选还没评估而非已采纳）。无 completed 帧
 * 一律 fail-closed，避免半截状态被当终态。
 */
export function mapRepairOutcomeFromFrames(
  frames: RepairStatusFrame[],
): { outcome: VolumeReadinessChapterOutcome; message: string | null } {
  const completedFrames = frames.filter((frame) => frame.phase === "completed");
  const completed = completedFrames.length > 0
    ? completedFrames[completedFrames.length - 1]
    : null;
  // 无 completed 帧：fail-closed，不再用任意 message 帧（避免 finalizing 阶段文案被误判）
  if (!completed) {
    const tail = [...frames].reverse().find((frame) => typeof frame.message === "string");
    const fallback = tail?.message ?? "repair stream ended without completed frame";
    return { outcome: "failed", message: fallback };
  }
  const message = completed.message ?? null;
  const text = (message ?? "").toLowerCase();
  const frameStatus = typeof completed.status === "string"
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
 *
 * #11：若最后一条是 terminal（kept 等）则清零——该章已 escalate 人工；
 * 若最后一条 incomplete 则读 attemptCount。中间 incomplete→kept 覆盖后
 * attemptCount 不应被「只看最后一条非 incomplete 就 0」误伤到后续新 plan 项
 * （同一章再进 plan 是新一轮，0 正确）。
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
    // 同章最后一次已非 incomplete（kept/adopted/…）：计数清零
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
  // #6：signal abort 即终止 drain，禁止拿 partial content 跑 onDone 评估/写库。
  for await (const chunk of input.stream) {
    if (input.signal?.aborted) {
      throw new Error("repair drain aborted (signal)");
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
 * 每章墙钟硬超时：创建 AbortController，到点 abort + race 兜底抛错。
 * 防 provider silent-hang / transport 半开连接导致单章 await 永不返回卡死整卷。
 * 返回 { signal, race, dispose }。
 * - signal：透传 review/repair/polish，provider 感知终止
 * - race(fn)：相对**章级绝对 deadline** 剩余时间竞速；多步共享同一 deadline，
 *   不会在第一步 finally 里清掉 abort（旧实现每 race 清 abortTimer 会让链 repair 失保）
 * - dispose：章结束清理 abort 定时器（成功/失败都调）
 */
function createChapterTimeoutClock(deadlineMs: number, budgetMs: number): {
  signal: AbortSignal;
  race: <T>(fn: () => Promise<T>, stepLabel?: string) => Promise<T>;
  dispose: () => void;
} {
  const timeoutMs = Math.max(60_000, Math.min(deadlineMs, budgetMs));
  const startedAt = Date.now();
  const absoluteDeadline = startedAt + timeoutMs;
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  const dispose = (): void => {
    clearTimeout(abortTimer);
  };
  const race = async <T>(fn: () => Promise<T>, stepLabel?: string): Promise<T> => {
    if (controller.signal.aborted) {
      throw new Error(
        `readiness chapter step timeout${stepLabel ? `: ${stepLabel}` : ""} (already aborted)`,
      );
    }
    const remaining = Math.max(1, absoluteDeadline - Date.now());
    let gateTimer: ReturnType<typeof setTimeout> | null = null;
    const gate = new Promise<never>((_, reject) => {
      gateTimer = setTimeout(
        () => {
          controller.abort();
          reject(new Error(
            `readiness chapter step timeout after ${Math.round(timeoutMs / 1000)}s${stepLabel ? `: ${stepLabel}` : ""}`,
          ));
        },
        remaining,
      );
    });
    try {
      // 显式 Promise.race<T>：gate 是 Promise<never>，部分 TS 版本会把 race 结果 widen 成 unknown
      return await Promise.race<T>([fn(), gate]);
    } finally {
      if (gateTimer) {
        clearTimeout(gateTimer);
      }
    }
  };
  return { signal: controller.signal, race, dispose };
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

    // live：wall 已耗尽不得 claim/execute——否则第一圈就全量 budget_skipped 空转。
    // 须 resume + 抬 maxWallMinutes；auto-resume 侧也会跳过此类 planned。
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

    // live run：同 novel 单 flight（含同 runId 防双 execute）
    if (!initial.dryRun) {
      const claimed = tryClaimNovelRunFlight(initial.novelId, runId);
      if (!claimed) {
        // 同 run 已在 flight，或其它 live（running/planned）run 占 flight。
        // #4/#5：两种都返回当前 live run，**绝不标 failed**——sibling planned
        // 若被误杀成 failed，hydrate 不会把 failed 复活成 planned，run 永久死亡
        // 直到人工 resume。保持 planned 由下轮 auto-resume 接管。
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
      // #3：wallMsUsed 心跳落盘——旧实现只在章间刷，单章 hang 时快照停驻旧值，
      // 进程重启后 hydrate 判 wall 未耗尽 → auto-resume 原地复现同章 hang。心跳
      // 让 wall 真实推进，重启自愈。
      wallHeartbeatTimer = setInterval(() => {
        updateVolumeReadinessRun(runId, { wallMsUsed: wallUsedMs() });
      }, heartbeatMs);
      // M3：不拖住 process 优雅退出（Node 默认 interval 是 ref）
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
          // resume：不重复动作；不刷 already_done 除非 results 里缺该章（防御）
          actedChapterIds.add(planItem.chapterId);
          continue;
        }

        // 章前 re-assess：plan 快照可能过期（中途人工/上一轮已修好）
        // dryRun 保持 plan 原样便于预览；live 跳过已 publish_ready 的章，避免白烧 heavy。
        if (!initial.dryRun) {
          try {
            const preReport = await volumeReadinessService.assess(initial.novelId, {
              fromOrder: planItem.chapterOrder,
              toOrder: planItem.chapterOrder,
              refresh: false,
            });
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
            // re-assess 失败不阻断：按原 plan 继续
          }
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

        // #2：每章 AbortController + 墙钟硬超时 race。到点 abort，provider 感知
        // signal 尽快 settle；race 兜底抛错防止 signal 被 ignore 时 await 永不返回。
        // clock 在 try 外声明，catch 路径也能 dispose abort 定时器。
        let chapterClock: ReturnType<typeof createChapterTimeoutClock> | null = null;
        try {
          const remainingWallMs = Math.max(0, deadlineMs - wallUsedMs());
          if (remainingWallMs <= 0) {
            // wall 已耗尽：不当 budget_skipped 全章（外层 wall 检查兜底），直接抛触发 failed
            throw new Error("readiness chapter aborted: wall budget exhausted before step");
          }
          chapterClock = createChapterTimeoutClock(remainingWallMs, perChapterTimeoutMs);
          const clock = chapterClock;

          if (planItem.verdict === "needs_re_review") {
            // 心跳：章开始即刷 wall，避免 API 长时间 acted=0 像假死
            updateVolumeReadinessRun(runId, {
              llmCallsUsed,
              heavyRewritesUsed,
              chaptersActed,
              wallMsUsed: wallUsedMs(),
            });
            // readiness 热路径跳过阻塞 ledger sync（仍走真 dual-gate review）
            await clock.race(
              () => novelService.reviewChapter(initial.novelId, planItem.chapterId, {
                skipPayoffLedgerSync: true,
                signal: clock.signal,
              }),
              "reviewChapter",
            );
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
            const repairOptions: RepairOptions = { repairMode, signal: clock.signal };
            if (injectPadOnly) {
              const content = await loadChapterContent(planItem.chapterId);
              const padIssues = buildPadReviewIssuesFromContent(content);
              padIssueCount = padIssues.length;
              if (padIssues.length > 0) {
                repairOptions.reviewIssues = padIssues;
              }
            }

            updateVolumeReadinessRun(runId, {
              llmCallsUsed,
              heavyRewritesUsed,
              chaptersActed,
              wallMsUsed: wallUsedMs(),
            });
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
            await clock.race(
              () => novelService.runPipelineChapter(
                initial.novelId,
                planItem.chapterId,
                { runMode: "polish", signal: clock.signal },
              ),
              "runPipelineChapter(polish)",
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

          // I1：re-assess 也必须受章级 clock 约束——旧实现对 review/repair race
          // 后裸 await assess，DB/信号合成 hang 会卡死整卷且 abort timer 已
          // dispose 在 finally 清掉但 await 仍挂着。
          const report = await clock.race(
            () => volumeReadinessService.assess(initial.novelId, {
              fromOrder: planItem.chapterOrder,
              toOrder: planItem.chapterOrder,
              refresh: false,
            }),
            "assess",
          );
          const after = report.chapters.find((c) => c.chapterId === planItem.chapterId);
          verdictAfter = after?.verdict ?? null;

          // Part A：同章链式 re_review→repair
          // 真 review 后 verdict 落到 needs_heavy/needs_patch，且 actionFilter 允许 + 预算允许
          // → 立刻同章接入 repair 消化，避免每章只做一步、20 章仅 1 章 publish_ready 的空转。
          // 保留原 re_reviewed 结果的 pad 定向/预算/wall 判定，覆盖 outcome/message，再 re-assess。
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
              // pad 定向：复用主分支判定（light 且垫长为主、style/l0 已清）
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

              updateVolumeReadinessRun(runId, {
                llmCallsUsed,
                heavyRewritesUsed,
                chaptersActed,
                wallMsUsed: wallUsedMs(),
              });

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
              llmCallsUsed += chainEstimated;
              if (chainMode === "heavy_repair") {
                heavyRewritesUsed += 1;
              }
              const chainMapped = mapRepairOutcomeFromFrames(chainDrained.frames);
              // 链式动作覆盖 re_reviewed 结果；chaptersActed 不重复计数（同章）
              outcome = chainMapped.outcome;
              const chainSuffix = padIssueCountChain > 0
                ? ` padIssues=${padIssueCountChain}`
                : "";
              const chainMsg = chainMapped.message ? ` | ${chainMapped.message}` : "";
              message = `re_review→${chainMode}${chainSuffix}${chainMsg}`;

              // 链式后再 re-assess，取最终 verdictAfter；失败保守回退到链式前值
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
                // re-assess 失败不阻断链式结果
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
          // I2：assess 失败 / verdictAfter 空时 re_reviewed/polished 不得当终态——
          // getCompletedChapterIds 已不认 re_reviewed；此处再降 incomplete 可 resume。
          if (outcome === "re_reviewed" && verdictAfter == null) {
            outcome = "re_review_incomplete";
            message = `${message ?? "re_review"} → verdictAfter=null (assess missing)`;
          }
          if (outcome === "polished" && verdictAfter == null) {
            outcome = "polish_incomplete";
            message = `${message ?? "polish"} → verdictAfter=null (assess missing)`;
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
        } finally {
          chapterClock?.dispose();
          chapterClock = null;
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
