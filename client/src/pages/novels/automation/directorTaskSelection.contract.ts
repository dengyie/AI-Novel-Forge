import { resolveCanonicalDirectorTask } from "./directorTaskSelection";

if (false) {
  resolveCanonicalDirectorTask({
    directorTaskId: "",
    requestedTask: null,
    activeTask: null,
    projection: null,
    // @ts-expect-error Manual workspace tasks are not director tasks or director selection inputs.
    workspaceTaskId: "manual-workspace-task",
  });
}
