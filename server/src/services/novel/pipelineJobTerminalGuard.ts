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

/**
 * 成功终写（succeeded）的 CAS：仅当仍 running 且未请求取消才覆盖。
 *
 * 为什么 success 路径也要 CAS：章循环退出后到 `updateJobSafe(status:"succeeded")` 之间
 * 仍有 read→write 窗口——若并发 cancel 在最后一章结果落地后、终写前打入（心跳间隙轮询
 * 把 chapterAbort abort 掉但终写仍走成功分支），直写会盖掉 cancelRequestedAt 并把行
 * 写成 succeeded，使取消请求被静默吞掉。和 auto-requeue 同一套谓词语义：count=0 即视为
 * 并发已把 job 推离 running 或已请求取消，调用方应改走 cancelled 收口。
 *
 * `leaseOwner` 可选（GENERATION_JOB_LEASE_ENABLED=false 或本进程未持租约时传 null）：
 * 传入 owner 时另加 leaseOwner 等值判定；空字符串等价于「不校验」，保持旧路径兼容。
 */
export function buildPipelineJobSuccessTerminalCasWhere(jobId: string, leaseOwner?: string | null): {
  id: string;
  status: "running";
  cancelRequestedAt: null;
  leaseOwner?: string;
} {
  const base = {
    id: jobId,
    status: "running" as const,
    cancelRequestedAt: null,
  };
  if (leaseOwner) {
    return { ...base, leaseOwner };
  }
  return base;
}

/**
 * 心跳/进度/finalizing 等非终态 job 行写入的 CAS 谓词：附带 leaseOwner 等值判定。
 *
 * 为什么必要：`schedulePipelineExecution` 用 `pipeline-${pid}` CAS 认领了 leaseOwner，
 * 但若旧进程（crash 前的残留 event loop）仍持有 `setInterval` 心跳，就会持续覆盖
 * `leaseExpiresAt` 让新 owner 的租约被旧进程无声续命；进度字段也会被旧进程回卷。
 * 加 leaseOwner 到心跳/进度 updateMany 的 where 里，updateMany count=0 → 本进程已丢
 * 租约（另一进程已认领），调用方应立即抛 `PIPELINE_LEASE_LOST` sentinel 早退。
 *
 * leaseOwner 传 null（lease disabled 分支）：`status:"running"` 守卫保留——它把
 * 「并发已离开 running（多半是 cancel）」的 updateMany 命中为 count=0。此时语义不是
 * 「别的进程抢了租约」（lease 下关无 owner 概念），调用方应按 {@link classifyNonTerminalCasMiss}
 * 判定为 cancel 收口，而非误报 lease-lost 静默早退（否则会跳过 cancel 收尾、留孤儿 finalizing）。
 */
export function buildPipelineJobLeaseOwnedCasWhere(jobId: string, leaseOwner: string | null): {
  id: string;
  status: "running";
  leaseOwner?: string;
} {
  const base = {
    id: jobId,
    status: "running" as const,
  };
  if (leaseOwner) {
    return { ...base, leaseOwner };
  }
  return base;
}

/**
 * 非终态 job 行 updateMany 命中 count=0 的归因：
 *   - leaseOwner 非空（lease enabled）→ 另一进程已认领，判 lease-lost（静默早退，不盖终态）。
 *   - leaseOwner 为空（lease disabled）→ 本进程所在世界无第二进程，count=0 只能是并发已离开
 *     running（cancel/requeue/兜底终态化），判 cancel 收口（throw PIPELINE_CANCELLED），
 *     走 outer catch cancelled 分支补完终态与 pipeline:completed 事件，不留孤儿。
 */
export function classifyNonTerminalCasMiss(leaseOwner: string | null): {
  sentinel: "lease-lost" | "cancel";
} {
  return leaseOwner
    ? { sentinel: "lease-lost" }
    : { sentinel: "cancel" };
}

/**
 * 本进程丢租约的 sentinel 消息。outer catch 识别到此消息应立即早退：另一进程已认领并接管，
 * 本进程不得再写 failed/cancelled/queued 终态（会盖对方合法的 running/进度）。
 *
 * 语义与 PIPELINE_CANCELLED 明确区分：cancel 由用户/API 触发要落 cancelled；lease-lost
 * 是本进程被"顶替"，不写任何终态，直接静默退出。
 */
export const PIPELINE_LEASE_LOST_MESSAGE = "PIPELINE_LEASE_LOST";

export function isPipelineLeaseLostError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message === PIPELINE_LEASE_LOST_MESSAGE
    || message.includes(PIPELINE_LEASE_LOST_MESSAGE);
}
