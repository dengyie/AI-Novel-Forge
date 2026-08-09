import type { DirectorAutoExecutionState } from "@ai-novel/shared/types/novelDirector";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { CONTRACT_REPLAN_WINDOW_MARKER } from "@ai-novel/shared/types/chapterTaskSheetQuality";
import { isStrictTransientTaskRetryError } from "../../../../llm/transportRetry";
import { getProviderModels } from "../../../../llm/modelCatalog";
import { isBuiltInProvider } from "../../../../llm/providers";
import { secretStore } from "../../../settings/secretStore";

/**
 * 瞬态模型/服务故障独立 fallback 预算上限（单本书 run 内最多换模重投次数）。
 * 与质量预算 qualityLoopLedger 完全分开：该预算只缓冲瞬时传输抖动（timeout/503/429/reset），
 * 不污染内容修复阶梯。耗尽或目录不可用后进入独立模型/服务熔断检查点，由用户切换模型后恢复。
 */
export const MAX_TRANSIENT_MODEL_FALLBACK = 3;

/**
 * 判定一次章节执行 job 失败是否为「瞬态模型/服务故障」（transport 类），而非质量门禁 / 用户取消。
 *
 * 复用任务级严格瞬时判据 isStrictTransientTaskRetryError（STRICT_TRANSIENT_TASK_RETRY_PATTERNS）：
 * - 只认真正的传输/限流信号：timeout / ECONNRESET / fetch failed / 502-504 / 429 / bad gateway 等；
 * - 显式取消与 timeout-driven abort 天然排除（取消不可重试）；
 * - SDK 反序列化兜底模式（"reading 'message'" 等确定性缺陷）不视为瞬态——那类重烧 token 不会自愈。
 */
export function isTransientModelFailure(
  message: string | null | undefined,
  jobStatus?: string | null,
): boolean {
  if (jobStatus !== "failed") {
    return false;
  }
  return isStrictTransientTaskRetryError(message ?? "");
}

/**
 * 为瞬态模型故障 fallback 解析本次重投要切换到的备用模型，实现真正的模型 failover。
 *
 * 从统一模型目录读取当前 provider 的真实可用模型，并排除本 run 已失败的目标。
 * 当前失败目标由 GenerationJob payload 提供；尝试集合随 autoExecution 持久化，
 * 因此服务重启后也不会循环烧同一模型。无新候选时返回 null，由调用方清掉旧
 * override 并进入独立模型/服务熔断检查点，不伪装成一次成功切模。
 *
 * 内置 provider 使用目录的内置 fallback；合法 custom provider 通过同一目录读取其
 * `/models`，无法读取或只有当前模型时返回 null，绝不硬造模型名。
 */
export interface TransientModelTarget {
  provider: LLMProvider;
  model: string;
}

function normalizeTarget(input: {
  provider?: LLMProvider | string | null;
  model?: string | null;
}): TransientModelTarget | null {
  const provider = typeof input.provider === "string" ? input.provider.trim() : "";
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!provider || !model) {
    return null;
  }
  return { provider: provider as LLMProvider, model };
}

