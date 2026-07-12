import { isPipelineCancellationError } from "./pipelineJobAutoRetry";

/**
 * 调度层外层 catch：executePipeline 若在内层 try/catch 之外抛错（或内层终态写失败后仍冒泡），
 * 用当前 DB status 决定是否补写终态。返回 null = 不覆盖（已是终态或 intentional requeue）。
 *
 * 对 `queued` 一律不覆盖：auto-requeue 会把 job 写回 queued；默认 lease CAS 在调度入口
 * 已把 status 置 running，因此「仍 queued 却冒泡」主要是 requeue 成功路径，不应盖成 failed。
 * GENERATION_JOB_LEASE_ENABLED=false 且 execute 在写 running 前抛错的边角，仍依赖 resume/watchdog。
 *
 * 真正写库时必须配合 {@link buildUnhandledPipelineFailureTerminalCasWhere}：
 * 仅 status=running 可被覆盖，避免 read→write 窗口内 requeue/cancel 被盖回 failed。
 */
export function resolveUnhandledPipelineFailureTerminalUpdate(input: {
  status: string | null | undefined;
  cancelRequestedAt?: Date | string | null;
  error: unknown;
}): { status: "failed" | "cancelled"; error: string | null } | null {
  const status = input.status ?? "";
  // succeeded / failed / cancelled：已终态
  // queued：auto-requeue 故意回排队，禁止外层再盖成 failed
  if (
    status === "succeeded"
    || status === "failed"
    || status === "cancelled"
    || status === "queued"
  ) {
    return null;
  }

  if (input.cancelRequestedAt || isPipelineCancellationError(input.error)) {
    return { status: "cancelled", error: null };
  }

  const raw = input.error instanceof Error
    ? input.error.message
    : input.error == null
      ? ""
      : String(input.error);
  const message = raw.trim() || "流水线执行异常（调度兜底）";
  return { status: "failed", error: message };
}

/**
 * 调度兜底终态写库 CAS 谓词：只允许覆盖仍为 running 的行。
 * 与 resolve 配套；updateMany count=0 表示并发已离开 running，应跳过。
 */
export function buildUnhandledPipelineFailureTerminalCasWhere(jobId: string): {
  id: string;
  status: "running";
} {
  return {
    id: jobId,
    status: "running",
  };
}

/**
 * auto-requeue 写回 queued 的 CAS：必须仍 running 且未请求取消。
 * 避免 cancel 竞态下把 cancelRequestedAt 清掉并再次排队。
 */
export function buildPipelineJobAutoRequeueCasWhere(jobId: string): {
  id: string;
  status: "running";
  cancelRequestedAt: null;
} {
  return {
    id: jobId,
    status: "running",
    cancelRequestedAt: null,
  };
}
