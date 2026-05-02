import { AppError } from "../../../middleware/errorHandler";
import { NovelWorkflowService } from "../workflow/NovelWorkflowService";
import { parseSeedPayload } from "../workflow/novelWorkflow.shared";
import { DirectorCommandService, type DirectorRunCommandRow } from "./DirectorCommandService";
import { NovelDirectorService } from "./NovelDirectorService";
import {
  getDirectorInputFromSeedPayload,
  type DirectorWorkflowSeedPayload,
} from "./novelDirectorHelpers";
import type { DirectorTakeoverRequest } from "@ai-novel/shared/types/novelDirector";

export type DirectorCommandExecutionOutcome = "completed" | "cancelled";

export class DirectorExecutionService {
  private readonly directorService = new NovelDirectorService({ backgroundRunMode: "inline" });
  private readonly workflowService = new NovelWorkflowService();
  private readonly commandService = new DirectorCommandService(this.workflowService);

  async executeCommand(command: NonNullable<DirectorRunCommandRow>): Promise<DirectorCommandExecutionOutcome> {
    const payload = this.commandService.parseCommandPayload(command);
    if (command.commandType === "confirm_candidate") {
      if (!payload.confirmRequest) {
        throw new AppError("Director confirm command payload is missing.", 400);
      }
      await this.directorService.confirmCandidate({
        ...payload.confirmRequest,
        workflowTaskId: command.taskId,
      });
      return this.resolveCommandOutcome(command.taskId);
    }
    if (command.commandType === "continue" || command.commandType === "resume_from_checkpoint" || command.commandType === "retry") {
      const takeoverRequest = await this.resolveContextlessTakeoverRecovery(command.taskId);
      if (takeoverRequest) {
        await this.directorService.startTakeover(takeoverRequest, {
          workflowTaskId: command.taskId,
        });
        return this.resolveCommandOutcome(command.taskId);
      }
      await this.directorService.executeContinueTask(command.taskId, {
        ...payload,
        forceResume: true,
      });
      return this.resolveCommandOutcome(command.taskId);
    }
    if (command.commandType === "takeover") {
      if (!payload.takeoverRequest) {
        throw new AppError("Director takeover command payload is missing.", 400);
      }
      await this.directorService.startTakeover(payload.takeoverRequest, {
        workflowTaskId: command.taskId,
      });
      return this.resolveCommandOutcome(command.taskId);
    }
    if (command.commandType === "repair_chapter_titles") {
      await this.directorService.executeChapterTitleRepair(command.taskId, {
        volumeId: payload.volumeId,
      });
      return this.resolveCommandOutcome(command.taskId);
    }
    if (command.commandType === "cancel") {
      await this.workflowService.cancelTask(command.taskId);
      return "cancelled";
    }
    throw new AppError(`Unsupported director command type: ${command.commandType}`, 400);
  }

  private async resolveCommandOutcome(taskId: string): Promise<DirectorCommandExecutionOutcome> {
    const row = await this.workflowService.getTaskByIdWithoutHealing(taskId).catch(() => null);
    return row?.status === "cancelled" || row?.cancelRequestedAt ? "cancelled" : "completed";
  }

  private async resolveContextlessTakeoverRecovery(taskId: string): Promise<DirectorTakeoverRequest | null> {
    const row = await this.workflowService.getTaskByIdWithoutHealing(taskId);
    const seedPayload = parseSeedPayload<DirectorWorkflowSeedPayload>(row?.seedPayloadJson) ?? {};
    if (getDirectorInputFromSeedPayload(seedPayload)) {
      return null;
    }
    return this.commandService.getLatestTakeoverRequestForTask(taskId);
  }
}
