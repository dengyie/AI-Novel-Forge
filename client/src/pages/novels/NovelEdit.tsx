import NovelEditView from "./components/NovelEditView";
import { useNovelDirectorTaskActions } from "./automation/directorTaskActions";
import { useNovelDirectorTaskController } from "./hooks/novelEdit/useNovelDirectorTaskController";
import { useNovelEditPresentationModel } from "./hooks/novelEdit/useNovelEditPresentationModel";
import { useNovelPipelineController } from "./hooks/novelEdit/useNovelPipelineController";
import { useNovelTaskDrawerController } from "./hooks/novelEdit/useNovelTaskDrawerController";
import { useNovelWorkspaceQueries } from "./hooks/novelEdit/useNovelWorkspaceQueries";

export default function NovelEdit() {
  const workspace = useNovelWorkspaceQueries();
  const director = useNovelDirectorTaskController(workspace);
  const directorActions = useNovelDirectorTaskActions(workspace, director);
  const taskDrawer = useNovelTaskDrawerController(workspace, director, directorActions);
  const pipeline = useNovelPipelineController(workspace, director, directorActions, taskDrawer);
  const viewProps = useNovelEditPresentationModel(
    workspace,
    director,
    directorActions,
    taskDrawer,
    pipeline,
  );

  return <NovelEditView {...viewProps} />;
}
