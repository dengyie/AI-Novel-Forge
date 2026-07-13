import type { ZodType } from "zod";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { TaskType } from "./modelRouter";
import type { ModelRouteRequestProtocol } from "@ai-novel/shared/types/novel";
import {
  createLLMFromResolvedOptions,
  resolveLLMClientOptions,
  type ResolvedLLMClientOptions,
} from "./factory";
import { resolveModel, toStructuredOutputStrategy } from "./modelRouter";
import {
  buildStructuredResponseFormat,
  classifyStructuredOutputFailure,
  extractStructuredOutputErrorCategory,
  resolveStructuredOutputProfile,
  schemaAllowsTopLevelArray,
  selectStructuredOutputStrategy,
  StructuredOutputError,
  type StructuredOutputErrorCategory,
  type StructuredOutputProfile,
  type StructuredOutputStrategy,
} from "./structuredOutput";
import {
  getStructuredFallbackSettings,
  resolveStructuredFallbackChain,
} from "./structuredFallbackSettings";
import { extractLlmTokenUsage } from "./usageTracking";
import { runWithEnforcedTimeout } from "./invokeTimeout";
import {
  isCancellationLikeTransportError,
  isTransientTransportError,
  sleep,
  TRANSPORT_RETRY_BACKOFF_BASE_MS,
  TRANSPORT_RETRY_MAX_ATTEMPTS,
} from "./transportRetry";
import {
  buildStructuredError,
  logStructuredInvokeEvent,
  parseStructuredLlmRawContentDetailed,
  wrapStructuredInvokeError,
  type StructuredInvokeResult,
} from "./structuredInvokeParser";
import { extractMessageTextForStructuredOutput } from "./reasoning";
import type { PromptInvocationMeta } from "../prompting/core/promptTypes";

export {
  parseStructuredLlmRawContentDetailed,
  shouldUseJsonObjectResponseFormat,
  type StructuredInvokeRawParseInput,
  type StructuredInvokeResult,
} from "./structuredInvokeParser";

export {
  isCancellationLikeTransportError,
  isTransientTransportError,
  runWithTransportRetry,
  TRANSPORT_RETRY_MAX_ATTEMPTS,
  TRANSPORT_RETRY_BACKOFF_BASE_MS,
} from "./transportRetry";

/** Cancel/abort must not walk the multi-hop fallback chain. */
function shouldStopStructuredFallbackCascade(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  if (signal?.aborted) {
    return true;
  }
  return isCancellationLikeTransportError(error);
}

export interface StructuredInvokeInput<T> {
  systemPrompt?: string;
  userPrompt?: string;
  messages?: BaseMessage[];
  schema: ZodType<T>;
  provider?: LLMProvider;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  taskType?: TaskType;
  requestProtocol?: ModelRouteRequestProtocol;
  structuredStrategy?: StructuredOutputStrategy;
  label: string;
  maxRepairAttempts?: number;
  promptMeta?: PromptInvocationMeta;
  disableFallbackModel?: boolean;
}

interface StructuredAttemptTarget {
  provider: LLMProvider;
  model: string;
  apiKey?: string;
  baseURL?: string;
  temperature: number;
  maxTokens?: number;
  profile: StructuredOutputProfile;
  requestProtocol: ResolvedLLMClientOptions["requestProtocol"];
  preferredStrategy: StructuredOutputStrategy | null;
}

function buildInvokeMessages<T>(input: StructuredInvokeInput<T>): BaseMessage[] {
  if (Array.isArray(input.messages) && input.messages.length > 0) {
    return input.messages;
  }
  if (typeof input.systemPrompt === "string" && typeof input.userPrompt === "string") {
    return [new SystemMessage(input.systemPrompt), new HumanMessage(input.userPrompt)];
  }
  throw new Error(`[${input.label}] missing prompt messages.`);
}

function buildStrategySequence<T>(
  profile: StructuredOutputProfile,
  schema: ZodType<T>,
): StructuredOutputStrategy[] {
  const first = selectStructuredOutputStrategy(profile, schema);
  const sequence: StructuredOutputStrategy[] = [first];
  if (first === "json_schema" && profile.nativeJsonObject) {
    sequence.push("json_object");
  }
  if (first !== "prompt_json") {
    sequence.push("prompt_json");
  }
  return Array.from(new Set(sequence));
}

function computeAttemptTemperature(baseTemperature: number, strategyIndex: number): number {
  if (strategyIndex === 0) {
    return baseTemperature;
  }
  return Math.min(baseTemperature, 0.2);
}

