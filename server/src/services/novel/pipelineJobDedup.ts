import type { Prisma } from "@prisma/client";

export interface ActivePipelineJobCandidate {
  id: string;
  completedCount: number | null;
  progress: number | null;
}

function normalizeMetric(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * 构造"可恢复的僵尸流水线任务"查询谓词。心跳超时用 cutoff（now - staleThreshold），
 * 但持久化租约到期直接用 now：leaseExpiresAt 写入时已含 TTL 宽限（PIPELINE_LEASE_TTL_MS），
 * 不能再减一次 staleThreshold，否则租约分支恒晚于心跳分支触发、永远沦为冗余。
 *
 * 与 listRecoverablePipelineJobs 的基线一致（queued|running ∧ ¬manual ∧ 未终态 ∧ 未取消），
 * 额外要求心跳/租约过期。auto-requeue 后的 queued（payload.jobTransportAutoRetryCount>0、
 * heartbeat/lease 已清）在 updatedAt/heartbeat 过期后会被本 where 拾起；进程重启则走
 * listRecoverable 全量拾起，不必等 stale。见 pipelineJobAutoRetry 契约注释。
 */
export function buildStaleRecoverablePipelineJobWhere(input: {
  cutoff: Date;
  now: Date;
}): Prisma.GenerationJobWhereInput {
  return {
    status: { in: ["queued", "running"] },
    pendingManualRecovery: false,
    finishedAt: null,
    cancelRequestedAt: null,
    OR: [
      { heartbeatAt: { lt: input.cutoff } },
      { heartbeatAt: null, updatedAt: { lt: input.cutoff } },
      { leaseExpiresAt: { lt: input.now } },
    ],
  };
}

/**
 * 构造租约 CAS 认领谓词：仅当任务处于 queued/running、未请求取消、且租约为空或已过期时可认领。
 * 与 updateMany 的 count===1 判定配合实现跨进程原子去重（respawn 后新实例与旧实例残留）。
 */
export function buildPipelineLeaseClaimWhere(input: {
  jobId: string;
  now: Date;
}): Prisma.GenerationJobWhereInput {
  return {
    id: input.jobId,
    status: { in: ["queued", "running"] },
    cancelRequestedAt: null,
    OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: input.now } }],
  };
}

export function selectPrimaryPipelineJob<T extends ActivePipelineJobCandidate>(
  jobs: T[],
  preferredJobId?: string | null,
): T {
  const bestJob = jobs[0];
  if (!preferredJobId) {
    return bestJob;
  }

  const preferredJob = jobs.find((job) => job.id === preferredJobId);
  if (!preferredJob) {
    return bestJob;
  }
  if (preferredJob.id === bestJob.id) {
    return preferredJob;
  }

  const preferredCompleted = normalizeMetric(preferredJob.completedCount);
  const bestCompleted = normalizeMetric(bestJob.completedCount);
  const preferredProgress = normalizeMetric(preferredJob.progress);
  const bestProgress = normalizeMetric(bestJob.progress);

  if (preferredCompleted === bestCompleted && preferredProgress === bestProgress) {
    return preferredJob;
  }
  return bestJob;
}
