import type { DirectorAutoExecutionState } from "@ai-novel/shared/types/novelDirector";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { CONTRACT_REPLAN_WINDOW_MARKER } from "@ai-novel/shared/types/chapterTaskSheetQuality";
import { isStrictTransientTaskRetryError } from "../../../../llm/transportRetry";
import { isBuiltInProvider, PROVIDERS } from "../../../../llm/providers";

/**
 * 瞬态模型/服务故障独立 fallback 预算上限（单本书 run 内最多换模重投次数）。
 * 与质量预算 qualityLoopLedger 完全分开：该预算只缓冲瞬时传输抖动（timeout/503/429/reset），
 * 不污染内容修复阶梯，也不累计熔断信号。耗尽后回落既有熔断/质量预算路径，持续故障由人工介入。
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
 * 从当前 provider 的可用模型列表里挑一个与本轮失败模型不同的候选，按
 * fallbackCount（已自增后的瞬态重投次数，>=1）从备用列表逐次取，保证连续多次
 * fallback 每次换的模型都不同。无可用候选（provider 未知 / 列表全同 / 超出
 * 列表长度）时返回 null，表示本次只能按原模型重试——预算耗尽后仍会回落既有
 * 熔断/质量预算路径，不会无限循环。
 *
 * 注意：部分 provider 的 models 列表自带跨厂商候选（如 openai 下列有
 * deepseek-v4-pro），同一 provider 内切换即可能绕过单一厂商故障；如需跨 provider
 * 切换，可在此扩展为从其他 provider 的 defaultModel 选取。
 */
export function resolveTransientFallbackModel(input: {
  provider?: LLMProvider | string | null;
  model?: string | null;
  fallbackCount: number;
}): { provider: LLMProvider; model: string } | null {
  if (!Number.isInteger(input.fallbackCount) || input.fallbackCount < 1) {
    return null;
  }
  const provider = input.provider;
  if (typeof provider !== "string" || !isBuiltInProvider(provider)) {
    return null;
  }
  const config = PROVIDERS[provider];
  const currentModel = input.model?.trim();
  const alternatives = config.models.filter((model) => model !== currentModel);
  const backupModel = alternatives[input.fallbackCount - 1];
  if (!backupModel) {
    return null;
  }
  return { provider, model: backupModel };
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
