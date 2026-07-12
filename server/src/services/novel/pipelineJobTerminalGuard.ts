import { isPipelineCancellationError } from "./pipelineJobAutoRetry";

/**
 * 调度层外层 catch：executePipeline 若在内层 try/catch 之外抛错（或内层终态写失败后仍冒泡），
 * 用当前 DB status 决定是否补写终态。返回 null = 不覆盖（已是终态或 intentional requeue）。
 *
 * 对 `queued` 一律不覆盖：auto-requeue 会把 job 写回 queued；默认 lease CAS 在调度入口
 * 已把 status 置 running，因此「仍 queued 却冒泡」主要是 requeue 成功路径，不应盖成 failed。
 * GENERATION_JOB_LEASE_ENABLED=false 且 execute 在写 running 前抛错的边角，仍依赖 resume/watchdog。
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