async function resolveAttemptTarget(input: {
  provider?: LLMProvider;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  temperature?: number;
  maxTokens?: number;
  taskType?: TaskType;
  requestProtocol?: ModelRouteRequestProtocol;
  structuredStrategy?: StructuredOutputStrategy;
}): Promise<StructuredAttemptTarget> {
  const shouldResolveRoutePreference = Boolean(
    input.taskType
      && input.provider == null
      && input.model == null
      && input.structuredStrategy == null,
  );
  const route = shouldResolveRoutePreference ? await resolveModel(input.taskType!) : null;
  const resolved = await resolveLLMClientOptions(input.provider, {
    fallbackProvider: "deepseek",
    apiKey: input.apiKey,
    baseURL: input.baseURL,
    model: input.model,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    taskType: input.taskType ?? "planner",
    requestProtocol: input.requestProtocol,
    structuredStrategy: input.structuredStrategy,
    executionMode: "plain",
  });
  const preferredStrategy = input.structuredStrategy ?? (route
    && resolved.provider === route.provider
    && resolved.model === route.model
    ? toStructuredOutputStrategy(route.structuredResponseFormat)
    : null);
  return {
    provider: resolved.provider,
    model: resolved.model,
    apiKey: input.apiKey,
    baseURL: resolved.baseURL,
    temperature: resolved.temperature,
    maxTokens: resolved.maxTokens,
    requestProtocol: resolved.requestProtocol,
    preferredStrategy,
    profile: resolveStructuredOutputProfile({
      provider: resolved.provider,
      model: resolved.model,
      baseURL: resolved.baseURL,
      executionMode: "structured",
      requestProtocol: resolved.requestProtocol,
    }),
  };
}

async function invokeStructuredAttempt<T>(input: {
  baseInput: StructuredInvokeInput<T>;
  target: StructuredAttemptTarget;
  strategy: StructuredOutputStrategy;
  strategyIndex: number;
  fallbackAvailable: boolean;
  fallbackUsed: boolean;
}): Promise<StructuredInvokeResult<T>> {
  const attemptTemperature = computeAttemptTemperature(input.target.temperature, input.strategyIndex);
  const resolved = await resolveLLMClientOptions(input.target.provider, {
    fallbackProvider: "deepseek",
    apiKey: input.target.apiKey,
    baseURL: input.target.baseURL,
    model: input.target.model,
    temperature: attemptTemperature,
    maxTokens: input.target.maxTokens,
    timeoutMs: input.baseInput.timeoutMs,
    taskType: input.baseInput.taskType ?? "planner",
    promptMeta: input.baseInput.promptMeta,
    executionMode: "structured",
    structuredStrategy: input.strategy,
    requestProtocol: input.target.requestProtocol,
  });
  const llm = createLLMFromResolvedOptions(resolved);
  const invokeOptions: Record<string, unknown> = {};
  const responseFormat = buildStructuredResponseFormat({
    strategy: input.strategy,
    schema: input.baseInput.schema,
    label: input.baseInput.label,
  });
  if (responseFormat) {
    invokeOptions.response_format = responseFormat;
  }
  if (input.baseInput.signal) {
    invokeOptions.signal = input.baseInput.signal;
  }

  const messages = buildInvokeMessages(input.baseInput);
  logStructuredInvokeEvent({
    event: "invoke_start",
    label: input.baseInput.label,
    provider: resolved.provider,
    model: resolved.model,
    taskType: input.baseInput.taskType,
    strategy: input.strategy,
    fallbackUsed: input.fallbackUsed,
    reasoningForcedOff: resolved.reasoningForcedOff,
  });
  const startedAt = Date.now();
  try {
    const result = await runWithEnforcedTimeout({
      label: input.baseInput.label,
      timeoutMs: input.baseInput.timeoutMs,
      signal: input.baseInput.signal,
      run: (signal) => llm.invoke(
        messages,
        signal ? { ...invokeOptions, signal } : invokeOptions,
      ),
    });
    // Prefer message content; if empty (thinking models via CPA), fall back to reasoning_content JSON.
    const rawContent = extractMessageTextForStructuredOutput(result as {
      content?: unknown;
      additional_kwargs?: Record<string, unknown> | null;
      response_metadata?: Record<string, unknown> | null;
    });
    logStructuredInvokeEvent({
      event: "invoke_done",
      label: input.baseInput.label,
      provider: resolved.provider,
      model: resolved.model,
      taskType: input.baseInput.taskType,
      latencyMs: Date.now() - startedAt,
      rawChars: rawContent.length,
      strategy: input.strategy,
      fallbackUsed: input.fallbackUsed,
      reasoningForcedOff: resolved.reasoningForcedOff,
    });
    return parseStructuredLlmRawContentDetailed({
      rawContent,
      schema: input.baseInput.schema,
      tokenUsage: extractLlmTokenUsage(result),
      provider: resolved.provider,
      model: resolved.model,
      apiKey: input.target.apiKey,
      baseURL: resolved.baseURL,
      temperature: resolved.temperature,
      maxTokens: resolved.maxTokens,
      timeoutMs: input.baseInput.timeoutMs,
      signal: input.baseInput.signal,
      taskType: input.baseInput.taskType,
      requestProtocol: resolved.requestProtocol,
      label: input.baseInput.label,
      maxRepairAttempts: input.baseInput.maxRepairAttempts,
      promptMeta: input.baseInput.promptMeta,
      strategy: input.strategy,
      profile: resolved.structuredProfile ?? input.target.profile,
      fallbackAvailable: input.fallbackAvailable,
      fallbackUsed: input.fallbackUsed,
      reasoningForcedOff: resolved.reasoningForcedOff,
    });
  } catch (error) {
    const category = error instanceof StructuredOutputError
      ? error.category
      : classifyStructuredOutputFailure({ error });
    logStructuredInvokeEvent({
      event: "invoke_error",
      label: input.baseInput.label,
      provider: resolved.provider,
      model: resolved.model,
      taskType: input.baseInput.taskType,
      latencyMs: Date.now() - startedAt,
      strategy: input.strategy,
      errorCategory: category,
      fallbackUsed: input.fallbackUsed,
      reasoningForcedOff: resolved.reasoningForcedOff,
    });
    throw wrapStructuredInvokeError({
      label: input.baseInput.label,
      error,
      strategy: input.strategy,
      profile: resolved.structuredProfile ?? input.target.profile,
      reasoningForcedOff: resolved.reasoningForcedOff,
      fallbackAvailable: input.fallbackAvailable,
      fallbackUsed: input.fallbackUsed,
    });
  }
}

