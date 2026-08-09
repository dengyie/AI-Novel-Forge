import type { BookContractDraft } from "@ai-novel/shared/types/novelWorkflow";
import type { DirectorConfirmRequest } from "@ai-novel/shared/types/novelDirector";
import type { StoryMacroPlan } from "@ai-novel/shared/types/storyMacro";
import { runStructuredPrompt } from "../../../../prompting/core/promptRunner";
import {
  buildDirectorBookContractContextBlocks,
  directorBookContractPrompt,
} from "../../../../prompting/prompts/novel/directorPlanning.prompts";
import { BookContractService } from "../../BookContractService";
import { StoryMacroPlanService } from "../../storyMacro/StoryMacroPlanService";
import {
  buildStoryInput,
  normalizeBookContract,
  toBookSpec,
} from "../runtime/novelDirectorHelpers";
import { runDirectorTrackedStep } from "../projections/directorProgressTracker";
import {
  DIRECTOR_PROGRESS,
} from "../projections/novelDirectorProgress";
import type { DirectorMarkTaskRunningCallback } from "./novelDirectorPhaseTypes";
import { throwIfDirectorExecutionAborted } from "../runtime/DirectorExecutionContext";

interface DirectorStoryMacroDependencies {
  storyMacroService: StoryMacroPlanService;
  bookContractService: BookContractService;
}

interface DirectorStoryMacroCallbacks {
  markDirectorTaskRunning: DirectorMarkTaskRunningCallback;
}

async function ensureDirectorConstraintEngine(
  storyMacroService: StoryMacroPlanService,
  novelId: string,
  plan: StoryMacroPlan,
  signal?: AbortSignal,
): Promise<StoryMacroPlan> {
  throwIfDirectorExecutionAborted(signal);
  if (plan.constraintEngine) {
    return plan;
  }

  try {
    const nextPlan = await storyMacroService.buildConstraintEngine(novelId);
    throwIfDirectorExecutionAborted(signal);
    return nextPlan;
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    return plan;
  }
}

async function generateDirectorBookContract(input: {
  request: DirectorConfirmRequest;
  novelId: string;
  storyMacroService: StoryMacroPlanService;
  storyMacroPlan: StoryMacroPlan | null;
  signal?: AbortSignal;
}): Promise<BookContractDraft> {
  const { request, storyMacroPlan } = input;
  const bookSpec = toBookSpec(request.candidate, request.idea, request.estimatedChapterCount);
  const storyInput = buildStoryInput(request, bookSpec);
  const requestedTemperature = request.temperature ?? 0.4;
  const temperature = Math.min(requestedTemperature, 0.4);
  const parsed = await runStructuredPrompt({
    asset: directorBookContractPrompt,
    promptInput: {
      idea: storyInput,
      context: request,
      candidate: request.candidate,
      storyMacroPlan,
      targetChapterCount: request.estimatedChapterCount ?? bookSpec.targetChapterCount,
    },
    contextBlocks: buildDirectorBookContractContextBlocks({
      idea: storyInput,
      context: request,
      candidate: request.candidate,
      storyMacroPlan,
      targetChapterCount: request.estimatedChapterCount ?? bookSpec.targetChapterCount,
    }),
    options: {
      provider: request.provider,
      model: request.model,
      temperature,
      signal: input.signal,
    },
  });
  return normalizeBookContract(parsed.output);
}

export async function runDirectorStoryMacroAssetPhase(input: {
  taskId: string;
  novelId: string;
  request: DirectorConfirmRequest;
  dependencies: Pick<DirectorStoryMacroDependencies, "storyMacroService">;
  callbacks: DirectorStoryMacroCallbacks;
}): Promise<StoryMacroPlan> {
  const { taskId, novelId, request, dependencies, callbacks } = input;
  const bookSpec = toBookSpec(request.candidate, request.idea, request.estimatedChapterCount);
  const storyInput = buildStoryInput(request, bookSpec);
  const storyMacroPlan = await runDirectorTrackedStep({
    taskId,
    stage: "story_macro",
    itemKey: "story_macro",
    itemLabel: "正在生成故事宏观规划",
    progress: DIRECTOR_PROGRESS.storyMacro,
    callbacks,
    run: async ({ signal }) => dependencies.storyMacroService.decompose(novelId, storyInput, {
      ...request,
      signal,
    }),
  });
  const hydratedStoryMacroPlan = await runDirectorTrackedStep({
    taskId,
    stage: "story_macro",
    itemKey: "constraint_engine",
    itemLabel: "正在构建约束引擎",
    progress: DIRECTOR_PROGRESS.constraintEngine,
    callbacks,
    run: async ({ signal }) => ensureDirectorConstraintEngine(
      dependencies.storyMacroService,
      novelId,
      storyMacroPlan,
      signal,
    ),
  });
  return hydratedStoryMacroPlan;
}

export async function runDirectorBookContractPhase(input: {
  taskId: string;
  novelId: string;
  request: DirectorConfirmRequest;
  storyMacroPlan?: StoryMacroPlan | null;
  dependencies: DirectorStoryMacroDependencies;
  callbacks: DirectorStoryMacroCallbacks;
}): Promise<void> {
  const { taskId, novelId, request, dependencies, callbacks } = input;
  const hydratedStoryMacroPlan = input.storyMacroPlan
    ?? await dependencies.storyMacroService.getPlan(novelId);
  const bookContractDraft = await runDirectorTrackedStep({
    taskId,
    stage: "story_macro",
    itemKey: "book_contract",
    itemLabel: "正在生成 Book Contract",
    progress: DIRECTOR_PROGRESS.bookContract,
    callbacks,
    run: async ({ signal }) => generateDirectorBookContract({
      request,
      novelId,
      storyMacroService: dependencies.storyMacroService,
      storyMacroPlan: hydratedStoryMacroPlan,
      signal,
    }),
  });
  await dependencies.bookContractService.upsert(novelId, bookContractDraft);
}

export async function runDirectorStoryMacroPhase(input: {
  taskId: string;
  novelId: string;
  request: DirectorConfirmRequest;
  dependencies: DirectorStoryMacroDependencies;
  callbacks: DirectorStoryMacroCallbacks;
}): Promise<void> {
  const storyMacroPlan = await runDirectorStoryMacroAssetPhase(input);
  await runDirectorBookContractPhase({
    ...input,
    storyMacroPlan,
  });
}
