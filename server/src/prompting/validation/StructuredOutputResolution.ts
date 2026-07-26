import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type {
  invokeStructuredLlmDetailed,
  StructuredInvokeResult,
} from "../../llm/structuredInvoke";
import { recordPromptQualityEvent } from "../core/promptQualityTelemetry";
import type {
  PromptAsset,
  PromptExecutionOptions,
  PromptInvocationMeta,
  PromptRenderContext,
} from "../core/promptTypes";
import {
  buildPromptInvocationMeta,
  resolveStructuredRepairAttempts,
  resolveStructuredSemanticRetryAttempts,
} from "../execution/PromptExecutionPreparation";
import { logPromptEvent } from "../observability/PromptExecutionRecorder";
import {
  applyPromptPostValidate,
  markPromptQualityFailure,
  safeJsonStringify,
  stringifyPromptError,
} from "./PromptPostValidation";

export type PromptRunnerStructuredInvoker = typeof invokeStructuredLlmDetailed;

function buildDefaultSemanticRetryMessages<R>(input: {
  baseMessages: BaseMessage[];
  attempt: number;
  parsedOutput: R;
  validationError: string;
}): BaseMessage[] {
  return [
    ...input.baseMessages,
    new HumanMessage([
      `上一次输出虽然通过了 JSON 结构校验，但没有通过业务校验。这是第 ${input.attempt} 次语义重试。`,
      `失败原因：${input.validationError}`,
      "",
      "上一次的 JSON 输出：",
      safeJsonStringify(input.parsedOutput),
      "",
      "请基于同一任务重新生成完整 JSON 对象。",
      "硬要求：",
      "1. 只输出最终 JSON 对象。",
      "2. 不要输出 Markdown、解释、注释或额外文本。",
      "3. 必须修正上面的业务校验失败点。",
    ].join("\n")),
  ];
}

function buildSemanticRetryMessages<I, O, R>(input: {
  asset: PromptAsset<I, O, R>;
  promptInput: I;
  context: PromptRenderContext;
  baseMessages: BaseMessage[];
  parsedOutput: R;
  validationError: string;
  attempt: number;
}): BaseMessage[] {
  return input.asset.semanticRetryPolicy?.buildMessages?.({
    promptId: input.asset.id,
    promptVersion: input.asset.version,
    attempt: input.attempt,
    promptInput: input.promptInput,
    context: input.context,
    baseMessages: input.baseMessages,
    parsedOutput: input.parsedOutput,
    validationError: input.validationError,
  }) ?? buildDefaultSemanticRetryMessages(input);
}

