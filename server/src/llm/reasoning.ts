import type { BaseMessageChunk } from "@langchain/core/messages";
import type { LLMProvider } from "@ai-novel/shared/types/llm";

const THINK_OPEN_TAG = "<think>";
const THINK_CLOSE_TAG = "</think>";
const DEEPSEEK_HOST_PATTERN = /(?:^|:\/\/)(?:api\.)?deepseek\.com(?:\/|$)/i;
const MINIMAX_HOST_PATTERN = /(?:^|:\/\/)(?:api\.)?minimax(?:i)?\.(?:io|com)(?:\/|$)/i;
const MINIMAX_MODEL_PATTERN = /^minimax-m2(?:[.-]|$)/i;

export interface ProviderReasoningBehavior {
  reasoningEnabled: boolean;
  modelKwargs?: Record<string, unknown>;
  includeRawResponse: boolean;
  usesAccumulatedStreamDeltas: boolean;
}

export interface StreamFilterResult {
  text: string;
  reasoning: string;
}

export interface MiniMaxStreamState {
  contentBuffer: string;
  reasoningBuffer: string;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Strip org/prefix paths: `deepseek-ai/deepseek-v4-pro` → `deepseek-v4-pro`. */
export function normalizeModelId(model: string | undefined | null): string {
  const normalized = (model ?? "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] ?? normalized) : normalized;
}

/**
 * Models that expose a thinking/reasoning toggle and often return empty `content`
 * with payload only in `reasoning_content` when thinking is left on.
 * Detection is **model-id based** so OpenAI-compatible proxies (CPA etc.) still match.
 */
export function isDeepSeekThinkingCapableModelId(model: string | undefined | null): boolean {
  const id = normalizeModelId(model);
  if (!id) {
    return false;
  }
  return id === "deepseek-v4-pro"
    || id === "deepseek-reasoner"
    || id.includes("deepseek-v4-pro")
    || id.includes("deepseek-reasoner");
}

/** Any DeepSeek-family chat model id (thinking or not). */
export function isDeepSeekFamilyModelId(model: string | undefined | null): boolean {
  const id = normalizeModelId(model);
  if (!id) {
    return false;
  }
  return id.startsWith("deepseek") || id.includes("deepseek-");
}

function collectTextArray(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() ? [value] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (typeof item === "string") {
      return item.trim() ? [item] : [];
    }
    if (!item || typeof item !== "object") {
      return [];
    }
    if ("text" in item && typeof item.text === "string" && item.text.trim()) {
      return [item.text];
    }
    if ("reasoning" in item && typeof item.reasoning === "string" && item.reasoning.trim()) {
      return [item.reasoning];
    }
    return [];
  });
}

function extractReasoningTextFromSummary(reasoning: unknown): string[] {
  if (!reasoning || typeof reasoning !== "object") {
    return [];
  }
  if ("summary" in reasoning) {
    return collectTextArray((reasoning as { summary?: unknown }).summary);
  }
  if ("text" in reasoning && typeof reasoning.text === "string" && reasoning.text.trim()) {
    return [reasoning.text];
  }
  return [];
}

function uniqueJoinedText(parts: string[]): string {
  return Array.from(new Set(parts.map((item) => item.trim()).filter(Boolean))).join("");
}

export function isMiniMaxCompatibleProvider(
  provider: LLMProvider,
  baseURL?: string,
  model?: string,
): boolean {
  if (provider === "minimax") {
    return true;
  }
  const normalizedBaseURL = normalizeOptionalText(baseURL);
  if (normalizedBaseURL && MINIMAX_HOST_PATTERN.test(normalizedBaseURL)) {
    return true;
  }
  const normalizedModel = normalizeOptionalText(model);
  return Boolean(normalizedModel && MINIMAX_MODEL_PATTERN.test(normalizedModel));
}

/**
 * Whether this request targets a DeepSeek model that supports thinking toggle.
 * **Model id is authoritative** so CPA/OpenAI-compatible proxies that advertise
 * `provider=openai` + `model=deepseek-v4-pro` still force thinking off for structured calls.
 */
