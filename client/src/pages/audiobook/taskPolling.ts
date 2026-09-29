import type { AudiobookTaskSummary } from "@ai-novel/shared/types/audiobook";

/** WAV completion does not end the independently owned M4B delivery work. */
export function resolveAudiobookTaskPollInterval(
  tasks: ReadonlyArray<Pick<AudiobookTaskSummary, "status" | "m4bStatus">>,
): 4000 | false {
  return tasks.some((task) => task.status === "queued" || task.status === "running"
    || (task.status === "succeeded" && task.m4bStatus === "encoding")) ? 4000 : false;
}
