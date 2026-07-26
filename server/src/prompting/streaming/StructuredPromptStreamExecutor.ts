import type { BaseMessageChunk } from "@langchain/core/messages";
import { getResolvedLLMClientOptionsFromInstance, type getLLM } from "../../llm/factory";
import { resolveEnforcedTimeoutMs, runWithEnforcedTimeout } from "../../llm/invokeTimeout";
import { beginLlmLiveSession, safeLiveCall } from "../../llm/live/llmLiveSession";
import {
  buildStructuredResponseFormat,
  resolveStructuredOutputProfile,
  selectStructuredOutputStrategy,
} from "../../llm/structuredOutput";
import { parseStructuredLlmRawContentDetailed, type invokeStructuredLlmDetailed } from "../../llm/structuredInvoke";
import { runWithTransportRetry } from "../../llm/transportRetry";
import type { PromptAsset, PromptExecutionOptions, PromptStreamRunResult } from "../core/promptTypes";
import {
  preparePromptExecution,
  resolvePromptOverlaysForAsset,
  resolveStructuredRepairAttempts,
  type PromptContextBlocks,
} from "../execution/PromptExecutionPreparation";
import {
  buildPromptRunResult,
  estimateRenderedPromptChars,
  recordPromptFailure,
} from "../observability/PromptExecutionRecorder";
import { resolveStructuredOutput } from "../validation/StructuredOutputResolution";
import { capturePromptStream } from "./PromptStreamCapture";

export type PromptRunnerLLMFactory = typeof getLLM;
export type PromptRunnerStructuredInvoker = typeof invokeStructuredLlmDetailed;