async function tryStructuredStrategies<T>(input: {
  baseInput: StructuredInvokeInput<T>;
  target: StructuredAttemptTarget;
  fallbackAvailable: boolean;
  fallbackUsed: boolean;
}): Promise<StructuredInvokeResult<T>> {
  const sequence = buildStrategySequence(input.target.profile, input.baseInput.schema);
  const preferredSequence = input.target.preferredStrategy
    ? [
      input.target.preferredStrategy,
      ...sequence.filter((strategy) => strategy !== input.target.preferredStrategy),
    ]
    : sequence;
  let lastError: StructuredOutputError | null = null;
  for (let index = 0; index < preferredSequence.length; index += 1) {
    const strategy = preferredSequence[index]!;
    // transport_error 为瞬时故障时同策略内有限重试吸收代理抖动/渠道切换。只重试
    // 确属瞬时的错误（isTransientTransportError），持续性错误直接 fast-fail，避免
    // 拖延。其它类别（schema_mismatch/malformed_json 等）与调用本身有关，不重试。
    const maxAttempts = TRANSPORT_RETRY_MAX_ATTEMPTS + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await invokeStructuredAttempt({
          baseInput: input.baseInput,
          target: input.target,
          strategy,
          strategyIndex: index,
          fallbackAvailable: input.fallbackAvailable,
          fallbackUsed: input.fallbackUsed,
        });
      } catch (error) {
        lastError = wrapStructuredInvokeError({
          label: input.baseInput.label,
          error,
          strategy,
          profile: input.target.profile,
          fallbackAvailable: input.fallbackAvailable,
          fallbackUsed: input.fallbackUsed,
        });
        const shouldRetry = lastError.category === "transport_error"
          && isTransientTransportError(error)
          && attempt < maxAttempts;
        if (!shouldRetry) {
          break;
        }
        const backoffMs = TRANSPORT_RETRY_BACKOFF_BASE_MS * attempt;
        await sleep(backoffMs, input.baseInput.signal);
      }
    }
    if (lastError?.category === "transport_error") {
      break;
    }
    if (lastError?.category === "schema_mismatch" && strategy === "prompt_json") {
      break;
    }
  }
  throw lastError ?? buildStructuredError({
    message: `[${input.baseInput.label}] Structured output failed.`,
    category: "transport_error",
    strategy: selectStructuredOutputStrategy(input.target.profile, input.baseInput.schema),
    profile: input.target.profile,
    fallbackAvailable: input.fallbackAvailable,
    fallbackUsed: input.fallbackUsed,
  });
}

