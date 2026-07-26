import type { DirectorBookAutomationProjection } from "@ai-novel/shared/types/directorRuntime";
import type { UnifiedTaskDetail } from "@ai-novel/shared/types/task";
import {
  buildDisplayAutoDirectorTask,
  shouldAutofocusProjectedDirectorTask,
} from "../novelEditAutomationStatus.ts";

export interface CanonicalDirectorTaskSelectionInput {
  directorTaskId: string | null | undefined;
  requestedTask: UnifiedTaskDetail | null | undefined;
  activeTask: UnifiedTaskDetail | null | undefined;
  projection: DirectorBookAutomationProjection | null | undefined;
}

export interface CanonicalDirectorTaskSelection {
  requestedTaskId: string;
  visibleTask: UnifiedTaskDetail | null;
}

export function resolveCanonicalDirectorTask(
  input: CanonicalDirectorTaskSelectionInput,
): CanonicalDirectorTaskSelection {
  const pinnedTaskId = input.directorTaskId?.trim() || "";
  const activeTask = input.activeTask?.status === "cancelled" ? null : input.activeTask ?? null;
  const projectedTaskId = shouldAutofocusProjectedDirectorTask(input.projection)
    ? input.projection?.latestTask?.id?.trim() || ""
    : "";
  const requestedTaskId = pinnedTaskId || activeTask?.id || projectedTaskId;
  const matchingRequestedTask = input.requestedTask?.id === requestedTaskId
    ? input.requestedTask
    : null;
  const matchingActiveTask = activeTask?.id === requestedTaskId ? activeTask : null;
  const sourceTask = matchingRequestedTask ?? matchingActiveTask;

  if (!pinnedTaskId && sourceTask?.status === "cancelled") {
    return { requestedTaskId: "", visibleTask: null };
  }

  return {
    requestedTaskId,
    visibleTask: buildDisplayAutoDirectorTask(sourceTask, input.projection),
  };
}
