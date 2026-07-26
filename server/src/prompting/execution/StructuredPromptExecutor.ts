import type { invokeStructuredLlmDetailed } from "../../llm/structuredInvoke";
import { beginLlmLiveSession, safeLiveCall } from "../../llm/live/llmLiveSession";
import { logMemoryUsage } from "../../runtime/memoryTelemetry";
import type { PromptAsset, PromptExecutionOptions, PromptRunResult } from "../core/promptTypes";
import {
  preparePromptExecution,
  resolvePromptOverlaysForAsset,
  resolveStructuredRepairAttempts,
  type PromptContextBlocks,
} from "./PromptExecutionPreparation";
import {
  buildPromptRunResult,
  estimateRenderedPromptChars,
  logPromptEvent,
  recordPromptFailure,
} from "../observability/PromptExecutionRecorder";
import { resolveStructuredOutput } from "../validation/StructuredOutputResolution";

export type PromptRunnerStructuredInvoker = typeof invokeStructuredLlmDetailed;

export async function executeStructuredPrompt<I, O, R = O>(input: {
  asset: PromptAsset<I, O, R>;
  promptInput: I;
  contextBlocks?: PromptContextBlocks;
  options?: PromptExecutionOptions;
  structuredInvoker: PromptRunnerStructuredInvoker;
}): Promise<PromptRunResult<O>> {
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
  logPromptEvent({
    event: "started",
    asset: input.asset as PromptAsset<unknown, unknown, unknown>,
    context: prepared.context,
    provider: input.options?.provider,
    model: input.options?.model,
  });
  const startedAt = Date.now();
  const renderedPromptChars = estimateRenderedPromptChars(prepared.messages);
  const liveSession = beginLlmLiveSession({
    label: `${input.asset.id}@${input.asset.version}`,
    mode: "structured",
    promptMeta: prepared.invocation,
    provider: input.options?.provider,
    model: input.options?.model,
  });
  safeLiveCall(() => liveSession.phase("requesting", "结构化调用：正在连接模型（仅阶段进度，无流式正文）"));
  try {
    safeLiveCall(() => liveSession.phase("assembling", "结构化调用：模型正在生成 JSON（非流式，完成后才校验）"));
    const result = await input.structuredInvoker<R>({
      label: `${input.asset.id}@${input.asset.version}`,
      provider: input.options?.provider,
      model: input.options?.model,
      temperature: input.options?.temperature,
      maxTokens: input.options?.maxTokens,
      timeoutMs: input.options?.timeoutMs,
      signal: input.options?.signal,
      taskType: input.asset.taskType,
      messages: prepared.messages,
      schema: outputSchema,
      maxRepairAttempts: resolveStructuredRepairAttempts(input.asset as PromptAsset<unknown, unknown, unknown>),
      promptMeta: prepared.invocation,
    });
    safeLiveCall(() => liveSession.phase("validating", "结构化调用：正在检查 JSON 结果"));
    logMemoryUsage({
      event: "structured_invoke_done",
      component: "runStructuredPrompt",
      taskId: input.options?.taskId,
      novelId: input.options?.novelId,
      chapterId: input.options?.chapterId,
      volumeId: input.options?.volumeId,
      stage: input.options?.stage,
      itemKey: input.options?.itemKey,
      scope: input.options?.scope ?? input.options?.triggerReason,
      entrypoint: input.options?.entrypoint,
      promptId: input.asset.id,
      promptVersion: input.asset.version,
      provider: input.options?.provider,
      model: input.options?.model,
      renderedPromptChars,
    });
    const resolved = await resolveStructuredOutput({
      asset: input.asset,
      promptInput: input.promptInput,
      context: prepared.context,
      baseMessages: prepared.messages,
      outputSchema,
      initialResult: result,
      structuredInvoker: input.structuredInvoker,
      options: input.options,
    });
    logMemoryUsage({
      event: "before_prompt_result_return",
      component: "runStructuredPrompt",
      taskId: input.options?.taskId,
      novelId: input.options?.novelId,
      chapterId: input.options?.chapterId,
      volumeId: input.options?.volumeId,
      stage: input.options?.stage,
      itemKey: input.options?.itemKey,
      scope: input.options?.scope ?? input.options?.triggerReason,
      entrypoint: input.options?.entrypoint,
      promptId: input.asset.id,
      promptVersion: input.asset.version,
      provider: input.options?.provider,
      model: input.options?.model,
      renderedPromptChars,
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
      tokenUsage: result.tokenUsage,
      postValidateFailureRecovered: resolved.postValidateFailureRecovered,
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
