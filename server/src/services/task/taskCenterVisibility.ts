import type { TaskStatus, UnifiedTaskSummary } from "@ai-novel/shared/types/task";

/**
 * Workflow statuses that still "own" a linked GenerationJob row in the task center.
 * When the workflow is active or just succeeded, showing both rows is noise.
 * Failed / cancelled workflows keep the pipeline row visible so the user can inspect it.
 */
const WORKFLOW_PROXY_PIPELINE_STATUSES = new Set<TaskStatus>([
  "queued",
  "running",
  "waiting_approval",
  "succeeded",
]);

export function collectWorkflowLinkedPipelineIds(tasks: UnifiedTaskSummary[]): Set<string> {
  const linked = new Set<string>();
  for (const task of tasks) {
    if (task.kind !== "novel_workflow" || !WORKFLOW_PROXY_PIPELINE_STATUSES.has(task.status)) {
      continue;
    }
    for (const resource of task.targetResources ?? []) {
      if (resource.type === "generation_job" && resource.id?.trim()) {
        linked.add(resource.id.trim());
      }
    }
  }
  return linked;
}