export function mergeTransientModelAttemptedTargets(
  existing: DirectorAutoExecutionState["transientModelAttemptedTargets"],
  ...targets: Array<TransientModelTarget | null | undefined>
): TransientModelTarget[] {
  const merged: TransientModelTarget[] = [];
  const seen = new Set<string>();
  for (const target of [...(existing ?? []), ...targets]) {
    const normalized = normalizeTarget(target ?? {});
    if (!normalized) continue;
    const key = `${normalized.provider}\u0000${normalized.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
  }
  return merged.slice(-12);
}

export function resolveFailedPipelineModelTarget(input: {
  payloadProvider?: LLMProvider | string | null;
  payloadModel?: string | null;
  activeOverride?: TransientModelTarget | null;
  requestProvider?: LLMProvider | string | null;
  requestModel?: string | null;
}): TransientModelTarget | null {
  const payloadTarget = normalizeTarget({
    provider: input.payloadProvider,
    model: input.payloadModel,
  });
  if (payloadTarget) return payloadTarget;
  const overrideTarget = normalizeTarget(input.activeOverride ?? {});
  if (overrideTarget) return overrideTarget;
  return normalizeTarget({
    provider: input.requestProvider,
    model: input.requestModel,
  });
}

async function loadTransientFailoverModelCandidates(input: {
  provider: LLMProvider;
  currentModel: string;
}): Promise<string[]> {
  if (isBuiltInProvider(input.provider)) {
    return getProviderModels(input.provider, {
      allowAnonymous: false,
      fallbackModel: input.currentModel,
    });
  }
  const secret = await secretStore.getProvider(input.provider);
  if (!secret || !secret.isActive) {
    return [];
  }
  return getProviderModels(input.provider, {
    apiKey: secret.key ?? undefined,
    baseURL: secret.baseURL ?? undefined,
    allowAnonymous: true,
    fallbackModel: secret.model ?? input.currentModel,
    includeBuiltInFallback: false,
  });
}

export async function resolveTransientFallbackModel(input: {
  provider?: LLMProvider | string | null;
  currentModel?: string | null;
  attemptedTargets?: DirectorAutoExecutionState["transientModelAttemptedTargets"];
  /** Deterministic catalog seam for tests and owned callers that already loaded a catalog. */
  modelCandidates?: string[];
}): Promise<TransientModelTarget | null> {
  const current = normalizeTarget({ provider: input.provider, model: input.currentModel });
  if (!current) {
    return null;
  }
  let candidates: string[];
  try {
    candidates = input.modelCandidates ?? await loadTransientFailoverModelCandidates({
      provider: current.provider,
      currentModel: current.model,
    });
  } catch (error) {
    console.warn("[auto-director.failover] model catalog unavailable", {
      provider: current.provider,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  const attempted = new Set(
    mergeTransientModelAttemptedTargets(input.attemptedTargets)
      .map((target) => `${target.provider}\u0000${target.model}`),
  );
  for (const candidate of candidates) {
    const normalized = normalizeTarget({ provider: current.provider, model: candidate });
    if (!normalized || normalized.model === current.model) continue;
    if (attempted.has(`${normalized.provider}\u0000${normalized.model}`)) continue;
    return normalized;
  }
  return null;
}

/**
 * Length-risk markers that disqualify a review failure from being skippable.
 * A short chapter (字数 < target×0.6) must enter a quality checkpoint, never
 * be auto-skipped to the next chapter.
 */
const NON_SKIPPABLE_LENGTH_MARKERS = [
  "length_under_hard",
  "length_under_soft",
  "length_insufficient",
  "under_hard",
  "under_soft",
];

export function isSkippableAutoExecutionReviewFailure(message: string | null | undefined): boolean {
  const normalized = message?.trim() ?? "";
  if (!normalized.startsWith("Chapter generation is blocked until review is resolved.")) {
    return false;
  }
  // Defense-in-depth: even if the hold_for_review reason string carries length
  // risk markers, do not treat the failure as skippable.
  const lowered = normalized.toLowerCase();
  return !NON_SKIPPABLE_LENGTH_MARKERS.some((marker) => lowered.includes(marker));
}

/**
 * 章节执行合同门禁判 replan_window（职责过载）的失败。结构性难题本地再生成修不好，
 * 需整窗重排——失败处理器据此路由到 replanNovel 自动继续，而非终态停等人工。
 */
export function isContractReplanWindowFailure(message: string | null | undefined): boolean {
  const normalized = message?.trim() ?? "";
  return normalized.includes(CONTRACT_REPLAN_WINDOW_MARKER);
}

function formatAutoExecutionContinuation(input: Pick<
  DirectorAutoExecutionState,
  "remainingChapterCount" | "nextChapterOrder"
>): string {
  const remainingPart = typeof input.remainingChapterCount === "number"
    ? input.remainingChapterCount > 0
      ? `当前仍有 ${input.remainingChapterCount} 章待继续`
      : "当前已无待继续章节"
    : "当前仍有待继续章节";
  const nextPart = typeof input.nextChapterOrder === "number"
    ? `，系统会从第 ${input.nextChapterOrder} 章继续`
    : "，系统会从下一章继续";
  return `${remainingPart}${nextPart}。`;
}

function formatAutoExecutionActionLabel(
  autoExecution?: Pick<DirectorAutoExecutionState, "scopeLabel"> | null,
): string {
  const scopeLabel = autoExecution?.scopeLabel?.trim();
  return scopeLabel ? `继续自动执行${scopeLabel}` : "继续自动执行当前范围";
}

export function buildSkippableAutoExecutionReviewFailureSummary(
  autoExecution?: Pick<DirectorAutoExecutionState, "remainingChapterCount" | "nextChapterOrder" | "scopeLabel"> | null,
): string {
  return [
    "当前章因审核阻断而暂停，但这类问题允许跳过当前章继续执行。",
    `点击“${formatAutoExecutionActionLabel(autoExecution)}”后，系统会直接续跑剩余章节。`,
    formatAutoExecutionContinuation({
      remainingChapterCount: autoExecution?.remainingChapterCount,
      nextChapterOrder: autoExecution?.nextChapterOrder,
    }),
  ].join(" ");
}

export function buildSkippableAutoExecutionReviewCheckpointSummary(input: {
  scopeLabel: string;
  autoExecution?: Pick<DirectorAutoExecutionState, "remainingChapterCount" | "nextChapterOrder"> | null;
}): string {
  return [
    `${input.scopeLabel}已进入自动执行，但当前章因审核阻断而暂停。`,
    "这类问题允许跳过当前章继续执行。",
    formatAutoExecutionContinuation({
      remainingChapterCount: input.autoExecution?.remainingChapterCount,
      nextChapterOrder: input.autoExecution?.nextChapterOrder,
    }),
  ].join(" ");
}

export function buildSkippableAutoExecutionReviewBlockingReason(
  autoExecution?: Pick<DirectorAutoExecutionState, "nextChapterOrder" | "scopeLabel"> | null,
): string {
  const actionLabel = formatAutoExecutionActionLabel(autoExecution);
  if (typeof autoExecution?.nextChapterOrder === "number") {
    return `当前章因审核阻断而暂停，但这类问题允许跳过当前章继续执行。点击“${actionLabel}”后，系统会从第 ${autoExecution.nextChapterOrder} 章继续。`;
  }
  return `当前章因审核阻断而暂停，但这类问题允许跳过当前章继续执行。点击“${actionLabel}”后，系统会从下一章继续。`;
}

export function buildSkippableAutoExecutionReviewRecoveryHint(
  autoExecution?: Pick<DirectorAutoExecutionState, "nextChapterOrder" | "scopeLabel"> | null,
): string {
  const actionLabel = formatAutoExecutionActionLabel(autoExecution);
  if (typeof autoExecution?.nextChapterOrder === "number") {
    return `可直接点击“${actionLabel}”，系统会跳过当前审核阻断章并从第 ${autoExecution.nextChapterOrder} 章继续；如需修复当前章，再回到章节执行或质量修复处理。`;
  }
  return `可直接点击“${actionLabel}”，系统会跳过当前审核阻断章并从下一章继续；如需修复当前章，再回到章节执行或质量修复处理。`;
}
