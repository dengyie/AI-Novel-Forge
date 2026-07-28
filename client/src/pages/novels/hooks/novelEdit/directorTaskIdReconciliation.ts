import type { UnifiedTaskDetail } from "@ai-novel/shared/types/task";
import { shouldPreserveRequestedDirectorTaskId } from "../../novelEditAutomationStatus.ts";

export function reconcileDirectorTaskId(input: {
  novelId: string | null | undefined;
  activeTaskQuerySucceeded: boolean;
  activeTaskId: string | null | undefined;
  directorTaskId: string | null | undefined;
  requestedTask: Pick<UnifiedTaskDetail, "id" | "status"> | null | undefined;
  requestedTaskFetched: boolean;
  taskPanelOpen: boolean;
  setDirectorTaskId: (taskId: string) => void;
}): void {
  if (!input.novelId || !input.activeTaskQuerySucceeded) {
    return;
  }
  const canonicalDirectorTaskId = input.activeTaskId?.trim() || "";
  const pinnedTaskId = input.directorTaskId?.trim() || "";
  if (!canonicalDirectorTaskId && input.taskPanelOpen && pinnedTaskId) {
    return;
  }
  if (pinnedTaskId && !input.requestedTaskFetched) {
    return;
  }
  if (shouldPreserveRequestedDirectorTaskId({
    directorTaskId: pinnedTaskId,
    requestedTask: input.requestedTask,
  })) {
    return;
  }
  if (pinnedTaskId === canonicalDirectorTaskId) {
    return;
  }
  input.setDirectorTaskId(canonicalDirectorTaskId);
}
