import type { getLLM } from "../../llm/factory";
import { runWithEnforcedTimeout } from "../../llm/invokeTimeout";
import { beginLlmLiveSession, safeLiveCall } from "../../llm/live/llmLiveSession";
import { runWithTransportRetry } from "../../llm/transportRetry";
import { extractLlmTokenUsage } from "../../llm/usageTracking";
import { toText } from "../../services/novel/novelP0Utils";
import type { PromptAsset, PromptExecutionOptions, PromptRunResult } from "../core/promptTypes";
import { resolveAdvancedTextPromptMessages } from "../templates/templateRuntime";
import {
  buildPromptCallOptions,
  buildPromptInvocationMeta,
  preparePromptExecution,
  resolvePromptOverlaysForAsset,
  type PromptContextBlocks,
} from "./PromptExecutionPreparation";
import {
  buildPromptRunResult,
  estimateRenderedPromptChars,
  recordPromptFailure,
} from "../observability/PromptExecutionRecorder";
import { applyPromptPostValidate } from "../validation/PromptPostValidation";

export type PromptRunnerLLMFactory = typeof getLLM;

export async function executeTextPrompt<I>(input: {
  asset: PromptAsset<I, string, string>;
  promptInput: I;
  contextBlocks?: PromptContextBlocks;
  options?: PromptExecutionOptions;
  llmFactory: PromptRunnerLLMFactory;
}): Promise<PromptRunResult<string>> {
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
  const liveSession = beginLlmLiveSession({
    label: `${input.asset.id}@${input.asset.version}`,
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
    const callOptions = buildPromptCallOptions(input.options);
    const textLabel = `${input.asset.id}@${input.asset.version}`;
    safeLiveCall(() => liveSession.phase("assembling", "模型正在生成"));
    const result = await runWithTransportRetry(
      () => runWithEnforcedTimeout({
        label: textLabel,
        timeoutMs: input.options?.timeoutMs,
        signal: input.options?.signal,
        run: (signal) => llm.invoke(
          messages,
          signal ? { ...callOptions, signal } : callOptions,
        ),
      }),
      {
        signal: input.options?.signal,
        label: textLabel,
        onRetry: ({ attempt, maxAttempts, error, backoffMs }) => {
          console.warn("[prompt-runner] text transport retry", {
            label: textLabel,
            attempt,
            maxAttempts,
            backoffMs,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      },
    );
    const rawText = toText(result.content);
    if (rawText) {
      safeLiveCall(() => liveSession.delta(rawText.slice(0, 4000)));
    }
    safeLiveCall(() => liveSession.phase("validating", "正在检查文本结果"));
    const output = applyPromptPostValidate({
      asset: input.asset,
      promptInput: input.promptInput,
      context: prepared.context,
      rawOutput: rawText,
    });
    const built = buildPromptRunResult({
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
      tokenUsage: extractLlmTokenUsage(result),
    });
    safeLiveCall(() => liveSession.complete());
    return built;
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
}