export async function invokeStructuredLlmDetailed<T>(input: StructuredInvokeInput<T>): Promise<StructuredInvokeResult<T>> {
  const primaryTarget = await resolveAttemptTarget({
    provider: input.provider,
    model: input.model,
    apiKey: input.apiKey,
    baseURL: input.baseURL,
    temperature: input.temperature ?? 0.3,
    maxTokens: input.maxTokens,
    taskType: input.taskType ?? "planner",
    requestProtocol: input.requestProtocol,
    structuredStrategy: input.structuredStrategy,
  });
  const fallbackSettings = input.disableFallbackModel ? null : await getStructuredFallbackSettings();
  const fallbackChain = fallbackSettings
    ? resolveStructuredFallbackChain(fallbackSettings, {
      provider: primaryTarget.provider,
      model: primaryTarget.model,
    })
    : [];
  const fallbackAvailable = fallbackChain.length > 0;

  try {
    return await tryStructuredStrategies({
      baseInput: input,
      target: primaryTarget,
      fallbackAvailable,
      fallbackUsed: false,
    });
  } catch (primaryError) {
    if (!fallbackAvailable) {
      throw primaryError;
    }
    // User/job cancel: do not spend more CPA calls on the cascade.
    if (shouldStopStructuredFallbackCascade(primaryError, input.signal)) {
      throw primaryError;
    }

    // Multi-hop cascade: e.g. grok-4.5 → deepseek-v4-pro → deepseek-v4-flash.
    // Each hop runs the full structured strategy sequence; disable nested fallback.
    let lastError: unknown = primaryError;
    for (let hopIndex = 0; hopIndex < fallbackChain.length; hopIndex += 1) {
      if (shouldStopStructuredFallbackCascade(lastError, input.signal)) {
        throw lastError;
      }
      const hop = fallbackChain[hopIndex]!;
      const remainingAfterThisHop = hopIndex < fallbackChain.length - 1;
      try {
        const fallbackTarget = await resolveAttemptTarget({
          provider: hop.provider,
          model: hop.model,
          temperature: hop.temperature,
          maxTokens: hop.maxTokens ?? undefined,
          taskType: input.taskType ?? "planner",
        });
        return await tryStructuredStrategies({
          baseInput: {
            ...input,
            provider: fallbackTarget.provider,
            model: fallbackTarget.model,
            temperature: fallbackTarget.temperature,
            maxTokens: fallbackTarget.maxTokens,
            disableFallbackModel: true,
          },
          target: fallbackTarget,
          fallbackAvailable: remainingAfterThisHop,
          fallbackUsed: true,
        });
      } catch (fallbackError) {
        // Prefer the hop error (including non-SOE config failures) for diagnostics.
        lastError = fallbackError;
        if (shouldStopStructuredFallbackCascade(fallbackError, input.signal)) {
          throw fallbackError;
        }
        // continue to next hop
      }
    }
    throw lastError instanceof Error ? lastError : primaryError;
  }
}

export async function invokeStructuredLlm<T>(input: StructuredInvokeInput<T>): Promise<T> {
  const result = await invokeStructuredLlmDetailed(input);
  return result.data;
}

export function summarizeStructuredOutputFailure(input: {
  error: unknown;
  fallbackAvailable?: boolean;
}): {
  category: StructuredOutputErrorCategory;
  failureCode: string;
  summary: string;
} {
  const message = input.error instanceof Error ? input.error.message : String(input.error ?? "");
  const category = input.error instanceof StructuredOutputError
    ? input.error.category
    : extractStructuredOutputErrorCategory(message) ?? classifyStructuredOutputFailure({ error: input.error });
  const suffix = input.fallbackAvailable ? "，可考虑启用结构化备用模型。" : "。";
  const incompleteJsonSummary = input.fallbackAvailable
    ? "模型输出的 JSON 被截断或不完整，可能是输出被截断或 token 上限不足；建议先重试，必要时切换更强模型或启用结构化备用模型。"
    : "模型输出的 JSON 被截断或不完整，可能是输出被截断或 token 上限不足；建议先重试，必要时切换更强模型。";
  const summaryMap: Record<StructuredOutputErrorCategory, string> = {
    unsupported_native_json: `当前模型端点不兼容原生 JSON 输出${suffix}`,
    thinking_pollution: `当前模型的思考内容污染了结构化输出${suffix}`,
    incomplete_json: incompleteJsonSummary,
    malformed_json: `模型输出的 JSON 格式不稳定${suffix}`,
    schema_mismatch: `模型输出未满足目标结构要求${suffix}`,
    transport_error: `结构化调用过程发生传输或服务端错误${suffix}`,
  };
  return {
    category,
    failureCode: `STRUCTURED_OUTPUT_${category.toUpperCase()}`,
    summary: summaryMap[category],
  };
}

export { schemaAllowsTopLevelArray };
