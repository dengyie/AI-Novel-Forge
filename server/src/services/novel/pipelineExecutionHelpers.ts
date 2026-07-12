import type { ChapterQualityLoopAssessment } from "@ai-novel/shared/types/chapterQualityLoop";
import type { Prisma } from "@prisma/client";
import { logPipelineWarn } from "./novelCoreShared";

/** 心跳间隔：写 lease/heartbeat 与取消轮询。 */
export const PIPELINE_HEARTBEAT_INTERVAL_MS = 15000;
// 持久化租约 TTL：watchdog 走 180s stale 阈值，心跳 15s 一次 → TTL 取 300s（stale 阈值的
// 1.67 倍）保证活体 lease 不会被误判过期；持有者死、心跳停止后 5 分钟内 watchdog 接管。
export const PIPELINE_LEASE_TTL_MS = 300_000;

const TERMINAL_CONTINUE_QUALITY_LOOP_RISK_FLAG_FRAGMENT = '"terminalAction":"defer_and_continue"';
const REPLAN_REQUIRED_QUALITY_LOOP_RISK_FLAG_FRAGMENT = '"rootCauseCode":"replan_required"';
const REPLAN_ACTION_QUALITY_LOOP_RISK_FLAG_FRAGMENT = '"recommendedAction":"replan"';

/** P2-5：GENERATION_JOB_LEASE_ENABLED=false 进程内只告警一次，避免每 job 刷屏。 */
let generationJobLeaseDisabledWarned = false;

/**
 * 生产默认必须开 lease。=false 时仅内存 activeJobIds，跨进程/respawn 可双跑同 job。
 * 仅允许短时 hot-fix 回退；禁止无文档常关。
 */
export function warnGenerationJobLeaseDisabledOnce(): void {
  if (generationJobLeaseDisabledWarned) {
    return;
  }
  generationJobLeaseDisabledWarned = true;
  logPipelineWarn("GENERATION_JOB_LEASE_ENABLED=false：已关闭 DB 租约 CAS，仅内存 activeJobIds 去重（危）", {
    risk: "cross_process_double_run",
    guidance: "生产应保持默认开启；仅 short-lived hot-fix 回退，恢复后立刻去掉该 env",
    env: "GENERATION_JOB_LEASE_ENABLED",
  });
}

/** 单测重置 lease warn 闸；生产勿用。 */
export function resetGenerationJobLeaseDisabledWarnForTests(): void {
  generationJobLeaseDisabledWarned = false;
}

export function clampPipelineMaxRetries(value: number | null | undefined): number {
  return Math.max(0, Math.min(value ?? 1, 1));
}

export function buildEmptyChapterDetail(chapter: { order: number; title: string }): string {
  return `第${chapter.order}章「${chapter.title}」正文生成失败：模型连续未返回可保存正文，已暂停继续。`;
}

/** 熔断内存行：把 assessment 压成 riskFlags JSON，供 isBlockingReplanQualityDebt 读取。 */
export function buildQualityLoopRiskFlagsSnapshot(
  assessment: ChapterQualityLoopAssessment,
  source: "pipeline_review" | "repair_recheck",
  terminalAction?: "defer_and_continue" | null,
): string {
  return JSON.stringify({
    qualityLoop: {
      ...assessment,
      source,
      ...(terminalAction ? { terminalAction } : {}),
    },
  });
}

/**
 * skipCompleted 查询谓词：跳过已完成 / approved / 已 defer_and_continue 且无 replan 标记的章。
 * 与导演「有正文+无 blocking 债可推进」口径相关，改片段须同步测试。
 */
export function buildSkipCompletedChapterWhere(): Prisma.ChapterWhereInput {
  return {
    NOT: {
      AND: [
        { content: { not: null } },
        { content: { not: "" } },
        {
          OR: [
            { generationState: { in: ["approved", "published"] } },
            { chapterStatus: "completed" },
            {
              AND: [
                { riskFlags: { not: null } },
                { riskFlags: { contains: TERMINAL_CONTINUE_QUALITY_LOOP_RISK_FLAG_FRAGMENT } },
                { riskFlags: { not: { contains: REPLAN_REQUIRED_QUALITY_LOOP_RISK_FLAG_FRAGMENT } } },
                { riskFlags: { not: { contains: REPLAN_ACTION_QUALITY_LOOP_RISK_FLAG_FRAGMENT } } },
              ],
            },
          ],
        },
      ],
    },
  };
}