export function isDeepSeekThinkingModeProvider(
  provider: LLMProvider,
  baseURL?: string,
  model?: string,
): boolean {
  if (!isDeepSeekThinkingCapableModelId(model)) {
    return false;
  }
  // Model id already proves thinking capability; honor for native deepseek and common proxies.
  if (
    provider === "deepseek"
    || provider === "openai"
    || provider === "siliconflow"
    || provider === "custom_gateway"
  ) {
    return true;
  }
  const normalizedBaseURL = normalizeOptionalText(baseURL);
  if (normalizedBaseURL && DEEPSEEK_HOST_PATTERN.test(normalizedBaseURL)) {
    return true;
  }
  // Any non-empty OpenAI-compatible base URL serving these model ids (e.g. cpa.mangoq.ccwu.cc).
  return Boolean(normalizedBaseURL);
}

export function resolveProviderReasoningBehavior(input: {
  provider: LLMProvider;
  baseURL: string;
  model: string;
  reasoningEnabled: boolean;
}): ProviderReasoningBehavior {
  if (isDeepSeekThinkingModeProvider(input.provider, input.baseURL, input.model)) {
    return {
      reasoningEnabled: input.reasoningEnabled,
      modelKwargs: {
        thinking: {
          type: input.reasoningEnabled ? "enabled" : "disabled",
        },
        // Some OpenAI-compatible gateways only honor enable_thinking.
        enable_thinking: input.reasoningEnabled,
      },
      includeRawResponse: true,
      usesAccumulatedStreamDeltas: false,
    };
  }

  const isMiniMax = isMiniMaxCompatibleProvider(input.provider, input.baseURL, input.model);
  if (isMiniMax) {
    return {
      reasoningEnabled: input.reasoningEnabled,
      modelKwargs: {
        reasoning_split: true,
      },
      includeRawResponse: true,
      usesAccumulatedStreamDeltas: true,
    };
  }

  return {
    reasoningEnabled: input.reasoningEnabled,
    includeRawResponse: false,
    usesAccumulatedStreamDeltas: false,
  };
}

export function extractReasoningTextFromChunk(chunk: BaseMessageChunk): string {
  const additionalKwargs = (chunk.additional_kwargs ?? {}) as Record<string, unknown>;
  const directReasoning = [
    ...collectTextArray(additionalKwargs.reasoning_content),
    ...collectTextArray(additionalKwargs.reasoning_details),
    ...extractReasoningTextFromSummary(additionalKwargs.reasoning),
  ];

  const contentReasoning = Array.isArray(chunk.content)
    ? chunk.content.flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      if ("type" in item && item.type === "reasoning" && "reasoning" in item && typeof item.reasoning === "string") {
        return item.reasoning.trim() ? [item.reasoning] : [];
      }
      if ("reasoning" in item && typeof item.reasoning === "string") {
        return item.reasoning.trim() ? [item.reasoning] : [];
      }
      return [];
    })
    : [];

  return uniqueJoinedText([...directReasoning, ...contentReasoning]);
}

/**
 * Extract text for structured JSON parsing from a chat result.
 * Prefer normal content; if empty/null (common when thinking models return only
 * `reasoning_content` through CPA), fall back to reasoning fields that look like JSON.
 *
 * Important: do **not** route `null` content through JSON.stringify (would become `"null"` / `""`).
 */
export function extractMessageTextForStructuredOutput(message: {
  content?: unknown;
  additional_kwargs?: Record<string, unknown> | null;
  response_metadata?: Record<string, unknown> | null;
}): string {
  const content = message?.content;
  if (typeof content === "string" && content.trim()) {
    return content;
  }
  if (Array.isArray(content)) {
    const joined = content.map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (item && typeof item === "object" && "text" in item && typeof (item as { text?: unknown }).text === "string") {
        return (item as { text: string }).text;
      }
      return "";
    }).join("");
    if (joined.trim()) {
      return joined;
    }
  }

  const kwargs = {
    ...(message?.response_metadata ?? {}),
    ...(message?.additional_kwargs ?? {}),
  } as Record<string, unknown>;
  // Nested raw OpenAI-style message under kwargs
  const nestedMessage = kwargs.message;
  if (nestedMessage && typeof nestedMessage === "object") {
    const nested = nestedMessage as { content?: unknown; reasoning_content?: unknown };
    if (typeof nested.content === "string" && nested.content.trim()) {
      return nested.content;
    }
    if (typeof nested.reasoning_content === "string" && nested.reasoning_content.trim()) {
      const rc = nested.reasoning_content.trim();
      if (rc.includes("{") || rc.includes("[")) {
        return rc;
      }
    }
  }

  const reasoning = uniqueJoinedText([
    ...collectTextArray(kwargs.reasoning_content),
    ...collectTextArray(kwargs.reasoning_details),
    ...extractReasoningTextFromSummary(kwargs.reasoning),
  ]);
  if (reasoning && (reasoning.includes("{") || reasoning.includes("["))) {
    return reasoning;
  }
  return typeof content === "string" ? content : "";
}

