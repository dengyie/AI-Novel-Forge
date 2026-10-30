import type { BaseMessage, BaseMessageChunk } from "@langchain/core/messages";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { ZodType } from "zod";
import type { TaskType } from "../../llm/modelRouter";
import type { LlmTokenUsageSnapshot } from "../../llm/usageTracking";
import type { PromptSlotDef, ResolvedSlots } from "../slots/slotTypes";

export type PromptMode = "structured" | "text";
export type PromptLanguage = "zh" | "en";

export interface PromptContextBlock {
  id: string;
  group: string;
  priority: number;
  required: boolean;
  estimatedTokens: number;
  content: string;
  conflictGroup?: string;
  freshness?: number;
  allowSummary?: boolean;
  /**
   * Prompt 前缀复用范围（上游 2026-10-05 布局设计）：book/volume 层材料在 request 层之前渲染。
   * 复用范围不是快照缓存——book/volume 块每次仍读取最新内容；混合状态的块缺省 request。
   */
  reuseScope?: "book" | "volume" | "request";
}

export interface ContextPolicy {
  maxTokensBudget: number;
  requiredGroups?: string[];
  preferredGroups?: string[];
  dropOrder?: string[];
}

export type PromptContextFreshnessMode = "snapshot" | "fresh" | "hybrid";

export interface PromptContextRequirement {
  group: string;
  required?: boolean;
  priority: number;
  maxTokens?: number;
  freshness?: PromptContextFreshnessMode;
  sourceHint?: string;
}

export type PromptEditableSlotRiskLevel = "low" | "medium" | "high";

export interface PromptEditableSlot {
  key: string;
  label: string;
  description: string;
  riskLevel: PromptEditableSlotRiskLevel;
  maxLength?: number;
  defaultValue?: string;
}

export type PromptOverrideScope = "global" | "project" | "novel" | "experiment";
export type PromptOverrideStatus = "draft" | "published" | "rolled_back";

export interface PromptOverrideDraft {
  promptId: string;
  baseVersion: string;
  scope: PromptOverrideScope;
  status: PromptOverrideStatus;
  slots: Record<string, string>;
  notes?: string;
}

export interface PromptRenderContext {
  blocks: PromptContextBlock[];
  selectedBlockIds: string[];
  droppedBlockIds: string[];
  summarizedBlockIds: string[];
  estimatedInputTokens: number;
  slots?: ResolvedSlots;
}

export interface PromptInvocationMeta {
  promptId: string;
  promptVersion: string;
  taskType: TaskType;
  novelId?: string;
  chapterId?: string;
  volumeId?: string;
  taskId?: string;
  stage?: string;
  itemKey?: string;
  scope?: string;
  entrypoint?: string;
  sceneIndex?: number;
  roundIndex?: number;
  triggerReason?: string;
  contextBlockIds: string[];
  droppedContextBlockIds: string[];
  summarizedContextBlockIds: string[];
  customAddendumBlockIds: string[];
  estimatedInputTokens: number;
  repairUsed: boolean;
  repairAttempts: number;
  semanticRetryUsed: boolean;
  semanticRetryAttempts: number;
}

export interface PromptRunTrace {
  promptId: string;
  promptVersion: string;
  taskType: TaskType;
  provider?: LLMProvider;
  model?: string;
  latencyMs?: number;
  contextBlockIds: string[];
  droppedContextBlockIds: string[];
  summarizedContextBlockIds: string[];
  customAddendumBlockIds: string[];
  estimatedInputTokens: number;
  repairUsed: boolean;
  repairAttempts: number;
  semanticRetryUsed: boolean;
  semanticRetryAttempts: number;
  entrypoint?: string;
  novelId?: string;
  chapterId?: string;
  taskId?: string;
  compiledHash?: string;
  contextSnapshotHash?: string;
}

export interface PromptExecutionOptions {
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  novelId?: string;
  chapterId?: string;
  volumeId?: string;
  taskId?: string;
  stage?: string;
  itemKey?: string;
  scope?: string;
  entrypoint?: string;
  sceneIndex?: number;
  roundIndex?: number;
  triggerReason?: string;
}

export interface PromptExecutionMeta {
  provider?: LLMProvider;
  model?: string;
  latencyMs: number;
  invocation: PromptInvocationMeta;
  tokenUsage?: LlmTokenUsageSnapshot | null;
}

export interface PromptRunResult<T> {
  output: T;
  meta: PromptExecutionMeta;
  context: PromptRenderContext;
}

export interface PromptStreamRunResult<T> {
  stream: AsyncIterable<BaseMessageChunk>;
  complete: Promise<PromptRunResult<T>>;
  context: PromptRenderContext;
  invocation: PromptInvocationMeta;
}

export interface PromptRepairPolicy {
  maxAttempts: number;
}

export interface PromptSemanticRetryBuildInput<I, R> {
  promptId: string;
  promptVersion: string;
  attempt: number;
  promptInput: I;
  context: PromptRenderContext;
  baseMessages: BaseMessage[];
  parsedOutput: R;
  validationError: string;
}

export interface PromptSemanticRetryPolicy<I, R> {
  maxAttempts: number;
  buildMessages?: (input: PromptSemanticRetryBuildInput<I, R>) => BaseMessage[];
}

export interface PromptPostValidateFailureRecoveryInput<I, R> {
  promptInput: I;
  context: PromptRenderContext;
  rawOutput: R;
  validationError: string;
  semanticRetryAttempts: number;
}

export type PromptStructuredOutputExampleBuilder<I, R> = (input: I, context: PromptRenderContext) => unknown;

export interface PromptStructuredOutputHint<I, R> {
  mode?: "auto" | "off";
  /** stable_prefix：静态骨架（example/note 均非函数）前置到动态材料之前，其余保持尾部。 */
  placement?: "stable_prefix" | "tail";
  example?: unknown | PromptStructuredOutputExampleBuilder<I, R>;
  note?: string | ((input: I, context: PromptRenderContext) => string | undefined);
}

export interface PromptAsset<I, O, R = O> {
  id: string;
  version: string;
  taskType: TaskType;
  mode: PromptMode;
  language: PromptLanguage;
  contextPolicy: ContextPolicy;
  repairPolicy?: PromptRepairPolicy;
  semanticRetryPolicy?: PromptSemanticRetryPolicy<I, R>;
  outputSchema?: ZodType<R>;
  structuredOutputHint?: PromptStructuredOutputHint<I, R>;
  editableSlots?: PromptEditableSlot[];
  slots?: PromptSlotDef[];
  contextRequirements?: PromptContextRequirement[];
  render: (input: I, context: PromptRenderContext) => BaseMessage[];
  postValidate?: (output: R, input: I, context: PromptRenderContext) => O;
  postValidateFailureRecovery?: (input: PromptPostValidateFailureRecoveryInput<I, R>) => O;
}

export function buildPromptAssetKey(asset: Pick<PromptAsset<unknown, unknown, unknown>, "id" | "version">): string {
  return `${asset.id}@${asset.version}`;
}
