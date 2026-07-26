import { hasRegisteredPromptAsset } from "../registry";
import { CUSTOM_SLOT_CONTEXT_GROUP } from "../slots/slotResolution";
import { promptSlotOverrideService } from "../slots/PromptSlotOverrideService";
import type { ResolvedSlots } from "../slots/slotTypes";
import { selectContextBlocks } from "../core/contextSelection";
import { appendStructuredOutputHintMessages } from "../core/structuredOutputHint";
import type {
  PromptAsset,
  PromptExecutionOptions,
  PromptInvocationMeta,
  PromptRenderContext,
} from "../core/promptTypes";

export type PromptContextBlocks = Parameters<typeof selectContextBlocks>[0];

function buildRenderContext(
  asset: PromptAsset<unknown, unknown, unknown>,
  rawBlocks: PromptContextBlocks,
  resolvedSlots?: ResolvedSlots,
): PromptRenderContext {
  const selection = selectContextBlocks(rawBlocks, asset.contextPolicy);
  return {
    blocks: selection.selectedBlocks,
    selectedBlockIds: selection.selectedBlocks.map((block) => block.id),
    droppedBlockIds: selection.droppedBlockIds,
    summarizedBlockIds: selection.summarizedBlockIds,
    estimatedInputTokens: selection.estimatedTokens,
    slots: resolvedSlots,
  };
}

function assertRegistered(asset: PromptAsset<unknown, unknown, unknown>): void {
  if (!hasRegisteredPromptAsset(asset.id, asset.version)) {
    throw new Error(`Prompt asset is not registered: ${asset.id}@${asset.version}`);
  }
}

export function buildPromptInvocationMeta(
  asset: PromptAsset<unknown, unknown, unknown>,
  context: PromptRenderContext,
  repairUsed: boolean,
  repairAttempts: number,
  semanticRetryUsed: boolean,
  semanticRetryAttempts: number,
  options?: PromptExecutionOptions,
): PromptInvocationMeta {
  return {
    promptId: asset.id,
    promptVersion: asset.version,
    taskType: asset.taskType,
    novelId: options?.novelId,
    chapterId: options?.chapterId,
    volumeId: options?.volumeId,
    taskId: options?.taskId,
    stage: options?.stage,
    itemKey: options?.itemKey,
    scope: options?.scope,
    entrypoint: options?.entrypoint,
    sceneIndex: options?.sceneIndex,
    roundIndex: options?.roundIndex,
    triggerReason: options?.triggerReason,
    contextBlockIds: context.selectedBlockIds,
    droppedContextBlockIds: context.droppedBlockIds,
    summarizedContextBlockIds: context.summarizedBlockIds,
    customAddendumBlockIds: context.selectedBlockIds.filter((id) => id.startsWith(`${CUSTOM_SLOT_CONTEXT_GROUP}:`)),
    estimatedInputTokens: context.estimatedInputTokens,
    repairUsed,
    repairAttempts,
    semanticRetryUsed,
    semanticRetryAttempts,
  };
}

export async function resolvePromptOverlaysForAsset(input: {
  asset: PromptAsset<unknown, unknown, unknown>;
  contextBlocks?: PromptContextBlocks;
  options?: PromptExecutionOptions;
}): Promise<{
  blocks: PromptContextBlocks;
  resolvedSlots?: ResolvedSlots;
}> {
  const baseBlocks = input.contextBlocks ?? [];
  const slotDefs = input.asset.slots;
  if (!slotDefs || slotDefs.length === 0) {
    return { blocks: baseBlocks };
  }

  const overlays = await promptSlotOverrideService.resolveForRuntime({
    promptId: input.asset.id,
    novelId: input.options?.novelId,
  });
  return {
    blocks: overlays.appendBlocks.length > 0
      ? [...baseBlocks, ...overlays.appendBlocks]
      : baseBlocks,
    resolvedSlots: overlays.inlineSlots,
  };
}

export function resolveStructuredRepairAttempts(
  asset: PromptAsset<unknown, unknown, unknown>,
): number {
  return Math.max(0, asset.repairPolicy?.maxAttempts ?? 1);
}

export function resolveStructuredSemanticRetryAttempts(
  asset: PromptAsset<unknown, unknown, unknown>,
): number {
  return Math.max(0, asset.semanticRetryPolicy?.maxAttempts ?? 0);
}

export function buildPromptCallOptions(
  options?: PromptExecutionOptions,
): Record<string, unknown> {
  return options?.signal ? { signal: options.signal } : {};
}

export function preparePromptExecution<I, O, R = O>(input: {
  asset: PromptAsset<I, O, R>;
  promptInput: I;
  contextBlocks?: PromptContextBlocks;
  options?: PromptExecutionOptions;
  resolvedSlots?: ResolvedSlots;
}): {
  messages: ReturnType<PromptAsset<I, O, R>["render"]>;
  context: PromptRenderContext;
  invocation: PromptInvocationMeta;
} {
  assertRegistered(input.asset as PromptAsset<unknown, unknown, unknown>);
  const context = buildRenderContext(
    input.asset as PromptAsset<unknown, unknown, unknown>,
    input.contextBlocks ?? [],
    input.resolvedSlots,
  );
  const renderedMessages = input.asset.render(input.promptInput, context);
  return {
    messages: appendStructuredOutputHintMessages({
      asset: input.asset,
      promptInput: input.promptInput,
      context,
      messages: renderedMessages,
    }),
    context,
    invocation: buildPromptInvocationMeta(
      input.asset as PromptAsset<unknown, unknown, unknown>,
      context,
      false,
      0,
      false,
      0,
      input.options,
    ),
  };
}