export async function resolveStructuredOutput<I, O, R = O>(input: {
  asset: PromptAsset<I, O, R>;
  promptInput: I;
  context: PromptRenderContext;
  baseMessages: BaseMessage[];
  outputSchema: NonNullable<PromptAsset<I, O, R>["outputSchema"]>;
  initialResult: StructuredInvokeResult<R>;
  structuredInvoker: PromptRunnerStructuredInvoker;
  options?: PromptExecutionOptions;
}): Promise<{
  output: O;
  invocation: PromptInvocationMeta;
  postValidateFailureRecovered: boolean;
}> {
  const asset = input.asset as PromptAsset<unknown, unknown, unknown>;
  let currentMessages = input.baseMessages;
  let currentResult = input.initialResult;
  let totalRepairAttempts = currentResult.repairAttempts;
  let repairUsed = currentResult.repairUsed;
  let semanticRetryAttempts = 0;
  const maxSemanticRetryAttempts = resolveStructuredSemanticRetryAttempts(asset);

  while (true) {
    try {
      const output = applyPromptPostValidate({
        asset: input.asset,
        promptInput: input.promptInput,
        context: input.context,
        rawOutput: currentResult.data,
      });
      return {
        output,
        invocation: buildPromptInvocationMeta(
          asset,
          input.context,
          repairUsed,
          totalRepairAttempts,
          semanticRetryAttempts > 0,
          semanticRetryAttempts,
          input.options,
        ),
        postValidateFailureRecovered: false,
      };
    } catch (error) {
      if (semanticRetryAttempts >= maxSemanticRetryAttempts) {
        if (input.asset.postValidateFailureRecovery) {
          logPromptEvent({
            event: "semantic_retry_recovered",
            asset,
            context: input.context,
            provider: input.options?.provider,
            model: input.options?.model,
            attempt: semanticRetryAttempts,
            validationError: stringifyPromptError(error),
          });
          recordPromptQualityEvent({
            event: "semantic_retry_recovered",
            promptId: asset.id,
            promptVersion: asset.version,
            taskType: asset.taskType,
            mode: asset.mode,
            provider: input.options?.provider,
            model: input.options?.model,
            stage: input.options?.stage,
            entrypoint: input.options?.entrypoint,
            estimatedInputTokens: input.context.estimatedInputTokens,
            semanticRetryUsed: semanticRetryAttempts > 0,
            semanticRetryAttempts,
            postValidateFailureRecovered: true,
          });
          return {
            output: input.asset.postValidateFailureRecovery({
              promptInput: input.promptInput,
              context: input.context,
              rawOutput: currentResult.data,
              validationError: stringifyPromptError(error),
              semanticRetryAttempts,
            }),
            invocation: buildPromptInvocationMeta(
              asset,
              input.context,
              repairUsed,
              totalRepairAttempts,
              semanticRetryAttempts > 0,
              semanticRetryAttempts,
              input.options,
            ),
            postValidateFailureRecovered: true,
          };
        }
        throw markPromptQualityFailure(error, "post_validate_failed");
      }

      semanticRetryAttempts += 1;
      recordPromptQualityEvent({
        event: "semantic_retry_start",
        promptId: asset.id,
        promptVersion: asset.version,
        taskType: asset.taskType,
        mode: asset.mode,
        provider: input.options?.provider,
        model: input.options?.model,
        stage: input.options?.stage,
        entrypoint: input.options?.entrypoint,
        estimatedInputTokens: input.context.estimatedInputTokens,
        semanticRetryUsed: true,
        semanticRetryAttempts,
      });
      logPromptEvent({
        event: "semantic_retry_start",
        asset,
        context: input.context,
        provider: input.options?.provider,
        model: input.options?.model,
        attempt: semanticRetryAttempts,
        validationError: stringifyPromptError(error),
      });
      currentMessages = buildSemanticRetryMessages({
        asset: input.asset,
        promptInput: input.promptInput,
        context: input.context,
        baseMessages: currentMessages,
        parsedOutput: currentResult.data,
        validationError: stringifyPromptError(error),
        attempt: semanticRetryAttempts,
      });
      currentResult = await input.structuredInvoker<R>({
        label: `${input.asset.id}@${input.asset.version}#semantic-retry-${semanticRetryAttempts}`,
        provider: input.options?.provider,
        model: input.options?.model,
        temperature: input.options?.temperature,
        maxTokens: input.options?.maxTokens,
        timeoutMs: input.options?.timeoutMs,
        signal: input.options?.signal,
        taskType: input.asset.taskType,
        messages: currentMessages,
        schema: input.outputSchema,
        maxRepairAttempts: resolveStructuredRepairAttempts(asset),
        promptMeta: buildPromptInvocationMeta(
          asset,
          input.context,
          repairUsed,
          totalRepairAttempts,
          true,
          semanticRetryAttempts,
          input.options,
        ),
      });
      logPromptEvent({
        event: "semantic_retry_done",
        asset,
        context: input.context,
        provider: input.options?.provider,
        model: input.options?.model,
        attempt: semanticRetryAttempts,
      });
      recordPromptQualityEvent({
        event: "semantic_retry_done",
        promptId: asset.id,
        promptVersion: asset.version,
        taskType: asset.taskType,
        mode: asset.mode,
        provider: input.options?.provider,
        model: input.options?.model,
        stage: input.options?.stage,
        entrypoint: input.options?.entrypoint,
        estimatedInputTokens: input.context.estimatedInputTokens,
        repairUsed: currentResult.repairUsed,
        repairAttempts: currentResult.repairAttempts,
        semanticRetryUsed: true,
        semanticRetryAttempts,
      });
      totalRepairAttempts += currentResult.repairAttempts;
      repairUsed = repairUsed || currentResult.repairUsed;
    }
  }
}