export async function executeStructuredPromptStream<I, O, R = O>(input: {
  asset: PromptAsset<I, O, R>;
  promptInput: I;
  contextBlocks?: PromptContextBlocks;
  options?: PromptExecutionOptions;
  llmFactory: PromptRunnerLLMFactory;
  structuredInvoker: PromptRunnerStructuredInvoker;
}): Promise<PromptStreamRunResult<O>> {
  if (input.asset.mode !== "structured" || !input.asset.outputSchema) {
    throw new Error(`Prompt asset ${input.asset.id}@${input.asset.version} is not a structured prompt.`);
  }

  const outputSchema = input.asset.outputSchema;
  const overlays = await resolvePromptOverlaysForAsset({
    asset: input.asset as PromptAsset<unknown, unknown, unknown>,
    contextBlocks: input.contextBlocks,
    options: input.options,
  });
  const prepared = preparePromptExecution({
    ...input,
    contextBlocks: overlays.blocks,
    resolvedSlots: overlays.resolvedSlots,
  });
  const startedAt = Date.now();
  const renderedPromptChars = estimateRenderedPromptChars(prepared.messages);
  let captured: ReturnType<typeof capturePromptStream>;
  let strategy!: ReturnType<typeof selectStructuredOutputStrategy>;
  let profile!: ReturnType<typeof resolveStructuredOutputProfile>;
  const liveSession = beginLlmLiveSession({
    label: `${input.asset.id}@${input.asset.version}`,
    mode: "structured",
    promptMeta: prepared.invocation,
    provider: input.options?.provider,
    model: input.options?.model,
  });
  safeLiveCall(() => liveSession.phase("requesting", "正在连接模型"));
  try {
    const llm = await input.llmFactory(input.options?.provider, {
      fallbackProvider: "deepseek",
      model: input.options?.model,
      temperature: input.options?.temperature,
      maxTokens: input.options?.maxTokens,
      timeoutMs: input.options?.timeoutMs,
      taskType: input.asset.taskType,
      promptMeta: prepared.invocation,
      executionMode: "structured",
    });
    const resolvedLLM = getResolvedLLMClientOptionsFromInstance(llm);
    profile = resolvedLLM?.structuredProfile ?? resolveStructuredOutputProfile({
      provider: resolvedLLM?.provider ?? input.options?.provider ?? "deepseek",
      model: resolvedLLM?.model ?? input.options?.model,
      baseURL: resolvedLLM?.baseURL,
      requestProtocol: resolvedLLM?.requestProtocol,
      executionMode: "structured",
    });
    strategy = resolvedLLM?.structuredStrategy ?? selectStructuredOutputStrategy(profile, outputSchema);
    const invokeOptions: Record<string, unknown> = {};
    const responseFormat = buildStructuredResponseFormat({
      strategy,
      schema: outputSchema,
      label: `${input.asset.id}@${input.asset.version}`,
    });
    if (responseFormat) invokeOptions.response_format = responseFormat;
    if (input.options?.signal) invokeOptions.signal = input.options.signal;
    const streamLabel = `${input.asset.id}@${input.asset.version}`;
    const streamBudgetMs = resolveEnforcedTimeoutMs(input.options?.timeoutMs);
    const streamDeadlineAt = Date.now() + streamBudgetMs;
    const rawStream = await runWithTransportRetry(
      () => runWithEnforcedTimeout({
        label: streamLabel,
        timeoutMs: Math.max(1, streamDeadlineAt - Date.now()),
        signal: input.options?.signal,
        run: (signal) => llm.stream(
          prepared.messages,
          signal ? { ...invokeOptions, signal } : invokeOptions,
        ),
      }),
      {
        signal: input.options?.signal,
        label: streamLabel,
        onRetry: ({ attempt, maxAttempts, error, backoffMs }) => {
          console.warn("[prompt-runner] structured stream establish transport retry", {
            label: streamLabel,
            attempt,
            maxAttempts,
            backoffMs,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      },
    );
    captured = capturePromptStream(rawStream as AsyncIterable<BaseMessageChunk>, {
      label: streamLabel,
      timeoutMs: streamBudgetMs,
      deadlineAt: streamDeadlineAt,
      signal: input.options?.signal,
      liveSession,
    });
    safeLiveCall(() => liveSession.phase("streaming", "模型正在返回内容"));
  } catch (error) {
    safeLiveCall(() => liveSession.fail(error));
    recordPromptFailure({
      asset: input.asset as PromptAsset<unknown, unknown, unknown>,
      context: prepared.context,
      invocation: prepared.invocation,
      provider: input.options?.provider,
      model: input.options?.model,
      latencyMs: Date.now() - startedAt,
      renderedPromptChars,
      error,
    });
    throw error;
  }

  return {
    stream: captured.stream,
    complete: captured.completion.then(async ({ text: rawContent, usage }) => {
      safeLiveCall(() => liveSession.phase("validating", "正在检查结构化结果"));
      const parsed = await parseStructuredLlmRawContentDetailed({
        rawContent,
        schema: outputSchema,
        provider: input.options?.provider,
        model: input.options?.model,
        temperature: input.options?.temperature,
        maxTokens: input.options?.maxTokens,
        timeoutMs: input.options?.timeoutMs,
        signal: input.options?.signal,
        taskType: input.asset.taskType,
        label: `${input.asset.id}@${input.asset.version}`,
        maxRepairAttempts: resolveStructuredRepairAttempts(input.asset as PromptAsset<unknown, unknown, unknown>),
        promptMeta: prepared.invocation,
        strategy,
        profile,
      });
      const resolved = await resolveStructuredOutput({
        asset: input.asset,
        promptInput: input.promptInput,
        context: prepared.context,
        baseMessages: prepared.messages,
        outputSchema,
        initialResult: parsed,
        structuredInvoker: input.structuredInvoker,
        options: input.options,
      });
      const built = buildPromptRunResult({
        asset: input.asset as PromptAsset<unknown, unknown, unknown>,
        output: resolved.output,
        context: prepared.context,
        provider: input.options?.provider,
        model: input.options?.model,
        latencyMs: Date.now() - startedAt,
        invocation: resolved.invocation,
        renderedPromptChars,
        tokenUsage: usage,
        postValidateFailureRecovered: resolved.postValidateFailureRecovered,
      });
      safeLiveCall(() => liveSession.complete());
      return built;
    }).catch((error) => {
      safeLiveCall(() => liveSession.fail(error));
      recordPromptFailure({
        asset: input.asset as PromptAsset<unknown, unknown, unknown>,
        context: prepared.context,
        invocation: prepared.invocation,
        provider: input.options?.provider,
        model: input.options?.model,
        latencyMs: Date.now() - startedAt,
        renderedPromptChars,
        error,
      });
      throw error;
    }),
    context: prepared.context,
    invocation: prepared.invocation,
  };
}
