import { AppError } from "../../../middleware/errorHandler";
import { NovelWorkflowService } from "../workflow/NovelWorkflowService";
import { DirectorCommandService, type DirectorRunCommandRow } from "./DirectorCommandService";
import { NovelDirectorService } from "./NovelDirectorService";

export class DirectorExecutionService {
  private readonly directorService = new NovelDirectorService({ backgroundRunMode: "inline" });
  private readonly workflowService = new NovelWorkflowService();
  private readonly commandService = new DirectorCommandService(this.workflowService);

  async executeCommand(command: NonNullable<DirectorRunCommandRow>): Promise<void> {
    const payload = this.commandService.parseCommandPayload(command);
    if (command.commandType === "continue" || command.commandType === "resume_from_checkpoint" || command.commandType === "retry") {
      await this.directorService.executeContinueTask(command.taskId, {
        ...payload,
        forceResume: true,
      });
      return;
    }
    if (command.commandType === "takeover") {
      if (!payload.takeoverRequest) {
        throw new AppError("Director takeover command payload is missing.", 400);
      }
      await this.directorService.startTakeover(payload.takeoverRequest, {
        workflowTaskId: command.taskId,
      });
      return;
    }
    if (command.commandType === "repair_chapter_titles") {
      await this.directorService.executeChapterTitleRepair(command.taskId, {
        volumeId: payload.volumeId,
      });
      return;
    }
    if (command.commandType === "cancel") {
      await this.workflowService.cancelTask(command.taskId);
      return;
    }
    throw new AppError(`Unsupported director command type: ${command.commandType}`, 400);
  }
}