export function extractMiniMaxRawStreamData(rawResponse: unknown): {
  contentBuffer?: string;
  reasoningBuffer?: string;
} {
  if (!rawResponse || typeof rawResponse !== "object") {
    return {};
  }
  const choices = (rawResponse as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return {};
  }
  const delta = choices[0] && typeof choices[0] === "object"
    ? (choices[0] as { delta?: unknown }).delta
    : undefined;
  if (!delta || typeof delta !== "object") {
    return {};
  }
  const contentBuffer = typeof (delta as { content?: unknown }).content === "string"
    ? (delta as { content: string }).content
    : undefined;
  const reasoningBuffer = uniqueJoinedText(
    collectTextArray((delta as { reasoning_details?: unknown }).reasoning_details),
  ) || undefined;
  return {
    contentBuffer,
    reasoningBuffer,
  };
}

export function diffAccumulatedText(previousBuffer: string, nextBuffer?: string): {
  nextBuffer: string;
  delta: string;
} {
  if (!nextBuffer) {
    return {
      nextBuffer: previousBuffer,
      delta: "",
    };
  }
  if (!previousBuffer) {
    return {
      nextBuffer,
      delta: nextBuffer,
    };
  }
  if (nextBuffer === previousBuffer) {
    return {
      nextBuffer,
      delta: "",
    };
  }
  if (nextBuffer.startsWith(previousBuffer)) {
    return {
      nextBuffer,
      delta: nextBuffer.slice(previousBuffer.length),
    };
  }
  if (previousBuffer.startsWith(nextBuffer)) {
    return {
      nextBuffer,
      delta: "",
    };
  }
  return {
    nextBuffer,
    delta: nextBuffer,
  };
}

export class ThinkTagStreamFilter {
  private pending = "";

  private insideThink = false;

  push(input: string): StreamFilterResult {
    this.pending += input;
    return this.consume(false);
  }

  flush(): StreamFilterResult {
    return this.consume(true);
  }

  private consume(flush: boolean): StreamFilterResult {
    let text = "";
    let reasoning = "";

    while (this.pending.length > 0) {
      if (!this.insideThink && this.pending.startsWith(THINK_CLOSE_TAG)) {
        this.pending = this.pending.slice(THINK_CLOSE_TAG.length);
        continue;
      }

      if (this.insideThink) {
        const closeIndex = this.pending.indexOf(THINK_CLOSE_TAG);
        if (closeIndex >= 0) {
          reasoning += this.pending.slice(0, closeIndex);
          this.pending = this.pending.slice(closeIndex + THINK_CLOSE_TAG.length);
          this.insideThink = false;
          continue;
        }
        const safeLength = flush ? this.pending.length : Math.max(0, this.pending.length - (THINK_CLOSE_TAG.length - 1));
        if (safeLength === 0) {
          break;
        }
        reasoning += this.pending.slice(0, safeLength);
        this.pending = this.pending.slice(safeLength);
        continue;
      }

      const openIndex = this.pending.indexOf(THINK_OPEN_TAG);
      if (openIndex >= 0) {
        text += this.pending.slice(0, openIndex);
        this.pending = this.pending.slice(openIndex + THINK_OPEN_TAG.length);
        this.insideThink = true;
        continue;
      }

      const safeLength = flush ? this.pending.length : Math.max(0, this.pending.length - (THINK_OPEN_TAG.length - 1));
      if (safeLength === 0) {
        break;
      }
      text += this.pending.slice(0, safeLength);
      this.pending = this.pending.slice(safeLength);
    }

    return {
      text,
      reasoning,
    };
  }
}
