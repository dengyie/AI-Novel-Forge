import type { BaseMessage } from "@langchain/core/messages";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { LlmTokenUsageSnapshot } from "../../llm/usageTracking";
import { toText } from "../../services/novel/novelP0Utils";
import {
  recordPromptQualityEvent,
  type PromptQualityFailureKind,
} from "../core/promptQualityTelemetry";
import type {
  PromptAsset,
  PromptInvocationMeta,
  PromptRenderContext,
  PromptRunResult,
} from "../core/promptTypes";
import { safeJsonStringify, stringifyPromptError } from "../validation/PromptPostValidation";

export function estimateRenderedPromptChars(messages: BaseMessage[]): number {
  return messages.reduce((sum, message) => sum + toText(message.content).length, 0);
}

function estimateOutputChars(output: unknown): number {
  return typeof output === "string" ? output.length : safeJsonStringify(output).length;
}

function classifyPromptQualityFailure(error: unknown): PromptQualityFailureKind {
  const marked = error as { promptQualityFailureKind?: unknown };
  if (
    marked
    && typeof marked === "object"
    && [
      "llm_error",
      "schema_repair_failed",
      "post_validate_failed",
      "empty_output",
      "unknown",
    ].includes(String(marked.promptQualityFailureKind))
  ) {
    return marked.promptQualityFailureKind as PromptQualityFailureKind;
  }
  const message = stringifyPromptError(error).toLowerCase();
  if (message.includes("schema") || message.includes("json") || message.includes("zod") || message.includes("structured")) {
    return "schema_repair_failed";
  }
  if (message.includes("postvalidate") || message.includes("semantic")) {
    return "post_validate_failed";
  }
  return "llm_error";
}

function logPromptCompletion(input: {
  meta: PromptInvocationMeta;
  provider?: LLMProvider;
  model?: string;
  latencyMs: number;
}): void {
  console.info([
    "[prompt.runner]",
    `promptId=${input.meta.promptId}`,
    `promptVersion=${input.meta.promptVersion}`,
    `taskType=${input.meta.taskType}`,
    input.meta.novelId ? `novelId=${input.meta.novelId}` : "",
    input.meta.chapterId ? `chapterId=${input.meta.chapterId}` : "",
    input.meta.stage ? `stage=${input.meta.stage}` : "",
    typeof input.meta.sceneIndex === "number" ? `sceneIndex=${input.meta.sceneIndex}` : "",
    typeof input.meta.roundIndex === "number" ? `roundIndex=${input.meta.roundIndex}` : "",
    input.meta.triggerReason ? `triggerReason=${JSON.stringify(input.meta.triggerReason)}` : "",
    `contextBlockIds=${input.meta.contextBlockIds.join(",") || "none"}`,
    `droppedContextBlockIds=${input.meta.droppedContextBlockIds.join(",") || "none"}`,
    `summarizedContextBlockIds=${input.meta.summarizedContextBlockIds.join(",") || "none"}`,
    `estimatedInputTokens=${input.meta.estimatedInputTokens}`,
    `repairUsed=${input.meta.repairUsed}`,
    `repairAttempts=${input.meta.repairAttempts}`,
    `semanticRetryUsed=${input.meta.semanticRetryUsed}`,
    `semanticRetryAttempts=${input.meta.semanticRetryAttempts}`,
    `provider=${input.provider ?? "default"}`,
    `model=${input.model ?? "default"}`,
    `latencyMs=${input.latencyMs}`,
  ].join(" "));
}

export function logPromptEvent(input: {
  event: string;
  asset: PromptAsset<unknown, unknown, unknown>;
  context: PromptRenderContext;
  provider?: LLMProvider;
  model?: string;
  attempt?: number;
  validationError?: string;
}): void {
  console.info([
    "[prompt.runner]",
    `event=${input.event}`,
    `promptId=${input.asset.id}`,
    `promptVersion=${input.asset.version}`,
    `taskType=${input.asset.taskType}`,
    `contextBlockIds=${input.context.selectedBlockIds.join(",") || "none"}`,
    `estimatedInputTokens=${input.context.estimatedInputTokens}`,
    `provider=${input.provider ?? "default"}`,
    `model=${input.model ?? "default"}`,
    typeof input.attempt === "number" ? `attempt=${input.attempt}` : "",
    input.validationError ? `validationError=${JSON.stringify(input.validationError.slice(0, 240))}` : "",
  ].filter(Boolean).join(" "));
}

export function recordPromptFailure(input: {
  asset: PromptAsset<unknown, unknown, unknown>;
  context: PromptRenderContext;
  invocation: PromptInvocationMeta;
  provider?: LLMProvider;
  model?: string;
  latencyMs: number;
  renderedPromptChars?: number;
  error: unknown;
}): void {
  recordPromptQualityEvent({
    event: "failed",
    promptId: input.asset.id,
    promptVersion: input.asset.version,
    taskType: input.asset.taskType,
    mode: input.asset.mode,
    provider: input.provider,
    model: input.model,
    stage: input.invocation.stage,
    entrypoint: input.invocation.entrypoint,
    latencyMs: input.latencyMs,
    estimatedInputTokens: input.context.estimatedInputTokens,
    renderedPromptChars: input.renderedPromptChars,
    repairUsed: input.invocation.repairUsed,
    repairAttempts: input.invocation.repairAttempts,
    semanticRetryUsed: input.invocation.semanticRetryUsed,
    semanticRetryAttempts: input.invocation.semanticRetryAttempts,
    failureKind: classifyPromptQualityFailure(input.error),
  });
}

export function buildPromptRunResult<T>(input: {
  asset: PromptAsset<unknown, unknown, unknown>;
  output: T;
  context: PromptRenderContext;
  provider?: LLMProvider;
  model?: string;
  latencyMs: number;
  invocation: PromptInvocationMeta;
  renderedPromptChars?: number;
  tokenUsage?: LlmTokenUsageSnapshot | null;
  postValidateFailureRecovered?: boolean;
}): PromptRunResult<T> {
  const meta = {
    provider: input.provider,
    model: input.model,
    latencyMs: input.latencyMs,
    invocation: input.invocation,
    tokenUsage: input.tokenUsage ?? null,
  };
  logPromptCompletion({
    meta: input.invocation,
    provider: meta.provider,
    model: meta.model,
    latencyMs: meta.latencyMs,
  });
  recordPromptQualityEvent({
    event: "completed",
    promptId: input.asset.id,
    promptVersion: input.asset.version,
    taskType: input.asset.taskType,
    mode: input.asset.mode,
    provider: meta.provider,
    model: meta.model,
    stage: input.invocation.stage,
    entrypoint: input.invocation.entrypoint,
    latencyMs: meta.latencyMs,
    estimatedInputTokens: input.context.estimatedInputTokens,
    renderedPromptChars: input.renderedPromptChars,
    outputChars: estimateOutputChars(input.output),
    repairUsed: input.invocation.repairUsed,
    repairAttempts: input.invocation.repairAttempts,
    semanticRetryUsed: input.invocation.semanticRetryUsed,
    semanticRetryAttempts: input.invocation.semanticRetryAttempts,
    postValidateFailureRecovered: input.postValidateFailureRecovered,
    emptyOutput: typeof input.output === "string" && input.output.trim().length === 0,
    tokenUsage: input.tokenUsage,
  });
  return { output: input.output, meta, context: input.context };
}
