import type {
  PromptAsset,
  PromptContextBlock,
  PromptContextFreshnessMode,
  PromptContextRequirement,
} from "../core/promptTypes";
import { ContextBroker } from "./ContextBroker";
import { createDefaultContextResolverRegistry } from "./defaultContextRegistry";
import type { ContextBrokerResolution, PromptExecutionContext } from "./types";

export function derivePromptContextRequirements(
  asset: Pick<PromptAsset<unknown, unknown, unknown>, "contextPolicy" | "contextRequirements">,
): PromptContextRequirement[] {
  if (asset.contextRequirements && asset.contextRequirements.length > 0) {
    return asset.contextRequirements;
  }

  const required = (asset.contextPolicy.requiredGroups ?? []).map((group, index) => ({
    group,
    required: true,
    priority: 100 - index,
    sourceHint: "asset.contextPolicy.requiredGroups",
  } satisfies PromptContextRequirement));
  const preferred = (asset.contextPolicy.preferredGroups ?? []).map((group, index) => ({
    group,
    required: false,
    priority: 50 - index,
    sourceHint: "asset.contextPolicy.preferredGroups",
  } satisfies PromptContextRequirement));
  return [...required, ...preferred];
}

let defaultPromptContextBroker: ContextBroker | null = null;

function getDefaultPromptContextBroker(): ContextBroker {
  defaultPromptContextBroker ??= new ContextBroker(createDefaultContextResolverRegistry());
  return defaultPromptContextBroker;
}

/**
 * 以 broker 预算选择为准合并上下文块：
 * - broker 选中块 ∪ fallback 块，但 broker 超预算 drop/summarize 的可选块不得被 fallback 复活
 *   （否则 maxTokensBudget 失效）。
 * - fallback 中 group 未在 requirements 声明的块（broker 不解析、无预算裁剪记录）原样保留——
 *   例如 writer 的 previous_chapter_tail/chapter_boundary/current_draft_excerpt 等直发组。
 * - broker 整体未选出任何块（解析全挂）时，fallback 全量兜底。
 */
function mergeContextBlocks(input: {
  fallbackBlocks?: PromptContextBlock[];
  brokerResolution: ContextBrokerResolution;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}): PromptContextBlock[] {
  const { brokerResolution, fallbackBlocks = [] } = input;
  if (brokerResolution.droppedBlockIds.length > 0 || brokerResolution.summarizedBlockIds.length > 0) {
    input.log?.("Context broker trimmed blocks by budget", {
      droppedBlockIds: brokerResolution.droppedBlockIds,
      summarizedBlockIds: brokerResolution.summarizedBlockIds,
      estimatedInputTokens: brokerResolution.estimatedInputTokens,
    });
  }
  if (fallbackBlocks.length === 0) {
    return brokerResolution.blocks;
  }
  if (brokerResolution.blocks.length === 0) {
    input.log?.("Context broker resolved no blocks; falling back to caller-provided blocks", {
      fallbackBlockCount: fallbackBlocks.length,
      missingRequiredGroups: brokerResolution.missingRequiredGroups,
      resolverErrorGroups: brokerResolution.resolverErrors.map((error) => error.group),
    });
    return [...fallbackBlocks].sort((left, right) => right.priority - left.priority);
  }
  const trimmedIds = new Set([
    ...brokerResolution.droppedBlockIds,
    ...brokerResolution.summarizedBlockIds,
  ]);
  const byId = new Map<string, PromptContextBlock>();
  for (const block of fallbackBlocks) {
    // broker 预算裁掉的块不得经 fallback 复活；其余 fallback 块（含 broker 未声明解析的组）保留
    if (!trimmedIds.has(block.id)) {
      byId.set(block.id, block);
    }
  }
  // broker 选中块覆盖 fallback 同 id 块（可能经过 summarize 等预算处理）
  for (const block of brokerResolution.blocks) {
    byId.set(block.id, block);
  }
  return [...byId.values()].sort((left, right) => right.priority - left.priority);
}

export async function resolvePromptContextBlocksForAsset<I, O, R = O>(input: {
  asset: PromptAsset<I, O, R>;
  executionContext: PromptExecutionContext;
  fallbackBlocks?: PromptContextBlock[];
  requirements?: PromptContextRequirement[];
  mode?: PromptContextFreshnessMode;
  maxTokensBudget?: number;
  broker?: ContextBroker;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<{
  blocks: PromptContextBlock[];
  brokerResolution: ContextBrokerResolution;
}> {
  const broker = input.broker ?? getDefaultPromptContextBroker();
  const brokerResolution = await broker.resolve({
    executionContext: input.executionContext,
    requirements: input.requirements
      ?? derivePromptContextRequirements(input.asset as unknown as PromptAsset<unknown, unknown, unknown>),
    mode: input.mode,
    maxTokensBudget: input.maxTokensBudget ?? input.asset.contextPolicy.maxTokensBudget,
  });

  return {
    blocks: mergeContextBlocks({
      fallbackBlocks: input.fallbackBlocks,
      brokerResolution,
      log: input.log,
    }),
    brokerResolution,
  };
}
