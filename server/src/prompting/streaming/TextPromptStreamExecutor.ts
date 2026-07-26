import type { BaseMessageChunk } from "@langchain/core/messages";
import type { getLLM } from "../../llm/factory";
import { resolveEnforcedTimeoutMs, runWithEnforcedTimeout } from "../../llm/invokeTimeout";
import { beginLlmLiveSession, safeLiveCall } from "../../llm/live/llmLiveSession";
import { runWithTransportRetry } from "../../llm/transportRetry";
import type { PromptAsset, PromptExecutionOptions, PromptStreamRunResult } from "../core/promptTypes";
import {
  buildPromptCallOptions,
  buildPromptInvocationMeta,
  preparePromptExecution,
  resolvePromptOverlaysForAsset,
  type PromptContextBlocks,
} from "../execution/PromptExecutionPreparation";
import {
  buildPromptRunResult,
  estimateRenderedPromptChars,
  recordPromptFailure,
} from "../observability/PromptExecutionRecorder";
import { resolveAdvancedTextPromptMessages } from "../templates/templateRuntime";
import { applyPromptPostValidate } from "../validation/PromptPostValidation";
import { capturePromptStream } from "./PromptStreamCapture";

export type PromptRunnerLLMFactory = typeof getLLM;

export async function executeTextPromptStream<I>(input: {
  asset: PromptAsset<I, string, string>;
  promptInput: I;
  contextBlocks?: PromptContextBlocks;
  options?: PromptExecutionOptions;
  llmFactory: PromptRunnerLLMFactory;
}): Promise<PromptStreamRunResult<string>> {
  if (input.asset.mode !== "text") {
    throw new Error(`Prompt asset ${input.asset.id}@${input.asset.version} is not a text prompt.`);
  }

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
  const messages = await resolveAdvancedTextPromptMessages({
    asset: input.asset,
    promptInput: input.promptInput,
    context: prepared.context,
    officialMessages: prepared.messages,
    novelId: input.options?.novelId,
  });
  const renderedPromptChars = estimateRenderedPromptChars(messages);
  let captured: ReturnType<typeof capturePromptStream>;
  const streamLabel = `${input.asset.id}@${input.asset.version}`;
  const liveSession = beginLlmLiveSession({
    label: streamLabel,
    mode: "text",
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
    });
    const streamBudgetMs = resolveEnforcedTimeoutMs(input.options?.timeoutMs);
    const streamDeadlineAt = Date.now() + streamBudgetMs;
    const rawStream = await runWithTransportRetry(
      () => runWithEnforcedTimeout({
        label: streamLabel,
        timeoutMs: Math.max(1, streamDeadlineAt - Date.now()),
        signal: input.options?.signal,
        run: (signal) => llm.stream(
          messages,
          buildPromptCallOptions({
            ...input.options,
            signal: signal ?? input.options?.signal,
          }),
        ),
      }),
      {
        signal: input.options?.signal,
        label: streamLabel,
        onRetry: ({ attempt, maxAttempts, error, backoffMs }) => {
          console.warn("[prompt-runner] stream establish transport retry", {
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
    complete: captured.completion.then(async ({ text: content, usage }) => {
      safeLiveCall(() => liveSession.phase("validating", "正在检查文本结果"));
      const output = applyPromptPostValidate({
        asset: input.asset,
        promptInput: input.promptInput,
        context: prepared.context,
        rawOutput: content,
      });
      safeLiveCall(() => liveSession.complete());
      return buildPromptRunResult({
        asset: input.asset as PromptAsset<unknown, unknown, unknown>,
        output,
        context: prepared.context,
        provider: input.options?.provider,
        model: input.options?.model,
        latencyMs: Date.now() - startedAt,
        invocation: buildPromptInvocationMeta(
          input.asset as PromptAsset<unknown, unknown, unknown>,
          prepared.context,
          false,
          0,
          false,
          0,
          input.options,
        ),
        renderedPromptChars,
        tokenUsage: usage,
      });
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
