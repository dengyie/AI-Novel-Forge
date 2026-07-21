import type { PromptInvocationMeta } from "../../prompting/core/promptTypes";
import type { LlmLivePhase } from "@ai-novel/shared/types/llmLive";
import { llmLiveBroker, type LlmLiveSession } from "./LlmLiveBroker";

export function isLlmLiveEnabled(): boolean {
  const raw = String(process.env.LLM_LIVE_ENABLED ?? "1").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

const NULL_SESSION: LlmLiveSession = {
  interactionId: "",
  delta(_content: string): void {},
  phase(_phase: LlmLivePhase, _message: string): void {},
  complete(): void {},
  fail(_error: unknown): void {},
} as LlmLiveSession;

export function beginLlmLiveSession(input: {
  label: string;
  mode: "text" | "structured";
  promptMeta?: PromptInvocationMeta;
  provider?: string | null;
  model?: string | null;
}): LlmLiveSession {
  if (!isLlmLiveEnabled()) {
    return NULL_SESSION;
  }
  try {
    const meta = input.promptMeta;
    return llmLiveBroker.begin({
      label: input.label,
      mode: input.mode,
      promptId: meta?.promptId ?? null,
      promptVersion: meta?.promptVersion ?? null,
      taskId: meta?.taskId ?? null,
      novelId: meta?.novelId ?? null,
      chapterId: meta?.chapterId ?? null,
      volumeId: meta?.volumeId ?? null,
      stage: meta?.stage ?? null,
      itemKey: meta?.itemKey ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
    });
  } catch (error) {
    console.warn("[llm-live] begin failed", error instanceof Error ? error.message : error);
    return NULL_SESSION;
  }
}

export function safeLiveCall(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    console.warn("[llm-live] side-path error", error instanceof Error ? error.message : error);
  }
}
