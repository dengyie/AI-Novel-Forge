import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { StoryPlanLevel } from "@ai-novel/shared/types/novel";
import { runStructuredPrompt } from "../../prompting/core/promptRunner";
import type { PromptContextBlock } from "../../prompting/core/promptTypes";
import { normalizePlannerOutput, type PlannerOutput } from "./plannerOutputNormalization";
import {
  plannerArcPlanPrompt,
  plannerBookPlanPrompt,
  plannerChapterPlanPrompt,
} from "../../prompting/prompts/planner/plannerPlan.prompts";

export interface PlannerLlmOptions {
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
}

export async function invokePlannerLLM(input: {
  options: PlannerLlmOptions;
  scopeLabel: string;
  planLevel: StoryPlanLevel;
  contextBlocks: PromptContextBlock[];
  /** For chapter soft defaults in postValidate (order-aware planRole/phase). */
  chapterOrder?: number | null;
  totalChapters?: number | null;
}): Promise<PlannerOutput> {
  const asset = input.planLevel === "book"
    ? plannerBookPlanPrompt
    : input.planLevel === "arc"
      ? plannerArcPlanPrompt
      : plannerChapterPlanPrompt;
  const result = await runStructuredPrompt({
    asset,
    promptInput: {
      scopeLabel: input.scopeLabel,
      chapterOrder: input.chapterOrder ?? null,
      totalChapters: input.totalChapters ?? null,
    },
    contextBlocks: input.contextBlocks,
    options: {
      provider: input.options.provider,
      model: input.options.model,
      temperature: input.options.temperature ?? 0.4,
    },
  });

  return normalizePlannerOutput(result.output);
}
